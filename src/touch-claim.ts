import { App, MarkdownView } from "obsidian";

import { decideGesture, decisionDistancePx, isRightwardSwipe, touchById } from "./lib/gesture";
import { readFunction, readObject } from "./lib/runtime-probe";

/**
 * The claim part of the swipe pipeline: observe raw touch events, recognize a
 * rightward drag over an editable editor before Obsidian's own edge gestures
 * can react, and swallow every further event of a claimed gesture
 * (preventDefault + stopImmediatePropagation) — the app's built-in
 * swipe-to-open-the-left-drawer gesture would otherwise fire wherever the
 * swipe started.
 *
 * This module knows nothing about what a rightward swipe means: the picker,
 * the paragraph and the cut effect are pushed out as semantic events to the
 * handlers passed on construction. Threshold re-checks on touchend and the
 * drawer undo are claim mechanics and live here; everything above the claim
 * lives with the conductor.
 */

/** Where a gesture started, and the view it belongs to. */
export interface SwipeGesture {
    readonly view: MarkdownView;
    readonly startX: number;
    readonly startY: number;
}

export interface TouchClaimHandlers {
    /** The editable source-mode view containing the element, or null. */
    findEditableView(target: Element): MarkdownView | null;
    /** Horizontal travel of a live touch gesture (before and after the claim). */
    onTravel(gesture: SwipeGesture, deltaX: number): void;
    /**
     * A pointermove carry-along: may feed an already running block, never
     * starts one (some WebView builds stop delivering touchmove after the
     * claim, and pointer events are generated independently of them).
     */
    onCarry(gesture: SwipeGesture, deltaX: number): void;
    /** The swipe is accepted: the threshold has been crossed, the picker takes over. */
    onAccepted(gesture: SwipeGesture): void;
    /** A claimed swipe finished below the threshold: nothing to move. */
    onAbandoned(gesture: SwipeGesture): void;
    /** The whole effect has to be dropped at once (the text moved, cancel, new touch). */
    onReset(gesture: SwipeGesture): void;
}

interface GestureState extends SwipeGesture {
    readonly touchId: number;
    /** The left drawer's state at touchstart, for the drawer-undo safety net. */
    readonly leftDrawerOpenAtStart: boolean;
    /** Claimed: all further events of this gesture are hidden from the app. */
    claimed: boolean;
    /** Released back to the app (a scroll, a leftward drag, a second finger). */
    released: boolean;
    /** The threshold has been crossed; the picker has taken over. */
    accepted: boolean;
}

export class TouchClaimTracker {
    private gesture: GestureState | null = null;

    constructor(
        private readonly app: App,
        /** Read on every use, so a threshold change in settings applies at once. */
        private readonly thresholdPx: () => number,
        private readonly handlers: TouchClaimHandlers,
    ) {}

    public onTouchStart(event: TouchEvent): void {
        const previous = this.gesture;
        if (previous !== null && previous.claimed && event.touches.length > 1) {
            return; // a stray second finger must not kill an active claimed swipe
        }
        this.gesture = null;
        if (previous !== null) {
            this.handlers.onReset(previous);
        }
        const touch = event.touches[0];
        if (event.touches.length !== 1 || touch === undefined) {
            return;
        }
        const target = event.target;
        if (!(target instanceof Element)) {
            return;
        }
        const selection = window.getSelection();
        if (selection !== null && !selection.isCollapsed) {
            return; // an active text selection: leave handle dragging to the app
        }
        const view = this.handlers.findEditableView(target);
        if (view === null) {
            return;
        }
        this.gesture = {
            touchId: touch.identifier,
            view,
            startX: touch.clientX,
            startY: touch.clientY,
            leftDrawerOpenAtStart: readObject(this.app.workspace, "leftSplit")?.collapsed === false,
            claimed: false,
            released: false,
            accepted: false,
        };
        // touchstart is never swallowed: taps must keep placing the caret.
    }

