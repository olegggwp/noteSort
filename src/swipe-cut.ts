import { MarkdownView } from "obsidian";

import type { ParagraphRange } from "./lib/paragraph";
import { readElement, readProperty, safely } from "./lib/runtime-probe";

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

/** A rectangle in viewport coordinates, in CSS pixels. */
interface SwipeRect {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
}

/** Why a paragraph could not be turned into a travelling block. */
type LocateFailure = "no-lines" | "no-line-under-finger" | "no-box";

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

/**
 * The index, in the rendered lines, of the line the finger is on — or -1 when
 * the finger is not over rendered text (a gap between lines, a widget, the
 * gutter).
 */
function lineIndexAtPoint(lines: readonly HTMLElement[], x: number, y: number): number {
    const element = safely(() => document.elementFromPoint(x, y));
    const line = element instanceof Element ? element.closest(".cm-line") : null;
    if (!(line instanceof HTMLElement)) {
        return -1;
    }
    const index = lines.indexOf(line);
    return index < 0 ? -1 : index;
}

/**
 * The rendered lines of a paragraph, or the reason they cannot be found.
 *
 * One CodeMirror document line is exactly one `.cm-line` element (text that
 * wraps lives inside its own element), and the rendered ones are in document
 * order, so the paragraph is a slice of them — the only thing that has to be
 * found is where that slice starts.
 *
 * The finger is already on the paragraph, and its document line is known, so
 * the slice is counted backwards from the line under the finger. Counting is
 * what makes this work deep inside a long note: CodeMirror only renders the
 * neighbourhood of the viewport there, and everything before it simply is not in
 * the DOM, which no arithmetic about the first rendered line can account for.
 * A paragraph reaching outside the rendered part is cut down to the part that
 * is really there — off screen nobody could see it move anyway.
 */
function paragraphLines(
    view: MarkdownView,
    range: ParagraphRange,
    fingerLine: number,
    probeX: number,
    probeY: number,
): readonly HTMLElement[] | LocateFailure {
    const container = view.contentEl.querySelector(".cm-content");
    if (!(container instanceof HTMLElement)) {
        return "no-lines";
    }
    const lines = Array.from(container.querySelectorAll<HTMLElement>(".cm-line"));
    if (lines.length === 0) {
        return "no-lines";
    }
    const fingerIndex = lineIndexAtPoint(lines, probeX, probeY);
    if (fingerIndex < 0) {
        return "no-line-under-finger";
    }
    const count = range.end - range.start;
    const from = Math.max(0, fingerIndex - (fingerLine - range.start));
    return lines.slice(from, Math.min(from + count, lines.length));
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
    public static attach(
        view: MarkdownView,
        range: ParagraphRange,
        fingerLine: number,
        probeX: number,
        probeY: number,
    ): CutResult {
        const located = paragraphLines(view, range, fingerLine, probeX, probeY);
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
