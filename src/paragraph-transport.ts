import { App, MarkdownView, Notice, TFile } from "obsidian";

import { posAtClientPoint } from "./editor-position";
import { showError } from "./lib/notify";
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

/** A paragraph found under a viewport point. */
export interface ResolvedParagraph {
    readonly range: ParagraphRange;
    /** The document line under the finger, i.e. where inside the paragraph it is. */
    readonly line: number;
}

/** Outcome of resolving the paragraph under a viewport point. */
export type ParagraphLookup =
    | { readonly kind: "paragraph"; readonly paragraph: ResolvedParagraph }
    | { readonly kind: "blank" }
    | { readonly kind: "unresolved" };

/**
 * Everything the plugin does to the notes' content: resolving the paragraph
 * under a viewport point, moving it to another note. Knows nothing about
 * gestures, picking UI or the cut effect.
 */
export class ParagraphTransport {
    constructor(private readonly app: App) {}

    /**
     * Finds the paragraph under the given viewport coordinates. Silent on
     * purpose: swipes that miss must not interrupt the user, only the move
     * reports its result.
     */
    public resolveParagraph(view: MarkdownView, x: number, y: number): ParagraphLookup {
        const editor = view.editor;
        const position = posAtClientPoint(editor, x, y);
        if (position === null) {
            return { kind: "unresolved" };
        }
        const range = getParagraphRange(splitLines(editor.getValue()), position.line);
        if (range === null) {
            return { kind: "blank" };
        }
        return { kind: "paragraph", paragraph: { range, line: position.line } };
    }

    /**
     * Moves the paragraph at `lineIndex` to the end of `targetFile` (separated
     * by exactly one blank line) and cuts it out of the source together with
     * one of the surrounding blank lines. Append runs first: if anything below
     * it fails, the paragraph is duplicated (recoverable) and never lost.
     */
    public async moveParagraph(sourceView: MarkdownView, lineIndex: number, targetFile: TFile): Promise<void> {
        const editor = sourceView.editor;
        const sourceFile = sourceView.file;
        if (!sourceFile || targetFile.path === sourceFile.path) {
            return;
        }

        const linesBefore = splitLines(editor.getValue());
        const rangeBefore = getParagraphRange(linesBefore, lineIndex);
        if (rangeBefore === null) {
            return; // the paragraph disappeared before the pick
        }
        const paragraph = joinLines(extractParagraphLines(linesBefore, rangeBefore));

        try {
            await this.app.vault.process(targetFile, (data) =>
                appendParagraphToText(normalizeLineEndings(data), paragraph),
            );
        } catch (error) {
            showError(`could not update "${targetFile.basename}"`, error);
            return;
        }

        // Re-read the editor content: it may have changed while the modal was open.
        const linesAfter = splitLines(editor.getValue());
        const rangeAfter = getParagraphRange(linesAfter, lineIndex);
        if (rangeAfter === null) {
            return; // the paragraph vanished from the source note
        }
        if (joinLines(extractParagraphLines(linesAfter, rangeAfter)) !== paragraph) {
            return; // content drifted; do not risk deleting the wrong lines
        }
        const { from, to } = toCharRange(linesAfter, getDeletionRange(linesAfter, rangeAfter));
        editor.replaceRange("", from, to);

        new Notice(`Paragraph moved to "${targetFile.basename}".`);
    }
}