    public onTouchMove(event: TouchEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released) {
            return;
        }
        const touch = touchById(event.changedTouches, gesture.touchId);
        if (touch === null) {
            return;
        }
        const threshold = this.thresholdPx();
        if (gesture.claimed) {
            // Keep swallowing regardless of the number of active touches: a
            // claimed gesture must run to completion even if a palm touch lands.
            this.swallow(event);
            const deltaX = touch.clientX - gesture.startX;
            this.handlers.onTravel(gesture, deltaX);
            if (!gesture.accepted && deltaX >= threshold) {
                gesture.accepted = true;
                this.handlers.onAccepted(gesture);
            }
            return;
        }
        if (event.touches.length !== 1) {
            // A second finger landed before the claim (pinch, two-finger
            // scroll): never block that, and drop whatever the effect built.
            gesture.released = true;
            this.gesture = null;
            this.handlers.onReset(gesture);
            return;
        }
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        // The direction is settled before the effect is claimed: the claim is
        // what stops Obsidian's own edge gestures, and it must not wait for the
        // effect, which is only decoration and may fail.
        const decision = decideGesture(deltaX, deltaY, decisionDistancePx(gesture.startX));
        // The block leaves the note at the very first pixel of rightward
        // travel, well before the gesture is claimed.
        this.handlers.onTravel(gesture, deltaX);
        if (decision === "undecided") {
            return;
        }
        if (decision !== "rightward") {
            gesture.released = true;
            this.gesture = null;
            this.handlers.onReset(gesture);
            return;
        }
        // Horizontal-dominant rightward drag over the editor: claim it before
        // the built-in drawer gesture reacts, wherever the touch started.
        gesture.claimed = true;
        this.swallow(event);
        if (deltaX >= threshold) {
            gesture.accepted = true;
            this.handlers.onAccepted(gesture);
        }
    }

    public onTouchEnd(event: TouchEvent): void {
        const gesture = this.gesture;
        if (gesture === null) {
            return;
        }
        const touch = touchById(event.changedTouches, gesture.touchId);
        if (touch === null) {
            // An end event we cannot attribute: the finger is gone and the
            // viewport is in an unknown state, so everything snaps back.
            this.gesture = null;
            this.handlers.onReset(gesture);
            return;
        }
        this.gesture = null;
        const deltaX = touch.clientX - gesture.startX;
        const deltaY = touch.clientY - gesture.startY;
        if (gesture.claimed) {
            this.swallow(event);
            if (gesture.accepted) {
                // The picker is open: the paragraph is already gone from here.
                this.handlers.onReset(gesture);
            } else {
                // Some WebView builds stop delivering touchmove events once a
                // gesture is claimed, so the threshold is re-checked here.
                if (deltaX >= this.thresholdPx()) {
                    gesture.accepted = true;
                    this.handlers.onAccepted(gesture);
                } else {
                    // A claimed swipe has blocked scrolling, so nothing moved:
                    // the block may glide back into its slot.
                    this.handlers.onAbandoned(gesture);
                }
            }
            this.collapseDrawerIfOpenedByGesture(gesture);
            return;
        }
        if (gesture.released || gesture.accepted) {
            // Everything was already undone when the gesture was released.
            return;
        }
        // Fast flick without intermediate moves (rare): decide on the end event.
        if (
            decideGesture(deltaX, deltaY) === "rightward" &&
            isRightwardSwipe(deltaX, deltaY, this.thresholdPx())
        ) {
            this.handlers.onAccepted(gesture);
        }
    }

    public onTouchCancel(event: TouchEvent): void {
        const gesture = this.gesture;
        this.gesture = null;
        if (gesture === null) {
            return;
        }
        // The system took the gesture away; the viewport may have moved with it.
        this.handlers.onReset(gesture);
        if (gesture.claimed) {
            this.swallow(event);
            this.collapseDrawerIfOpenedByGesture(gesture);
        }
    }

    public onPointerMove(event: PointerEvent): void {
        const gesture = this.gesture;
        if (gesture === null || gesture.released || !event.isPrimary) {
            return; // a second pointer must not drag the block away
        }
        this.handlers.onCarry(gesture, event.clientX - gesture.startX);
    }

    /**
     * Hides the remaining events of a claimed gesture from the app and from
     * CodeMirror, so the built-in swipe-to-open-drawer gesture is not
     * triggered and no stray click is synthesized.
     */
    private swallow(event: TouchEvent): void {
        event.stopImmediatePropagation();
        event.preventDefault();
    }

    /**
     * Safety net: if the drawer gesture still managed to open the left sidebar
     * during a claimed swipe (its listener may be registered earlier than
     * ours), close it again — but only if the sidebar was closed when the
     * gesture started, so a drawer opened deliberately is never touched.
     */
    private collapseDrawerIfOpenedByGesture(gesture: GestureState): void {
        if (gesture.leftDrawerOpenAtStart) {
            return;
        }
        const leftSplit = readObject(this.app.workspace, "leftSplit");
        if (leftSplit === null || leftSplit["collapsed"] !== false) {
            return;
        }
        const collapse = readFunction(leftSplit, "collapse");
        if (collapse !== null) {
            collapse.call(leftSplit);
        }
    }
}
