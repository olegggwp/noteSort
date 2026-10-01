import { MarkdownView, Notice, Plugin, TFile } from "obsidian";

import { describePositionStrategies, isEditorEditable, posAtClientPoint } from "./editor-position";
import { decideGesture, decisionDistancePx, isCRAZYIntent, isRightwardSwipe, swipeProgress, touchById } from "./lib/gesture";
import {
    appendParagraphToText,
    extractParagraphLines,
    getDeletionRange,
    getParagraphRange,
    joinLines,
    normalizeLineEndings,
    splitLines,
    toCharRange,
} from "./lib/paragraph";
import type { ParagraphRange } from "./lib/paragraph";
import { NotePickerModal } from "./note-picker-modal";
import { clampSwipeThreshold, DEFAULT_SETTINGS, ParagraphSwipeSettingTab } from "./settings";
import type { ParagraphSwipeSettings } from "./settings";
import { SwipeCut } from "./swipe-cut";

/** A short description of an event target, for the debug log. */
function describeElement(element: Element): string {
    const id = element.id === "" ? "" : `#${element.id}`;
    const classes = element.className === "" ? "" : `.${String(element.className).trim().split(/\s+/).join(".")}`;
    return `${element.tagName.toLowerCase()}${id}${classes}`.slice(0, 60);
}

/** A paragraph found under a viewport point, and how it was found. */
interface ResolvedParagraph {
    readonly range: ParagraphRange;
    /** The document line under the finger, i.e. where inside the paragraph it is. */
    readonly line: number;
    readonly strategy: string;
}

/** Outcome of resolving the paragraph under a viewport point. */
type ParagraphLookup =
    | ({ readonly kind: "paragraph" } & ResolvedParagraph)
    | { readonly kind: "unresolved"; readonly detail: string }
    | { readonly kind: "blank"; readonly line: number; readonly strategy: string };

interface TouchGesture {
    readonly touchId: number;
    readonly startX: number;
    readonly startY: number;
    readonly view: MarkdownView;
    /** State of the left sidebar when the touch started. */
    readonly leftDrawerOpenAtStart: boolean;
    /** The gesture was claimed: all further events are hidden from the app. */
    claimed: boolean;
    /** The gesture was released back to the app (a scroll, a leftward drag). */
    released: boolean;
    /** The picker has been opened for this gesture. */
    consumed: boolean;
    /** Touchmove events received after the claim (diagnostics). */
    claimedMoves: number;
    /** Horizontal delta at the last received touchmove (diagnostics). */
    lastDeltaX: number;
    /**
     * The paragraph resolved when the cut effect started. Mandatory once the
     * effect runs: the lines are physically displaced by then, so asking the
     * editor what sits under the start coordinates would hit a different line.
     */
    paragraph: ResolvedParagraph | null;
    /** Set when the feedback failed: it must never hold the gesture up again. */
    effectBroken: boolean;
}

/**
 * Swipe right over a paragraph in the editor to open a compact note picker;
 * the picked note receives the paragraph at its end (separated by one blank
 * line) and the paragraph is removed from the source note.
 *
 * Touches are observed on `window` in the capture phase — the earliest point
 * in the DOM. Any gesture that starts over an editable source-mode editor and
 * becomes horizontal-dominant is claimed: its remaining events are swallowed
 * (preventDefault + stopImmediatePropagation), which keeps Obsidian mobile's
 * built-in swipe-to-open-left-sidebar gesture from ever firing, wherever the
 * swipe started. Because some WebView builds stop delivering touchmove events
 * after a claimed gesture, the threshold is re-checked on touchend. Vertical
 * scrolls, leftward drags, and gestures with a second finger before the claim
 * are never blocked; an already claimed gesture survives stray extra touches.
 *
 * While the finger travels right, the paragraph it started on is cut out of
 * the note and carried along with the finger (see `SwipeCut`): its real lines
 * move, a dashed slot is left behind, and a glowing plate whose brightness
 * grows with the travelled distance rides along, so the threshold is visible
 * before the picker takes over.
 */
export default class ParagraphSwipePlugin extends Plugin {
    public settings: ParagraphSwipeSettings = { ...DEFAULT_SETTINGS };

