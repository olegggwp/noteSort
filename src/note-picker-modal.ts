import { App, SuggestModal, TFile } from "obsidian";

import { filterAndSortNotes, parentFolderPath } from "./lib/notes-search";

/**
 * Compact note picker: lists every markdown note except the source note,
 * sorted by last modification (newest first), with a search field.
 */
export class NotePickerModal extends SuggestModal<TFile> {
    /** Candidates with the fields the sorting needs, paired with their file. */
    private readonly candidates: readonly { file: TFile; path: string; mtime: number }[];
    private readonly onPick: (file: TFile) => void;

    constructor(app: App, sourcePath: string, onPick: (file: TFile) => void) {
        super(app);
        this.onPick = onPick;

        this.candidates = app.vault
            .getMarkdownFiles()
            .filter((file) => file.path !== sourcePath)
            .map((file) => ({ file, path: file.path, mtime: file.stat.mtime }));

        this.modalEl.addClass("paragraph-swipe-modal");
        this.emptyStateText = "No notes found.";
        this.setInstructions([
            { command: "↑↓", purpose: "navigate" },
            { command: "↵", purpose: "move paragraph" },
            { command: "esc", purpose: "dismiss" },
        ]);
    }

    public getSuggestions(query: string): TFile[] {
        return filterAndSortNotes(this.candidates, query).map((entry) => entry.file);
    }

    public renderSuggestion(file: TFile, el: HTMLElement): void {
        el.createDiv({ cls: "paragraph-swipe-suggestion-title", text: file.basename });
        const folder = parentFolderPath(file.path);
        const folderLabel = folder === "/" ? "" : `${folder} · `;
        el.createDiv({
            cls: "paragraph-swipe-suggestion-details",
            text: `${folderLabel}${new Date(file.stat.mtime).toLocaleString()}`,
        });
    }

    public onChooseSuggestion(file: TFile, _evt: MouseEvent | KeyboardEvent): void {
        this.onPick(file);
    }
}