import { MarkdownView } from "obsidian";

import { posAtClientPoint } from "./editor-position";
import type { ParagraphRange } from "./lib/paragraph";
import { readElement, readNumber, readProperty } from "./lib/runtime-probe";

/**
 * Swipe feedback: the paragraph under the finger looks cut out of the note
 * and travels to the right together with the finger.
 *
 * The real `.cm-line` elements are translated, so the text keeps its fonts,
 * its syntax colours and its exact width — and what it leaves behind is a real
 * gap in the document, which is what makes the effect read as "cut out" rather
 * than "a copy slid away".
 *
 * Two fixed-position overlays in the document body ride above it: a dashed
 * outline of the slot the paragraph came from, and a glowing plate that
 * follows the block. Nothing else in the document is modified — the movement is
 * a custom property, the horizontal scroll the translate would otherwise cause
 * is suppressed for the duration of the gesture, and everything is undone by
 * `release`, `detach` or `drop`.
 *
 * Because the lines are physically displaced while the swipe runs, the caller
 * must keep the paragraph it resolved at the start: asking the editor what is
 * under the start coordinates afterwards would hit a different line.
 *
 * Nothing here may throw: a failure in the feedback must not cost the gesture
 * its claim, or the app's own edge gestures would take over instead.
 */

/** Class of the editor root while a paragraph is being carried away. */
const ACTIVE_CLASS = "paragraph-swipe-active";

/**
 * Class put on the scroll container for the duration of the cut: it stops the
 * sideways scrollbar the translated lines would otherwise create there.
 */
const CARRIER_CLASS = "paragraph-swipe-carrier";

/** Added to the `.cm-line`s of the swiped paragraph. */
const LINE_CLASS = "paragraph-swipe-line";

/** Dashed outline of the slot the paragraph was cut from. */
const SLOT_CLASS = "paragraph-swipe-slot";

/** Glowing plate that follows the block. */
const PLATE_CLASS = "paragraph-swipe-plate";

/** Plate states: the swipe was abandoned / the block left for good. */
const PLATE_OUT_CLASS = "paragraph-swipe-plate--out";
const PLATE_DETACHED_CLASS = "paragraph-swipe-plate--detached";

/** Written on every movement, on the editor root and on the plate. */
const SHIFT_PROPERTY = "--paragraph-swipe-shift";
const PROGRESS_PROPERTY = "--paragraph-swipe-progress";

/** How long the plate takes to slide back / fly off, in ms. */
const RELEASE_MS = 180;
const DETACH_MS = 220;

/** Distance from a box edge at which a line is probed for its document position. */
const PROBE_INSET_PX = 2;

/** A rectangle in viewport coordinates, in CSS pixels. */
interface SwipeRect {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

/** Why a paragraph could not be turned into a travelling block. */
type LocateFailure = "no-lines" | "no-position" | "not-rendered" | "no-box" | "off-screen";

/** The result of trying to cut a paragraph out: the effect, or the reason. */
export type CutResult = { readonly cut: SwipeCut; readonly reason: null } | { readonly cut: null; readonly reason: LocateFailure };

function clampProgress(value: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }
    return Math.min(1, Math.max(0, value));
}

/** The editor's own root element; carries the state of the running cut. */
function editorRoot(view: MarkdownView): HTMLElement {
    const cm = readProperty(view.editor, "cm");
    if (typeof cm === "object" && cm !== null) {
        const dom = readElement(cm, "dom");
        if (dom !== null) {
            return dom;
        }
    }
    const content = view.contentEl.querySelector(".cm-content");
    return content instanceof HTMLElement ? content : view.contentEl;
}

/** The rendered `.cm-line` elements of the editor, in document order. */
function renderedLines(view: MarkdownView): readonly HTMLElement[] | null {
    const container = view.contentEl.querySelector(".cm-content");
    if (!(container instanceof HTMLElement)) {
        return null;
    }
    const lines = Array.from(container.querySelectorAll<HTMLElement>(".cm-line"));
    return lines.length > 0 ? lines : null;
}

