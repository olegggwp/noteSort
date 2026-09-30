/**
 * Pure text helpers for paragraph handling.
 *
 * A paragraph is a maximal run of consecutive non-blank lines. Lines that
 * contain only whitespace count as blank.
 *
 * This module intentionally contains no imports at all (in particular nothing
 * from "obsidian") so that it can be unit-tested in isolation.
 */

/** A half-open line range: `start` is inclusive, `end` is exclusive. */
export interface ParagraphRange {
    readonly start: number;
    readonly end: number;
}

export interface CharPosition {
    readonly line: number;
    readonly ch: number;
}

export interface CharRange {
    readonly from: CharPosition;
    readonly to: CharPosition;
}

export function isBlankLine(line: string): boolean {
    return line.trim().length === 0;
}

export function splitLines(text: string): string[] {
    return text.split("\n");
}

export function joinLines(lines: readonly string[]): string {
    return lines.join("\n");
}

/** Normalizes CRLF and lone CR line endings to LF. */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Returns the range of the paragraph containing `lineIndex`,
 * or null if that line is blank (or out of bounds).
 */
export function getParagraphRange(lines: readonly string[], lineIndex: number): ParagraphRange | null {
    if (!Number.isInteger(lineIndex) || lineIndex < 0 || lineIndex >= lines.length) {
        return null;
    }
    if (isBlankLine(lines[lineIndex])) {
        return null;
    }
    let start = lineIndex;
    while (start > 0 && !isBlankLine(lines[start - 1])) {
        start -= 1;
    }
    let end = lineIndex + 1;
    while (end < lines.length && !isBlankLine(lines[end])) {
        end += 1;
    }
    return { start, end };
}

export function extractParagraphLines(lines: readonly string[], range: ParagraphRange): string[] {
    return lines.slice(range.start, range.end);
}

/**
 * Computes the whole-line range that has to be removed from the note to get
 * rid of the paragraph without leaving stray blank lines behind:
 * - paragraph in the middle: one of the two surrounding blank lines is removed
 *   as well, so exactly one blank line keeps separating the neighbours;
 * - paragraph at the top: the blank line below it is removed as well;
 * - paragraph at the bottom: the blank line above it is removed as well;
 * - paragraph spanning the whole note: only the paragraph itself is removed.
 */
export function getDeletionRange(lines: readonly string[], range: ParagraphRange): ParagraphRange {
    const { start, end } = range;
    let deletionStart = start;
    let deletionEnd = end;
    if (start === 0) {
        if (end < lines.length && isBlankLine(lines[end])) {
            deletionEnd = end + 1;
        }
    } else if (end === lines.length) {
        if (isBlankLine(lines[start - 1])) {
            deletionStart = start - 1;
        }
    } else if (isBlankLine(lines[end])) {
        deletionEnd = end + 1;
    } else if (isBlankLine(lines[start - 1])) {
        deletionStart = start - 1;
    }
    return { start: deletionStart, end: deletionEnd };
}

/**
 * Converts a whole-line deletion range into a character range suitable for
 * `Editor.replaceRange`, so that the surrounding line breaks stay intact.
 */
export function toCharRange(lines: readonly string[], deletion: ParagraphRange): CharRange {
    if (lines.length === 0) {
        return { from: { line: 0, ch: 0 }, to: { line: 0, ch: 0 } };
    }
    const lastIndex = lines.length - 1;
    if (deletion.start > 0) {
        return {
            from: { line: deletion.start - 1, ch: lines[deletion.start - 1].length },
            to: { line: deletion.end - 1, ch: lines[deletion.end - 1].length },
        };
    }
    if (deletion.end <= lastIndex) {
        return { from: { line: 0, ch: 0 }, to: { line: deletion.end, ch: 0 } };
    }
    return { from: { line: 0, ch: 0 }, to: { line: lastIndex, ch: lines[lastIndex].length } };
}

/**
 * Removes the paragraph at `lineIndex` from `text` (with the same blank-line
 * cleanup as `getDeletionRange`). Returns null if there is no paragraph at
 * that line.
 */
export function removeParagraphFromText(text: string, lineIndex: number): string | null {
    const lines = splitLines(text);
    const range = getParagraphRange(lines, lineIndex);
    if (range === null) {
        return null;
    }
    const deletion = getDeletionRange(lines, range);
    const remaining = lines.slice(0, deletion.start).concat(lines.slice(deletion.end));
    return joinLines(remaining);
}

/**
 * Appends `paragraph` to the end of `target`, separated by exactly one empty
 * line. Trailing blank lines of the target are normalized into that single
 * separator; a trailing newline of the target is preserved. If the target is
 * empty (or blank), the paragraph becomes its whole content.
 */
export function appendParagraphToText(target: string, paragraph: string): string {
    const base = splitLines(target);
    while (base.length > 0 && isBlankLine(base[base.length - 1])) {
        base.pop();
    }
    if (paragraph.trim().length === 0) {
        return joinLines(base);
    }
    if (base.length === 0) {
        return paragraph;
    }
    const appended = joinLines(base.concat([""], splitLines(paragraph)));
    return target.endsWith("\n") ? `${appended}\n` : appended;
}