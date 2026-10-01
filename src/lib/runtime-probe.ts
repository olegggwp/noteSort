/**
 * Structural probes for runtime members that the published Obsidian typings
 * do not declare (or declared only in some releases).
 *
 * These members are undocumented and vary between app builds, so every read
 * goes through `safely`: a runtime exception in one probe must degrade
 * gracefully instead of aborting the whole gesture pipeline.
 *
 * No imports: the helpers depend on nothing but the DOM globals.
 */

/** Runs a probing call, converting any runtime exception into null. */
export function safely<T>(probe: () => T): T | null {
    try {
        return probe();
    } catch (error) {
        console.warn("Paragraph Swipe: a runtime probe failed", error);
        return null;
    }
}

/** Reads a property without assuming it exists in the static typings. */
export function readProperty(host: object, key: string): unknown {
    return (host as unknown as Record<string, unknown>)[key];
}

/** Returns a property as a function, or null when it is not callable. */
export function readFunction(host: object, key: string): ((...args: unknown[]) => unknown) | null {
    const value = readProperty(host, key);
    if (typeof value !== "function") {
        return null;
    }
    return value as (...args: unknown[]) => unknown;
}

/** Returns a property (or zero-argument method) as a finite number, or null. */
export function readNumber(host: object, key: string): number | null {
    const value = readProperty(host, key);
    const raw =
        typeof value === "function" ? safely(() => (value as (...args: unknown[]) => unknown).call(host)) : value;
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Returns a property as an element, or null when it is not one. The check is
 * structural rather than `instanceof`, so elements coming from another
 * browsing context (an Obsidian popout window) are still recognized.
 */
export function readElement(host: object, key: string): HTMLElement | null {
    const value = readProperty(host, key);
    if (typeof value !== "object" || value === null) {
        return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record["getBoundingClientRect"] !== "function") {
        return null;
    }
    return value as HTMLElement;
}