/**
 * The document line number of the editor's first *rendered* line: everything
 * before it is virtualised away, so the rendered lines are document lines
 * `firstRenderedLine .. firstRenderedLine + lines.length - 1`.
 */
function firstRenderedLine(view: MarkdownView, lines: readonly HTMLElement[]): number | null {
    const fromViewport = readNumber(view.editor, "getFirstVisibleLine");
    if (fromViewport !== null) {
        return fromViewport;
    }
    // Without it, resolve the first rendered element through the same
    // multi-strategy resolver the picker uses.
    const first = lines[0];
    if (first === undefined) {
        return null;
    }
    const rect = first.getBoundingClientRect();
    if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || rect.bottom <= rect.top) {
        return null;
    }
    // Probed inside the element, on the side of it that is guaranteed to be on
    // screen: the first rendered line is usually clipped by the top edge.
    const y = rect.top < 0 ? rect.bottom - PROBE_INSET_PX : rect.top + PROBE_INSET_PX;
    return posAtClientPoint(view.editor, rect.left + PROBE_INSET_PX, y)?.position.line ?? null;
}

/**
 * The rendered lines of a paragraph, or the reason they cannot be found.
 *
 * One CodeMirror document line is exactly one `.cm-line` element (text that
 * wraps lives inside its own element), so the rendered lines are in document
 * order and the paragraph is a slice of them — no position-to-element mapping
 * needed. Only the paragraph's first line has to be located, through the same
 * `posAtCoords` the picker uses; everything else is counting. Lines the
 * virtualised viewport does not render end the block: what is off screen
 * cannot be seen moving anyway.
 */
function paragraphLines(view: MarkdownView, range: ParagraphRange): readonly HTMLElement[] | LocateFailure {
    const lines = renderedLines(view);
    if (lines === null) {
        return "no-lines";
    }
    const firstRendered = firstRenderedLine(view, lines);
    if (firstRendered === null) {
        return "no-position";
    }
    const from = range.start - firstRendered;
    if (from < 0 || from >= lines.length) {
        return "not-rendered";
    }
    return lines.slice(from, Math.min(from + (range.end - range.start), lines.length));
}

/**
 * The box around every given element, clamped to the viewport: a paragraph
 * taller than the screen contributes only the part that can be seen.
 */
function unionRect(elements: readonly HTMLElement[]): SwipeRect | null {
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    for (const element of elements) {
        const rect = element.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) {
            return null;
        }
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
        left = Math.min(left, rect.left);
        right = Math.max(right, rect.right);
    }
    const visibleTop = Math.max(top, 0);
    const visibleBottom = Math.min(bottom, window.innerHeight);
    if (visibleBottom <= visibleTop || right <= left) {
        return null;
    }
    return { top: visibleTop, bottom: visibleBottom, left, right };
}

/** Appends a fixed-position box to the document body. */
function appendOverlay(cls: string, rect: SwipeRect): HTMLElement {
    const element = document.createElement("div");
    element.className = cls;
    element.style.top = `${Math.round(rect.top)}px`;
    element.style.left = `${Math.round(rect.left)}px`;
    element.style.width = `${Math.round(rect.right - rect.left)}px`;
    element.style.height = `${Math.round(rect.bottom - rect.top)}px`;
    document.body.appendChild(element);
    return element;
}

/**
 * A paragraph cut out of its note and carried to the right by the finger.
 * Create it with `attach`, finish it with `release`, `detach` or `drop`.
 */
export class SwipeCut {
    private readonly lines: readonly HTMLElement[];
    private readonly root: HTMLElement;
    private readonly scroller: HTMLElement | null;
    private readonly slot: HTMLElement;
    private readonly plate: HTMLElement;
    private lastProgress = -1;
    private finished = false;