    private gesture: TouchGesture | null = null;

    /** The paragraph being carried away by the swipe in progress, if any. */
    private cut: SwipeCut | null = null;

    public async onload(): Promise<void> {
        await this.loadSettings();
        this.debugLog(`loaded (threshold ${this.settings.swipeThresholdPx} px)`);
        this.addSettingTab(new ParagraphSwipeSettingTab(this.app, this));

        this.registerDomEvent(
            window,
            "touchstart",
            (event: TouchEvent) => {
                this.onTouchStart(event);
            },
            { capture: true, passive: true },
        );
        // passive: false is required — without it the browser treats the
        // listener as passive and preventDefault() inside it is ignored.
        this.registerDomEvent(
            window,
            "touchmove",
            (event: TouchEvent) => {
                this.onTouchMove(event);
            },
            { capture: true, passive: false },
        );
        this.registerDomEvent(
            window,
            "touchend",
            (event: TouchEvent) => {
                this.onTouchEnd(event);
            },
            { capture: true, passive: true },
        );
        this.registerDomEvent(
            window,
            "touchcancel",
            (event: TouchEvent) => {
                this.onTouchCancel(event);
            },
            { capture: true, passive: true },
        );
        // Safety net for the cut effect: a claimed swipe blocks scrolling, so
        // any scroll seen while a block is travelling means the viewport moved
        // underneath it (the picker opening, the layout resizing) and the
        // displaced lines have to snap back at once.
        // Capture is what makes the non-bubbling scroll of any element in the
        // document reach the window listener.
        this.registerDomEvent(
            window,
            "scroll",
            () => {
                this.dropCut();
            },
            { capture: true, passive: true },
        );
        // Second channel for the effect's progress. Some WebView builds stop
        // delivering touchmove once the gesture is claimed (which is why the
        // threshold is re-checked on touchend); pointer events are generated
        // from the same input pipeline independently, so the block keeps
        // travelling with the finger there. Passive: we only read coordinates.
        this.registerDomEvent(
            window,
            "pointermove",
            (event: PointerEvent) => {
                this.onPointerMove(event);
            },
            { capture: true, passive: true },
        );
    }

