/**
 * Pure helpers for mapping screen points to document lines.
 * No imports: unit-testable without Obsidian.
 */

/** The part of a rendered line's bounding box that matters for hit testing. */
export interface VerticalBounds {
    readonly top: number;
    readonly bottom: number;
}

function isValidBounds(rect: VerticalBounds | null): rect is VerticalBounds {
    return rect !== null && Number.isFinite(rect.top) && Number.isFinite(rect.bottom);
}

/**
 * Finds the index of the line rendered at the given Y coordinate, or — when
 * the point falls into a gap between lines — the line directly above it.
 * Returns null when there are no lines, when a rectangle cannot be measured,
 * or when the point is above the first line.
 *
 * Binary search over line indices; assumes the usual top-to-bottom,
 * non-overlapping layout.
 */
export function findLineIndexAtY(
    lineCount: number,
    y: number,
    rectAt: (line: number) => VerticalBounds | null,
): number | null {
    if (!Number.isInteger(lineCount) || lineCount <= 0) {
        return null;
    }
    let low = 0;
    let high = lineCount - 1;
    let candidate: number | null = null;
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const rect = rectAt(mid);
        if (!isValidBounds(rect)) {
            return null;
        }
        if (y < rect.top) {
            high = mid - 1;
        } else if (y > rect.bottom) {
            candidate = mid;
            low = mid + 1;
        } else {
            return mid;
        }
    }
    return candidate;
}

/**
 * Linear variant restricted to the visible range [firstVisible, lastVisible].
 * CodeMirror 6 renders only the viewport and cannot measure unrendered lines,
 * so this is the reliable scan when the visible range is known.
 * Returns null when the range is invalid or no line's box contains `y`.
 */
export function findVisibleLineIndexAtY(
    firstVisible: number,
    lastVisible: number,
    y: number,
    rectAt: (line: number) => VerticalBounds | null,
): number | null {
    if (
        !Number.isInteger(firstVisible) ||
        !Number.isInteger(lastVisible) ||
        firstVisible < 0 ||
        lastVisible < firstVisible
    ) {
        return null;
    }
    for (let line = firstVisible; line <= lastVisible; line += 1) {
        const rect = rectAt(line);
        if (isValidBounds(rect) && y >= rect.top && y <= rect.bottom) {
            return line;
        }
    }
    return null;
}