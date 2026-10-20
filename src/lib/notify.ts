import { Notice } from "obsidian";

/** Human-readable message of an unknown thrown value. */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * A user-facing failure report for a swallowed exception: the pipeline keeps
 * running, the reason surfaces as a notice. This is feedback, not logging —
 * the plugin never writes to the console.
 */
export function showError(title: string, error: unknown): void {
    new Notice(`Paragraph Swipe: ${title} — ${describeError(error)}`);
}
