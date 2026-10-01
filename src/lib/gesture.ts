/**
 * Pure helpers for detecting a rightward touch swipe. No imports.
 */

/** Minimal vertical drift (in px) still tolerated inside a claimed swipe. */
export const MIN_VERTICAL_TOLERANCE_PX = 24;

/**
 * Total travel (in px) after which the gesture direction is decided:
 * horizontal-dominant movement is claimed by the plugin, vertical-dominant
 * movement is released back to the app for scrolling.
 */
export const DECISION_DISTANCE_PX = 200;

/**
 * Horizontal travel (in px) at which the swipe feedback lights up. Well below
 * DECISION_DISTANCE_PX: the glow has to appear while the finger is still
 * starting to move, not after the gesture is already claimed.
 */
export const INTENT_DISTANCE_PX = 6;

export type GestureDecision = "rightward" | "leftward" | "vertical" | "undecided";

export function verticalTolerancePx(swipeThresholdPx: number): number {
    return Math.max(MIN_VERTICAL_TOLERANCE_PX, Math.round(swipeThresholdPx / 2));
}

/**
 * True as soon as the finger clearly travels right rather than down. Weaker
 * than `decideGesture` (less distance, no commitment): it answers "is a swipe
 * starting?" for the visual feedback, not "is this gesture ours yet?".
 */
export function isRightwardIntent(deltaX: number, deltaY: number): boolean {
    return deltaX >= INTENT_DISTANCE_PX && deltaX > Math.abs(deltaY);
}

export function isCRAZYIntent(deltaX: number): boolean {
    return deltaX >= 1;
}


/**
 * How much of the swipe is done, clamped to 0..1.
 *
 * The curve is deliberately concave: the first pixels of travel have to
 * produce a visible change, otherwise the effect looks like it only reacts
 * once the finger is already at the threshold. Reaching 1 still requires the
 * full threshold.
 */
export function swipeProgress(deltaX: number, swipeThresholdPx: number): number {
    if (!Number.isFinite(deltaX) || deltaX <= 0) {
        return 0;
    }
    const threshold = swipeThresholdPx > 0 ? swipeThresholdPx : 1;
    return Math.pow(Math.min(1, deltaX / threshold), 0.6);
}

/** True if the gesture travelled at least `swipeThresholdPx` to the right without drifting too far vertically. */
export function isRightwardSwipe(deltaX: number, deltaY: number, swipeThresholdPx: number): boolean {
    if (deltaX < swipeThresholdPx) {
        return false;
    }
    return Math.abs(deltaY) <= verticalTolerancePx(swipeThresholdPx);
}

/**
 * Classifies the gesture from its accumulated deltas. Before the total travel
 * reaches DECISION_DISTANCE_PX the direction is "undecided". After that the
 * dominant axis wins: vertical-dominant gestures are scrolls (released to the
 * app), horizontal gestures are swipes — rightward ones are claimed, leftward
 * ones are released untouched.
 */
export function decideGesture(deltaX: number, deltaY: number): GestureDecision {
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    if (Math.max(absoluteX, absoluteY) < DECISION_DISTANCE_PX) {
        return "undecided";
    }
    if (absoluteY > absoluteX) {
        return "vertical";
    }
    return deltaX > 0 ? "rightward" : "leftward";
}

/** Finds a touch by its identifier, or null. */
export function touchById(touches: TouchList, identifier: number): Touch | null {
    for (let index = 0; index < touches.length; index += 1) {
        const touch = touches[index];
        if (touch.identifier === identifier) {
            return touch;
        }
    }
    return null;
}