    private constructor(
        lines: readonly HTMLElement[],
        root: HTMLElement,
        scroller: HTMLElement | null,
        slot: HTMLElement,
        plate: HTMLElement,
    ) {
        this.lines = lines;
        this.root = root;
        this.scroller = scroller;
        this.slot = slot;
        this.plate = plate;
    }

    /**
     * Cuts `range` out of `view`. Returns the effect, or the reason there is
     * none — the caller logs it, because on a phone there is no other way to
     * see why the effect did not come up.
     */
    public static attach(view: MarkdownView, range: ParagraphRange): CutResult {
        const located = paragraphLines(view, range);
        if (typeof located === "string") {
            return { cut: null, reason: located };
        }
        const rect = unionRect(located);
        if (rect === null) {
            return { cut: null, reason: "no-box" };
        }
        const root = editorRoot(view);
        // Translating the lines would otherwise make the scroller scrollable
        // sideways (it is `overflow-x: auto`); the block is meant to leave the
        // note, not the note's scroll box. The scroller wraps the editor root
        // in CodeMirror, so it is found downwards, not upwards.
        const scroller = view.contentEl.querySelector<HTMLElement>(".cm-scroller");
        scroller?.classList.add(CARRIER_CLASS);
        const slot = appendOverlay(SLOT_CLASS, rect);
        const plate = appendOverlay(PLATE_CLASS, rect);
        for (const line of located) {
            line.classList.add(LINE_CLASS);
        }
        root.classList.add(ACTIVE_CLASS);
        return { cut: new SwipeCut(located, root, scroller, slot, plate), reason: null };
    }

    /** Moves the block to follow the finger. Horizontal travel, in pixels. */
    public setShift(deltaX: number): void {
        if (this.finished) {
            return;
        }
        const shift = Number.isFinite(deltaX) ? `${deltaX.toFixed(1)}px` : "0px";
        this.root.style.setProperty(SHIFT_PROPERTY, shift);
        this.plate.style.setProperty(SHIFT_PROPERTY, shift);
    }

    /**
     * Scales the effect: 0 is the first pixel of the swipe, 1 the threshold —
     * the point at which the paragraph really moves.
     */
    public setProgress(progress: number): void {
        if (this.finished) {
            return;
        }
        const clamped = clampProgress(progress);
        if (Math.abs(clamped - this.lastProgress) < 0.01) {
            return;
        }
        this.lastProgress = clamped;
        const value = clamped.toFixed(3);
        this.root.style.setProperty(PROGRESS_PROPERTY, value);
        this.plate.style.setProperty(PROGRESS_PROPERTY, value);
    }

    /** The swipe was abandoned: the block slides back into its slot. */
    public release(): void {
        if (this.finished) {
            return;
        }
        this.plate.classList.add(PLATE_OUT_CLASS);
        this.scheduleCleanup(RELEASE_MS);
    }

    /** The block was accepted: it flies off to the right and leaves. */
    public detach(): void {
        if (this.finished) {
            return;
        }
        this.plate.classList.add(PLATE_DETACHED_CLASS);
        this.scheduleCleanup(DETACH_MS);
    }

    /** Removes the effect at once, for when the text is about to move. */
    public drop(): void {
        if (this.finished) {
            return;
        }
        this.cleanup();
    }

    private scheduleCleanup(delayMs: number): void {
        this.finished = true;
        window.setTimeout(() => {
            this.cleanup();
        }, delayMs);
    }

    private cleanup(): void {
        this.finished = true;
        for (const line of this.lines) {
            line.classList.remove(LINE_CLASS);
        }
        this.root.classList.remove(ACTIVE_CLASS);
        this.root.style.removeProperty(SHIFT_PROPERTY);
        this.root.style.removeProperty(PROGRESS_PROPERTY);
        this.scroller?.classList.remove(CARRIER_CLASS);
        this.slot.remove();
        this.plate.remove();
    }
}
