import { App, SuggestModal, TFile } from "obsidian";

import { filterAndSortNotes, parentFolderPath, type NoteCandidate } from "./lib/notes-search";

/**
 * Compact note picker: lists every markdown note except the source note,
 * sorted by last modification (newest first), with a search field.
 */
export class NotePickerModal extends SuggestModal<TFile> {
    private readonly candidates: readonly TFile[];
    private readonly filesByPath: ReadonlyMap<string, TFile>;
    private readonly onPick: (file: TFile) => void;

    constructor(app: App, sourcePath: string, onPick: (file: TFile) => void) {
        super(app);
        this.onPick = onPick;

        const files = app.vault.getMarkdownFiles().filter((file) => file.path !== sourcePath);
        this.candidates = files;
        const filesByPath = new Map<string, TFile>();
        for (const file of files) {
            filesByPath.set(file.path, file);
        }
        this.filesByPath = filesByPath;

        this.modalEl.addClass("paragraph-swipe-modal");
        this.emptyStateText = "No notes found.";
        this.setInstructions([
            { command: "↑↓", purpose: "navigate" },
            { command: "↵", purpose: "move paragraph" },
            { command: "esc", purpose: "dismiss" },
        ]);
    }

    public getSuggestions(query: string): TFile[] {
        const notes: NoteCandidate[] = this.candidates.map((file) => ({
            path: file.path,
            mtime: file.stat.mtime,
        }));
        const matches = filterAndSortNotes(notes, query);
        const suggestions: TFile[] = [];
        for (const match of matches) {
            const file = this.filesByPath.get(match.path);
            if (file !== undefined) {
                suggestions.push(file);
            }
        }
        return suggestions;
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