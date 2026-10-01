import { Editor, MarkdownView } from "obsidian";

import type { ParagraphRange } from "./lib/paragraph";
import { readElement, readFunction, readProperty, safely } from "./lib/runtime-probe";

/**
 * Swipe feedback: a glowing band laid over the paragraph that the current
 * rightward swipe is about to move.
 *
 * The band is a plain fixed-position div in the document body, not a
 * CodeMirror decoration: it needs no editor internals beyond `coordsAtPos`
 * and the scroll container (both probed structurally, exactly like in
 * editor-position.ts), it can never interfere with the document, and the
 * gesture keeps it up to date by writing a single CSS custom property.
 *
 * `--paragraph-swipe-progress` (0..1 — the swipe's share of the threshold)
 * drives the opacity, the glow radius and the edge brightness in styles.css,
 * so the effect builds up together with the finger instead of blinking on.
 */

/** A viewport rectangle in CSS pixels. */
export interface GlowBounds {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

/** Class of the overlay element; all of its visuals live in styles.css. */
const GLOW_CLASS = "paragraph-swipe-glow";

/** Added while the glow is fading out; see FADE_OUT_MS. */
const FADE_OUT_CLASS = "paragraph-swipe-glow--out";

/** How long the fade-out takes; the element is removed right after it. */
const FADE_OUT_MS = 240;

/** Custom property through which the swipe drives the glow. */
const PROGRESS_PROPERTY = "--paragraph-swipe-progress";

/** Progress deltas below this are finger jitter, not movement. */
const PROGRESS_EPSILON = 0.01;

/** The part of a measured line box that the band cares about. */
interface LineBounds {
    readonly top: number;
    readonly bottom: number;
}

/** The horizontal span of the editor's text column. */
interface ColumnBounds {
    readonly left: number;
    readonly right: number;
}

function clampProgress(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/** Validates an unknown value as the vertical bounds of a rendered line. */
function asLineBounds(value: unknown): LineBounds | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const top = record["top"];
    const bottom = record["bottom"];
    if (typeof top !== "number" || !Number.isFinite(top)) {
        return null;
    }
    if (typeof bottom !== "number" || !Number.isFinite(bottom)) {
        return null;
    }
    return { top, bottom };
}

/** Measures a document position in viewport coordinates. */
function lineBoundsAtPos(editor: Editor, pos: { line: number; ch: number }): LineBounds | null {
    const coordsAtPos = readFunction(editor, "coordsAtPos");
    if (coordsAtPos === null) {
        return null;
    }
    return safely(() => asLineBounds(coordsAtPos.call(editor, pos)));
}

/** The underlying CodeMirror view, if the editor wrapper exposes one. */
function codeMirrorView(editor: Editor): object | null {
    const cm = readProperty(editor, "cm");
    return typeof cm === "object" && cm !== null ? cm : null;
}

function horizontalPadding(element: HTMLElement): ColumnBounds {
    const style = window.getComputedStyle(element);
    const left = Number.parseFloat(style.paddingLeft);
    const right = Number.parseFloat(style.paddingRight);
    return {
        left: Number.isFinite(left) ? left : 0,
        right: Number.isFinite(right) ? right : 0,
    };
}

/**
 * The text column of the view: the content box of the editor's scroll
 * container, falling back to the view content. Every candidate is probed
 * because none of these members are in the published Editor typings.
 */
function textColumn(view: MarkdownView): ColumnBounds | null {
    const editor = view.editor;
    const cm = codeMirrorView(editor);
    const candidates: readonly (HTMLElement | null)[] = [
        readElement(editor, "scrollEl"),
        readElement(editor, "containerEl"),
        cm === null ? null : readElement(cm, "scroller"),
        cm === null ? null : readElement(cm, "contentEl"),
        view.contentEl,
    ];
    for (const element of candidates) {
        if (element === null) {
            continue;
        }
        const rect = element.getBoundingClientRect();
        if (!Number.isFinite(rect.left) || !Number.isFinite(rect.right) || rect.width <= 0) {
            continue;
        }
        const padding = horizontalPadding(element);
        const left = rect.left + padding.left;
        const right = rect.right - padding.right;
        if (right > left) {
            return { left, right };
        }
    }
    return null;
}

/**
 * Measures the viewport rectangle covered by a paragraph, or null when it
 * cannot be measured (the caller then simply skips the effect). The band is
 * clamped to the viewport, so a paragraph taller than the screen still
 * highlights the visible part of it.
 */
export function paragraphGlowBounds(view: MarkdownView, range: ParagraphRange): GlowBounds | null {
    const editor = view.editor;
    const first = lineBoundsAtPos(editor, { line: range.start, ch: 0 });
    if (first === null) {
        return null;
    }
    const lastLine = Math.min(range.end - 1, Math.max(editor.lineCount() - 1, 0));
    const lastText = editor.getLine(lastLine) ?? "";
    // The last character's box ends exactly at the bottom of its visual row;
    // asking for `ch: length` would land on the next row of wrapped text.
    const last = lineBoundsAtPos(editor, { line: lastLine, ch: Math.max(lastText.length - 1, 0) });
    if (last === null) {
        return null;
    }
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const top = Math.max(first.top, 0);
    const bottom = Math.min(last.bottom, viewportHeight);
    if (bottom <= top) {
        return null;
    }
    const column = textColumn(view);
    const left = column === null ? 0 : Math.max(column.left, 0);
    const right = column === null ? viewportWidth : Math.min(column.right, viewportWidth);
    if (right <= left) {
        return null;
    }
    return { top, bottom, left, right };
}

/**
 * The glowing band over the paragraph being swiped away. Create it with
 * `attach`, dispose of it with `hide`.
 */
export class SwipeGlow {
    private element: HTMLElement | null;
    private lastProgress = -1;