    public onunload(): void {
        this.gesture = null;
        this.dropCut();
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private async loadSettings(): Promise<void> {
        const stored: unknown = await this.loadData();
        this.settings = { ...DEFAULT_SETTINGS };
        if (typeof stored !== "object" || stored === null) {
            return;
        }
        const record = stored as Record<string, unknown>;
        const threshold = record["swipeThresholdPx"];
        if (typeof threshold === "number" && Number.isFinite(threshold)) {
            this.settings.swipeThresholdPx = clampSwipeThreshold(threshold);
        }
        if (typeof record["debugMode"] === "boolean") {
            this.settings.debugMode = record["debugMode"];
        }
    }

    /** Logs to the console always; additionally toasts when debug mode is on. */
    private debugLog(message: string): void {
        console.log(`Paragraph Swipe: ${message}`);
        if (this.settings.debugMode) {
            new Notice(`Paragraph Swipe: ${message}`, 8000);
        }
    }

    private isEditableSourceView(view: MarkdownView): boolean {
        return view.getMode() === "source" && isEditorEditable(view.editor);
    }

    /**
     * Finds the editable source-mode MarkdownView that contains the touched
     * element. The active view is checked first; the loop over all markdown
     * leaves covers swipes in unfocused split panes.
     */
    private findSourceMarkdownView(target: Element): MarkdownView | null {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active !== null && this.isEditableSourceView(active) && active.contentEl.contains(target)) {
            return active;
        }
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (view instanceof MarkdownView && this.isEditableSourceView(view) && view.contentEl.contains(target)) {
                return view;
            }
        }
        return null;
    }

    private onTouchStart(event: TouchEvent): void {
        const activeGesture = this.gesture;
        if (activeGesture !== null && activeGesture.claimed && event.touches.length > 1) {
            return; // a stray second finger must not kill an active claimed swipe
        }
        this.gesture = null;
        this.dropCut();
        const touch = event.touches[0];
        if (event.touches.length !== 1 || touch === undefined) {
            this.debugLog(`touchstart ignored: ${event.touches.length} finger(s)`);
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            this.debugLog("touchstart ignored: the target is not an element");
            return;
        }
        const selection = window.getSelection();
        if (selection !== null && !selection.isCollapsed) {
            this.debugLog("touchstart ignored: there is a text selection");
            return; // an active text selection: leave handle dragging to the app
        }
        const view = this.findSourceMarkdownView(target);
        if (view === null) {
            this.debugLog(`touchstart ignored: no editable source view under ${describeElement(target)}`);
            return;
        }
        this.debugLog(`touchstart at (${Math.round(touch.clientX)}, ${Math.round(touch.clientY)}) on ${describeElement(target)}`);
        this.gesture = {
            touchId: touch.identifier,
            startX: touch.clientX,
            startY: touch.clientY,
            view,
            leftDrawerOpenAtStart: this.isLeftDrawerOpen(),
            claimed: false,
            released: false,
            consumed: false,
            claimedMoves: 0,
            lastDeltaX: 0,
            paragraph: null,
            effectBroken: false,
        };
        // touchstart is never swallowed: taps must keep placing the caret.
    }

    private onTouchMove(event: TouchEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released) {
            this.debugLog("touchmove ignored: no live gesture");
            return;
        }
        const touch = touchById(event.changedTouches, gesture.touchId);
        if (gesture.claimedMoves === 0) {
            const first = touch === null ? null : touchById(event.changedTouches, gesture.touchId);
            this.debugLog(
                first === null
                    ? "first touchmove: the finger is not in changedTouches"
                    : `first touchmove: dx ${Math.round(first.clientX - gesture.startX)} px, dy ${Math.round(first.clientY - gesture.startY)} px`,
            );
        }
        if (touch === null) {
            return;
        }
        const threshold = this.settings.swipeThresholdPx;

        if (gesture.claimed) {
            // Keep swallowing regardless of the number of active touches: a
            // claimed gesture must run to completion even if a palm touch lands.
            this.swallowTouch(event);
            gesture.claimedMoves += 1;
            const deltaX = touch.clientX - gesture.startX;
            gesture.lastDeltaX = deltaX;
            this.feedCut(gesture, deltaX);
            if (!gesture.consumed && deltaX >= threshold) {
                gesture.consumed = true;
                this.openPickerSafely(gesture);
            }
            return;
        }

        if (event.touches.length !== 1) {
            // A second finger landed before the claim (pinch, two-finger scroll):
            // never block it.
            gesture.released = true;
            this.dropCut();
            return;
        }
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        // The direction is settled before the feedback runs: the claim is what
        // stops Obsidian's own edge gestures, and it must not wait for the
        // effect, which is only decoration and may fail.
        const decision = decideGesture(deltaX, deltaY, decisionDistancePx(gesture.startX));
        // The block leaves the note at the very first pixel of rightward
        // travel, well before the gesture is claimed, so the paragraph is
        // already moving while the finger is still going.
        this.feedCut(gesture, deltaX);
        if (decision === "undecided") {
            return;
        }
        if (decision !== "rightward") {
            // Scroll or leftward drag: none of our business, and the block has
            // to go before the text slides out from under it.
            gesture.released = true;
            this.dropCut();
            return;
        }
        // Horizontal-dominant rightward drag over the editor: claim it before
        // the built-in drawer gesture reacts, wherever the touch started.
        gesture.claimed = true;
        this.swallowTouch(event);
        this.debugLog(`swipe claimed (dx ${Math.round(deltaX)} px, dy ${Math.round(deltaY)} px)`);
        this.debugLog(`claimed at dx ${Math.round(deltaX)} px`);
        if (deltaX >= threshold) {
            gesture.consumed = true;
            this.openPickerSafely(gesture);
        }
    }

    private onTouchEnd(event: TouchEvent): void {
        const gesture = this.gesture;
        if (gesture === null) {
            return;
        }
        const touch = touchById(event.changedTouches, gesture.touchId);
        if (touch === null) {
            // An end event we cannot attribute: the finger is gone and the
            // viewport is in an unknown state, so snap the block back at once.
            this.dropCut();
            return;
        }
        this.gesture = null;
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        if (gesture.claimed) {
            this.swallowTouch(event);
            if (gesture.consumed) {
                // The picker is open: the paragraph is already gone from here.
                this.dropCut();
            } else if (deltaX >= this.settings.swipeThresholdPx) {
                // Some WebView builds stop delivering touchmove events once a
                // gesture is claimed, so the threshold is re-checked here.
                gesture.consumed = true;
                this.debugLog(
                    `opening the picker from the end event (dx ${Math.round(deltaX)} px; ${gesture.claimedMoves} move event(s) received after the claim)`,
                );
                this.openPickerSafely(gesture);
            } else {
                this.debugLog(
                    `swipe ended below the threshold (dx ${Math.round(deltaX)} px, dy ${Math.round(deltaY)} px, threshold ${this.settings.swipeThresholdPx} px, ${gesture.claimedMoves} move event(s) received)`,
                );
                // A claimed swipe has blocked scrolling, so nothing moved:
                // the block may glide back into its slot.
                this.releaseCut();
            }
            this.collapseLeftDrawerIfOpenedByGesture(gesture);
            return;
        }
        if (gesture.released || gesture.consumed) {
            this.releaseCut();
            return;
        }
        // Fast flick without intermediate moves (rare): decide on the end event.
        if (
            decideGesture(deltaX, deltaY) === "rightward" &&
            isRightwardSwipe(deltaX, deltaY, this.settings.swipeThresholdPx)
        ) {
            this.openPickerSafely(gesture);
        } else {
            this.releaseCut();
        }
    }

    private onTouchCancel(event: TouchEvent): void {
        const gesture = this.gesture;
        this.gesture = null;
        // The system took the gesture away; the viewport may have moved with it.
        this.dropCut();
        if (gesture !== null && gesture.claimed) {
            this.swallowTouch(event);
            if (!gesture.consumed) {
                this.debugLog(
                    `the system cancelled the swipe after the claim (${gesture.claimedMoves} move event(s) received, last dx ${Math.round(gesture.lastDeltaX)} px)`,
                );
            }
            this.collapseLeftDrawerIfOpenedByGesture(gesture);
        }
    }

    /**
     * Hides the remaining events of a claimed gesture from the app and from
     * CodeMirror, so the built-in swipe-to-open-sidebar gesture is not
     * triggered and no stray click is synthesized.
     */
    private swallowTouch(event: TouchEvent): void {
        event.stopImmediatePropagation();
        event.preventDefault();
    }

    /** Calls triggerSwipe, converting any unexpected exception into a visible notice. */
    private openPickerSafely(gesture: TouchGesture): void {
        this.detachCut(); // the block leaves the note for good
        try {
            this.triggerSwipe(gesture);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Paragraph Swipe: failed to open the picker", error);
            new Notice(`Paragraph Swipe: internal error — ${message}`);
        }
    }

    /**
     * Progress channel for the effect: a pointermove only ever moves the block
     * along, it never claims or swallows anything. Gestures only start from a
     * touchstart, so there is nothing to do without one.
     */
    private onPointerMove(event: PointerEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released || this.cut === null || !event.isPrimary) {
            return; // a second finger must not drag the block away
        }
        const deltaX = event.clientX - gesture.startX;
        gesture.lastDeltaX = deltaX;
        this.feedCut(gesture, deltaX);
    }

    /**
     * Starts the effect if it is not up yet and carries it to the finger. The
     * whole feedback is optional: an exception in it must not abort the
     * touchmove handler, or the gesture would never be claimed and the app's own
     * edge gestures would take over. One failure disables it for the rest of
     * the gesture instead of repeating it on every move.
     */
    private feedCut(gesture: TouchGesture, deltaX: number): void {
        if (gesture.effectBroken || gesture.consumed) {
            // Consumed means the picker has taken the paragraph over: the finger
            // is still down, and starting a new block here would leave it behind
            // on the document with nothing left to clean it up.
            return;
        }
        try {
            if (this.cut === null) {
                if (!isCRAZYIntent(deltaX)) {
                    return; // not a rightward swipe yet: nothing to carry away
                }
                this.startCut(gesture, deltaX);
            } else {
                this.updateCut(deltaX);
            }
        } catch (error) {
            gesture.effectBroken = true;
            this.dropCut();
            console.warn("Paragraph Swipe: the cut effect failed and was switched off for this gesture", error);
            this.debugLog("the cut effect failed; the swipe itself keeps working");
        }
    }

    /**
     * Cuts the paragraph under the finger out of its note and hands it to the
     * swipe. Everything is measured once, here: from now on the gesture
     * swallows its own touchmove events, so the editor cannot scroll and the
     * block cannot drift away from the finger.
     */
    private startCut(gesture: TouchGesture, deltaX: number): void {
        this.dropCut();
        const lookup = this.lookupParagraph(gesture.view, gesture.startX, gesture.startY);
        if (lookup.kind === "blank") {
            this.debugLog(`the swipe started on a blank line (line ${lookup.line + 1}); nothing to cut out`);
            return;
        }
        if (lookup.kind === "unresolved") {
            this.debugLog(`cannot resolve the editor position under the finger; ${lookup.detail}`);
            return;
        }
        // Remembered for the picker: the lines are about to move out from under
        // the start coordinates.
        gesture.paragraph = lookup;
        const { cut, reason } = SwipeCut.attach(
            gesture.view,
            lookup.range,
            lookup.line,
            gesture.startX,
            gesture.startY,
        );
        if (cut === null) {
            this.debugLog(
                `the paragraph on lines ${lookup.range.start + 1}–${lookup.range.end} cannot be cut out (${reason})`,
            );
            return;
        }
        this.cut = cut;
        cut.setShift(deltaX);
        cut.setProgress(swipeProgress(deltaX, this.settings.swipeThresholdPx));
        this.debugLog(
            `the block on lines ${lookup.range.start + 1}–${lookup.range.end} was cut out (${lookup.strategy})`,
        );
    }

    /** Carries the block to the finger's position. A no-op without one. */
    private updateCut(deltaX: number): void {
        if (this.cut === null) {
            return;
        }
        this.cut.setShift(deltaX);
        this.cut.setProgress(swipeProgress(deltaX, this.settings.swipeThresholdPx));
    }

    /** The swipe was abandoned: the block glides back into its slot. */
    private releaseCut(): void {
        const cut = this.cut;
        this.cut = null;
        cut?.release();
    }

    /** The block was accepted: it flies off to the right and leaves. */
    private detachCut(): void {
        const cut = this.cut;
        this.cut = null;
        cut?.detach();
    }

    /** Snaps the block back at once, for when the text is about to move. */
    private dropCut(): void {
        const cut = this.cut;
        this.cut = null;
        cut?.drop();
    }

    /** Runtime probe: `leftSplit.collapsed` differs between typings releases. */
    private isLeftDrawerOpen(): boolean {
        const workspace: unknown = this.app.workspace;
        if (typeof workspace !== "object" || workspace === null) {
            return false;
        }
        const leftSplit = (workspace as Record<string, unknown>)["leftSplit"];
        if (typeof leftSplit !== "object" || leftSplit === null) {
            return false;
        }
        return (leftSplit as Record<string, unknown>)["collapsed"] === false;
    }

    /**
     * Safety net: if the drawer gesture still managed to open the left sidebar
     * during a claimed swipe (its listener may be registered earlier than
     * ours), close it again — but only if the sidebar was closed when the
     * gesture started, so a drawer opened deliberately is never touched.
     */
    private collapseLeftDrawerIfOpenedByGesture(gesture: TouchGesture): void {
        if (gesture.leftDrawerOpenAtStart || !this.isLeftDrawerOpen()) {
            return;
        }
        const workspace: unknown = this.app.workspace;
        if (typeof workspace !== "object" || workspace === null) {
            return;
        }
        const leftSplit = (workspace as Record<string, unknown>)["leftSplit"];
        if (typeof leftSplit !== "object" || leftSplit === null) {
            return;
        }
        const collapse = (leftSplit as Record<string, unknown>)["collapse"];
        if (typeof collapse === "function") {
            (collapse as (...args: unknown[]) => unknown).call(leftSplit);
        }
    }

    /**
     * Finds the paragraph under the given viewport coordinates. Silent on
     * purpose: the swipe must not spam the debug log, so only the picker
     * reports why there is nothing to move.
     */
    private lookupParagraph(view: MarkdownView, x: number, y: number): ParagraphLookup {
        const editor = view.editor;
        const resolved = posAtClientPoint(editor, x, y);
        if (resolved === null) {
            return { kind: "unresolved", detail: describePositionStrategies(editor) };
        }
        const range = getParagraphRange(splitLines(editor.getValue()), resolved.position.line);
        if (range === null) {
            return { kind: "blank", line: resolved.position.line, strategy: resolved.strategy };
        }
        return { kind: "paragraph", range, line: resolved.position.line, strategy: resolved.strategy };
    }

    /**
     * The paragraph this gesture is about: the one the cut effect resolved, or
     * a fresh lookup for the rare flick that never got far enough to start one.
     */
    private paragraphOf(gesture: TouchGesture): ParagraphLookup {
        if (gesture.paragraph === null) {
            return this.lookupParagraph(gesture.view, gesture.startX, gesture.startY);
        }
        return {
            kind: "paragraph",
            range: gesture.paragraph.range,
            line: gesture.paragraph.line,
            strategy: gesture.paragraph.strategy,
        };
    }

    /** Opens the note picker for the paragraph this gesture started on. */
    private triggerSwipe(gesture: TouchGesture): void {
        const view = gesture.view;
        const { startX: x, startY: y } = gesture;
        const lookup = this.paragraphOf(gesture);
        if (lookup.kind === "unresolved") {
            this.debugLog(
                `cannot resolve the editor position at (${Math.round(x)}, ${Math.round(y)}); ${lookup.detail}`,
            );
            return;
        }
        if (lookup.kind === "blank") {
            this.debugLog(
                `the swipe started on a blank line (line ${lookup.line + 1}, via ${lookup.strategy}) — nothing to move`,
            );
            return;
        }
        const sourceFile = view.file;
        if (!sourceFile) {
            this.debugLog("the note is not backed by a file; nothing to move");
            return;
        }
        this.debugLog(
            `opening the picker for the paragraph on lines ${lookup.range.start + 1}–${lookup.range.end} (via ${lookup.strategy})`,
        );
        const startLine = lookup.range.start;
        const modal = new NotePickerModal(this.app, sourceFile.path, (targetFile: TFile) => {
            void this.moveParagraph(view, startLine, targetFile).catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                new Notice(`Paragraph Swipe: failed to move the paragraph — ${message}`);
            });
        });
        modal.open();
    }

    private async moveParagraph(sourceView: MarkdownView, lineIndex: number, targetFile: TFile): Promise<void> {
        const editor = sourceView.editor;
        const sourceFile = sourceView.file;
        if (!sourceFile || targetFile.path === sourceFile.path) {
            this.debugLog("move aborted: no source file or the target equals the source");
            return;
        }

        const linesBefore = splitLines(editor.getValue());
        const rangeBefore = getParagraphRange(linesBefore, lineIndex);
        if (rangeBefore === null) {
            this.debugLog("move aborted: the paragraph disappeared before the pick");
            return;
        }
        const paragraph = joinLines(extractParagraphLines(linesBefore, rangeBefore));

        // Append first: if anything below fails, the paragraph is duplicated (recoverable), never lost.
        try {
            await this.app.vault.process(targetFile, (data) =>
                appendParagraphToText(normalizeLineEndings(data), paragraph),
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Paragraph Swipe: could not update "${targetFile.basename}" — ${message}`);
            return;
        }

        // Re-read the editor content: it may have changed while the modal was open.
        const linesAfter = splitLines(editor.getValue());
        const rangeAfter = getParagraphRange(linesAfter, lineIndex);
        if (rangeAfter === null) {
            this.debugLog("move aborted: the paragraph vanished from the source note");
            return;
        }
        if (joinLines(extractParagraphLines(linesAfter, rangeAfter)) !== paragraph) {
            this.debugLog("move aborted: the source paragraph changed while the picker was open");
            return; // content drifted; do not risk deleting the wrong lines
        }
        const deletion = getDeletionRange(linesAfter, rangeAfter);
        const charRange = toCharRange(linesAfter, deletion);
        editor.replaceRange("", charRange.from, charRange.to);

        new Notice(`Paragraph moved to "${targetFile.basename}".`);
    }
}