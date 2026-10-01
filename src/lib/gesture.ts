/**
 * Pure helpers for detecting a rightward touch swipe. No imports.
 */

/** Minimal vertical drift (in px) still tolerated inside a claimed swipe. */
export const MIN_VERTICAL_TOLERANCE_PX = 24;

/**
 * Total travel (in px) after which the gesture direction is decided:
 * horizontal-dominant movement is claimed by the plugin, vertical-dominant
 * movement is released back to the app for scrolling.
 *
 * This has to stay small: the claim is what calls preventDefault(), and
 * Obsidian's own swipe-to-open-the-drawer gesture wins as soon as the plugin
 * lets a touchmove pass through. On a phone screen a swipe of this size is
 * over before the drawer has even started to open.
 */
export const DECISION_DISTANCE_PX = 10;

/**
 * Width (in px) of the strip along the left edge in which Obsidian's drawer
 * gesture lives. Nothing else uses that strip, so a rightward drag started
 * there can be claimed at once instead of after DECISION_DISTANCE_PX.
 */
export const DRAWER_EDGE_ZONE_PX = 32;

export type GestureDecision = "rightward" | "leftward" | "vertical" | "undecided";

export function verticalTolerancePx(swipeThresholdPx: number): number {
    return Math.max(MIN_VERTICAL_TOLERANCE_PX, Math.round(swipeThresholdPx / 2));
}

/**
 * True as soon as the finger travels right at all, without waiting for a
 * direction to emerge. Weaker than `decideGesture` on purpose: it answers "is a
 * swipe starting?" for the visual feedback, which has to be there while the
 * finger is still moving, not once the gesture is already claimed. A gesture
 * that turns out to be a scroll is dropped by the caller anyway.
 */
export function isCRAZYIntent(deltaX: number): boolean {
    return deltaX >= 1;
}

/** True when a touch started inside the left edge strip of the drawer gesture. */
export function isDrawerZoneStart(startX: number): boolean {
    return Number.isFinite(startX) && startX <= DRAWER_EDGE_ZONE_PX;
}

/**
 * How far the finger has to travel before this gesture's direction may be
 * decided: the usual distance, or the first pixel in the drawer zone, where a
 * rightward drag can only be the drawer gesture that has to be beaten.
 */
export function decisionDistancePx(startX: number): number {
    return isDrawerZoneStart(startX) ? 1 : DECISION_DISTANCE_PX;
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
 * reaches `decisionDistancePx` (DECISION_DISTANCE_PX by default) the direction
 * is "undecided". After that the dominant axis wins: vertical-dominant gestures
 * are scrolls (released to the app), horizontal gestures are swipes — rightward
 * ones are claimed, leftward ones are released untouched.
 */
export function decideGesture(deltaX: number, deltaY: number, decisionDistancePxValue = DECISION_DISTANCE_PX): GestureDecision {
    const absoluteX = Math.abs(deltaX);
    const absoluteY = Math.abs(deltaY);
    if (Math.max(absoluteX, absoluteY) < decisionDistancePxValue) {
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