    private constructor(element: HTMLElement) {
        this.element = element;
    }

    /** Lays a glow over `range`, or returns null if the paragraph is unmeasurable. */
    public static attach(view: MarkdownView, range: ParagraphRange): SwipeGlow | null {
        const bounds = paragraphGlowBounds(view, range);
        if (bounds === null) {
            return null;
        }
        const element = document.createElement("div");
        element.className = GLOW_CLASS;
        element.style.top = `${Math.round(bounds.top)}px`;
        element.style.height = `${Math.round(bounds.bottom - bounds.top)}px`;
        element.style.left = `${Math.round(bounds.left)}px`;
        element.style.width = `${Math.round(bounds.right - bounds.left)}px`;
        document.body.appendChild(element);
        return new SwipeGlow(element);
    }

    /**
     * Scales the glow: 0 is the moment the finger starts moving, 1 is the
     * swipe threshold — the point at which the paragraph is actually moved.
     */
    public setProgress(progress: number): void {
        const element = this.element;
        if (element === null) {
            return;
        }
        const clamped = clampProgress(progress);
        if (Math.abs(clamped - this.lastProgress) < PROGRESS_EPSILON) {
            return;
        }
        this.lastProgress = clamped;
        element.style.setProperty(PROGRESS_PROPERTY, clamped.toFixed(3));
    }

    /**
     * Takes the glow off the screen at once. Use it whenever the viewport is
     * about to move: a band left over a scrolling paragraph would point at the
     * wrong text.
     */
    public hide(): void {
        const element = this.element;
        if (element === null) {
            return;
        }
        this.element = null;
        element.remove();
    }

    /**
     * Lets the glow die out on its own instead of blinking away. Only safe
     * while the viewport stays where it is — i.e. at the end of a swipe that
     * was claimed and therefore blocks scrolling.
     */
    public fadeOut(): void {
        const element = this.element;
        if (element === null) {
            return;
        }
        this.element = null;
        element.classList.add(FADE_OUT_CLASS);
        window.setTimeout(() => {
            element.remove();
        }, FADE_OUT_MS);
    }
}
