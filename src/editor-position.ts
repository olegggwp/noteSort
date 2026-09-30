import { Editor, EditorPosition } from "obsidian";

import { findLineIndexAtY, findVisibleLineIndexAtY, type VerticalBounds } from "./lib/coords";

/**
 * Screen-point to editor-position mapping.
 *
 * Which coordinates-related members the published `Editor` typings declare has
 * changed between releases, so this module never touches them through
 * statically typed properties. It probes the runtime objects with structural,
 * `any`-free checks and uses the first strategy that yields a valid position:
 *
 * 1. the editor wrapper's own `posAtCoords` (coords -> EditorPosition);
 * 2. the underlying CodeMirror view (`editor.cm`): CodeMirror 6 returns a
 *    document offset, converted with the public `offsetToPos`; a legacy
 *    CodeMirror 5 wrapper would return an `{ line, ch }` object directly;
 * 3. a scan over rendered lines built on `coordsAtPos`, restricted to the
 *    visible range when `getFirstVisibleLine`/`getLastVisibleLine` exist
 *    (CodeMirror 6 cannot measure unrendered lines).
 *
 * Every probe is wrapped in `safely`: these members are undocumented and vary
 * between app builds, so a runtime exception in one probe must degrade to the
 * next strategy instead of aborting the whole pipeline.
 */

/** A viewport point in CSS pixels. */
interface ScreenPoint {
    readonly x: number;
    readonly y: number;
}

/** An editor position together with the name of the strategy that found it. */
export interface ResolvedPosition {
    readonly position: EditorPosition;
    readonly strategy: string;
}

/** Runs a probing call, converting any runtime exception into null. */
function safely<T>(probe: () => T): T | null {
    try {
        return probe();
    } catch (error) {
        console.warn("Paragraph Swipe: a position probe failed", error);
        return null;
    }
}

/** Reads a property without assuming it exists in the static typings. */
function readProperty(host: object, key: string): unknown {
    return (host as unknown as Record<string, unknown>)[key];
}

/** Returns a property as a function, or null when it is not callable. */
function readFunction(host: object, key: string): ((...args: unknown[]) => unknown) | null {
    const value = readProperty(host, key);
    if (typeof value !== "function") {
        return null;
    }
    return value as (...args: unknown[]) => unknown;
}

/** Returns a property (or zero-argument method) as a finite number, or null. */
function readNumber(host: object, key: string): number | null {
    const value = readProperty(host, key);
    const raw =
        typeof value === "function" ? safely(() => (value as (...args: unknown[]) => unknown).call(host)) : value;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Validates an unknown value as an editor position. */
function asEditorPosition(value: unknown): EditorPosition | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const line = record["line"];
    const ch = record["ch"];
    if (typeof line !== "number" || !Number.isInteger(line) || line < 0) {
        return null;
    }
    if (typeof ch !== "number" || !Number.isFinite(ch) || ch < 0) {
        return null;
    }
    return { line, ch: Math.floor(ch) };
}

/** Validates an unknown value as a vertical bounding box. */
function asVerticalBounds(value: unknown): VerticalBounds | null {
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const top = record["top"];
    const bottom = record["bottom"];
    if (typeof top !== "number" || typeof bottom !== "number" || !Number.isFinite(top) || !Number.isFinite(bottom)) {
        return null;
    }
    return { top, bottom };
}

function posFromEditorWrapper(editor: Editor, point: ScreenPoint): EditorPosition | null {
    const posAtCoords = readFunction(editor, "posAtCoords");
    if (posAtCoords === null) {
        return null;
    }
    return safely(() => asEditorPosition(posAtCoords.call(editor, point)));
}

function posFromCodeMirrorView(editor: Editor, point: ScreenPoint): EditorPosition | null {
    const cmView = readProperty(editor, "cm");
    if (typeof cmView !== "object" || cmView === null) {
        return null;
    }
    const posAtCoords = readFunction(cmView, "posAtCoords");
    if (posAtCoords === null) {
        return null;
    }
    const result = safely(() => posAtCoords.call(cmView, point));
    if (result === null) {
        return null;
    }
    if (typeof result === "number") {
        if (!Number.isFinite(result) || result < 0) {
            return null;
        }
        return safely(() => editor.offsetToPos(result));
    }
    return asEditorPosition(result);
}

function posFromLineScan(editor: Editor, y: number): EditorPosition | null {
    const coordsAtPos = readFunction(editor, "coordsAtPos");
    if (coordsAtPos === null) {
        return null;
    }
    const rectAt = (line: number): VerticalBounds | null =>
        safely(() => asVerticalBounds(coordsAtPos.call(editor, { line, ch: 0 })));
    const firstVisible = readNumber(editor, "getFirstVisibleLine");
    const lastVisible = readNumber(editor, "getLastVisibleLine");
    const line =
        firstVisible !== null && lastVisible !== null
            ? findVisibleLineIndexAtY(firstVisible, lastVisible, y, rectAt)
            : findLineIndexAtY(editor.lineCount(), y, rectAt);
    return line === null ? null : { line, ch: 0 };
}

/**
 * Resolves the editor position displayed at the given viewport coordinates,
 * or null if none of the strategies can determine it.
 */
export function posAtClientPoint(editor: Editor, x: number, y: number): ResolvedPosition | null {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    const point: ScreenPoint = { x, y };
    const fromWrapper = posFromEditorWrapper(editor, point);
    if (fromWrapper !== null) {
        return { position: fromWrapper, strategy: "editor.posAtCoords" };
    }
    const fromCodeMirror = posFromCodeMirrorView(editor, point);
    if (fromCodeMirror !== null) {
        return { position: fromCodeMirror, strategy: "editor.cm.posAtCoords" };
    }
    const fromScan = posFromLineScan(editor, y);
    if (fromScan !== null) {
        return { position: fromScan, strategy: "coordsAtPos line scan" };
    }
    return null;
}

/**
 * Human-readable availability of the runtime members the strategies rely on;
 * used by the debug notices to diagnose position-resolution failures.
 */
export function describePositionStrategies(editor: Editor): string {
    const wrapperPos = readFunction(editor, "posAtCoords") !== null;
    const cm = readProperty(editor, "cm");
    const cmPresent = typeof cm === "object" && cm !== null;
    const cmPos = cmPresent ? readFunction(cm, "posAtCoords") !== null : false;
    const coordsAtPos = readFunction(editor, "coordsAtPos") !== null;
    const firstVisible = readNumber(editor, "getFirstVisibleLine");
    const lastVisible = readNumber(editor, "getLastVisibleLine");
    return [
        `editor.posAtCoords: ${wrapperPos ? "yes" : "no"}`,
        `editor.cm: ${cmPresent ? "yes" : "no"}`,
        `cm.posAtCoords: ${cmPos ? "yes" : "no"}`,
        `editor.coordsAtPos: ${coordsAtPos ? "yes" : "no"}`,
        `visible lines: ${firstVisible}/${lastVisible}`,
    ].join(", ");
}

/**
 * Returns true when the editor accepts edits. `getEditable` is probed
 * structurally (it is absent from some typings releases); when the method
 * cannot be found at runtime the editor is assumed editable.
 */
export function isEditorEditable(editor: Editor): boolean {
    const getEditable = readFunction(editor, "getEditable");
    return getEditable === null ? true : Boolean(safely(() => getEditable.call(editor)));
}