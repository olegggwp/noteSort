/**
 * Pure helpers for filtering and sorting note candidates in the picker.
 * No imports: unit-testable without Obsidian.
 */

export interface NoteCandidate {
    /** Vault path of the note, e.g. "Folder/Note.md". */
    readonly path: string;
    /** Last modification time in milliseconds since the epoch. */
    readonly mtime: number;
}

export function tokenizeQuery(query: string): string[] {
    return query
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0);
}

/** Returns the folder part of a vault path, "/" for the vault root. */
export function parentFolderPath(path: string): string {
    const index = path.lastIndexOf("/");
    if (index <= 0) {
        return "/";
    }
    return path.slice(0, index);
}

function matchesAllTokens(path: string, tokens: readonly string[]): boolean {
    return tokens.every((token) => path.includes(token));
}

/**
 * Filters the candidates by the query (every whitespace-separated token must
 * occur in the note path, case-insensitively) and sorts what is left by last
 * modification time, newest first. Ties are broken by path so the output is
 * deterministic. The input array is never modified.
 */
export function filterAndSortNotes(candidates: readonly NoteCandidate[], query: string): NoteCandidate[] {
    const tokens = tokenizeQuery(query);
    const matching =
        tokens.length === 0
            ? candidates.slice()
            : candidates.filter((candidate) => matchesAllTokens(candidate.path.toLowerCase(), tokens));
    return matching.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
}