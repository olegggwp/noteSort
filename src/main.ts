import { MarkdownView, Notice, Plugin, TFile } from "obsidian";

import { describePositionStrategies, isEditorEditable, posAtClientPoint } from "./editor-position";
import { decideGesture, isCRAZYIntent, isRightwardSwipe, swipeProgress, touchById } from "./lib/gesture";
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
import { SwipeGlow } from "./swipe-glow";

/** Outcome of resolving the paragraph under a viewport point. */
type ParagraphLookup =
    | { readonly kind: "paragraph"; readonly range: ParagraphRange; readonly strategy: string }
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
 * A claimed swipe lights up the paragraph it is about to move: a glowing band
 * whose brightness grows with the travelled distance (see `SwipeGlow`), so the
 * threshold is visible before the picker takes over.
 */
export default class ParagraphSwipePlugin extends Plugin {
    public settings: ParagraphSwipeSettings = { ...DEFAULT_SETTINGS };

    private gesture: TouchGesture | null = null;

    /** The glow of the swipe in progress, if any. */
    private glow: SwipeGlow | null = null;

    public async onload(): Promise<void> {
        await this.loadSettings();
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
        // Safety net for the glow: a claimed swipe blocks scrolling, so any
        // scroll seen while it is up means the viewport moved underneath the
        // band (the picker opening, the layout resizing) and it must go.
        // Capture is what makes the non-bubbling scroll of any element in the
        // document reach the window listener.
        this.registerDomEvent(
            window,
            "scroll",
            () => {
                this.dropGlow();
            },
            { capture: true, passive: true },
        );
        // Second channel for the glow's progress. Some WebView builds stop
        // delivering touchmove once the gesture is claimed (which is why the
        // threshold is re-checked on touchend); pointer events are generated
        // from the same input pipeline independently, so the band keeps
        // growing with the finger there. Passive: we only read coordinates.
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
        this.dropGlow();
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
        this.dropGlow();
        if (event.touches.length !== 1) {
            return;
        }
        const touch = event.touches[0];
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const selection = window.getSelection();
        if (selection !== null && !selection.isCollapsed) {
            return; // an active text selection: leave handle dragging to the app
        }
        const view = this.findSourceMarkdownView(target);
        if (view === null) {
            return;
        }
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
        };
        // touchstart is never swallowed: taps must keep placing the caret.
    }

    private onTouchMove(event: TouchEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released) {
            return;
        }
        const touch = touchById(event.changedTouches, gesture.touchId);
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
            this.updateGlow(deltaX);
            if (!gesture.consumed && deltaX >= threshold) {
                gesture.consumed = true;
                this.openPickerSafely(gesture.view, gesture.startX, gesture.startY);
            }
            return;
        }

        if (event.touches.length !== 1) {
            // A second finger landed before the claim (pinch, two-finger scroll):
            // never block it.
            gesture.released = true;
            this.dropGlow();
            return;
        }
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        // The feedback starts with the first clearly rightward movement, well
        // before the gesture is claimed, so the paragraph lights up while the
        // finger is still travelling instead of once it is already over.
        // if (this.glow === null && isRightwardIntent(deltaX, deltaY)) {
        if (this.glow === null && isCRAZYIntent(deltaX)) {
            this.startGlow(gesture, deltaX);
        }
        this.updateGlow(deltaX);
        const decision = decideGesture(deltaX, deltaY);
        if (decision === "undecided") {
            return;
        }
        if (decision !== "rightward") {
            // Scroll or leftward drag: none of our business, and the band has
            // to go before the text slides out from under it.
            gesture.released = true;
            this.dropGlow();
            return;
        }
        // Horizontal-dominant rightward drag over the editor: claim it before
        // the built-in drawer gesture reacts, wherever the touch started.
        gesture.claimed = true;
        this.swallowTouch(event);
        this.debugLog(`swipe claimed (dx ${Math.round(deltaX)} px, dy ${Math.round(deltaY)} px)`);
        if (deltaX >= threshold) {
            gesture.consumed = true;
            this.openPickerSafely(gesture.view, gesture.startX, gesture.startY);
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
            // viewport is in an unknown state, so drop the feedback at once.
            this.dropGlow();
            return;
        }
        this.gesture = null;
        // A claimed swipe has blocked scrolling, so nothing moved: the band
        // may fade out gracefully.
        this.stopGlow();
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        if (gesture.claimed) {
            this.swallowTouch(event);
            if (!gesture.consumed) {
                if (deltaX >= this.settings.swipeThresholdPx) {
                    // Some WebView builds stop delivering touchmove events once a
                    // gesture is claimed, so the threshold is re-checked here.
                    gesture.consumed = true;
                    this.debugLog(
                        `opening the picker from the end event (dx ${Math.round(deltaX)} px; ${gesture.claimedMoves} move event(s) received after the claim)`,
                    );
                    this.openPickerSafely(gesture.view, gesture.startX, gesture.startY);
                } else {
                    this.debugLog(
                        `swipe ended below the threshold (dx ${Math.round(deltaX)} px, dy ${Math.round(deltaY)} px, threshold ${this.settings.swipeThresholdPx} px, ${gesture.claimedMoves} move event(s) received)`,
                    );
                }
            }
            this.collapseLeftDrawerIfOpenedByGesture(gesture);
            return;
        }
        if (gesture.released || gesture.consumed) {
            return;
        }
        // Fast flick without intermediate moves (rare): decide on the end event.
        if (
            decideGesture(deltaX, deltaY) === "rightward" &&
            isRightwardSwipe(deltaX, deltaY, this.settings.swipeThresholdPx)
        ) {
            this.openPickerSafely(gesture.view, gesture.startX, gesture.startY);
        }
    }

    private onTouchCancel(event: TouchEvent): void {
        const gesture = this.gesture;
        this.gesture = null;
        // The system took the gesture away; the viewport may have moved with it.
        this.dropGlow();
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
    private openPickerSafely(view: MarkdownView, x: number, y: number): void {
        this.stopGlow(); // the picker takes over the feedback from here
        try {
            this.triggerSwipe(view, x, y);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error("Paragraph Swipe: failed to open the picker", error);
            new Notice(`Paragraph Swipe: internal error — ${message}`);
        }
    }

    /**
     * Progress channel for the glow: a pointermove is only ever used to grow
     * the band, never to claim or swallow anything. Gestures only ever start
     * from a touchstart, so there is nothing to do without one.
     */
    private onPointerMove(event: PointerEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released || this.glow === null || !event.isPrimary) {
            return; // a second finger must not drag the band away
        }
        const deltaX = event.clientX - gesture.startX;
        gesture.lastDeltaX = deltaX;
        this.updateGlow(deltaX);
    }

    /**
     * Lays a glowing band over the paragraph this swipe is about to move.
     * Measuring happens once, here: from now on the gesture swallows its own
     * touchmove events, so the editor cannot scroll and the paragraph cannot
     * drift away from the band.
     */
    private startGlow(gesture: TouchGesture, deltaX: number): void {
        this.dropGlow();
        const lookup = this.lookupParagraph(gesture.view, gesture.startX, gesture.startY);
        if (lookup.kind !== "paragraph") {
            return; // nothing is being moved, so nothing to highlight
        }
        const glow = SwipeGlow.attach(gesture.view, lookup.range);
        if (glow === null) {
            this.debugLog(`cannot measure the paragraph on lines ${lookup.range.start + 1}–${lookup.range.end}; no glow`);
            return;
        }
        this.glow = glow;
        glow.setProgress(swipeProgress(deltaX, this.settings.swipeThresholdPx));
    }

    /** Grows the band to match the travelled distance. A no-op without one. */
    private updateGlow(deltaX: number): void {
        this.glow?.setProgress(swipeProgress(deltaX, this.settings.swipeThresholdPx));
    }

    /** Lets the band fade out. Safe when no swipe is running. */
    private stopGlow(): void {
        const glow = this.glow;
        this.glow = null;
        glow?.fadeOut();
    }

    /** Removes the band at once, for when the text under it is about to move. */
    private dropGlow(): void {
        const glow = this.glow;
        this.glow = null;
        glow?.hide();
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
     * purpose: the glow must not spam the debug log on every claim, so only
     * the picker reports why there is nothing to move.
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
        return { kind: "paragraph", range, strategy: resolved.strategy };
    }

    /** Opens the note picker for the paragraph under the given coordinates. */
    private triggerSwipe(view: MarkdownView, x: number, y: number): void {
        const lookup = this.lookupParagraph(view, x, y);
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