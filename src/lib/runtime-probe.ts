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

/** True for real objects: typeof null is "object" in JS, so null is checked separately. */
export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function readProperty(host: object, key: string): unknown {
    return (host as unknown as Record<string, unknown>)[key];
}

/** Reads a property as a real object, or null. */
export function readObject(host: object, key: string): Record<string, unknown> | null {
    const value = readProperty(host, key);
    return isObject(value) ? value : null;
}

/** Returns a property as a function, or null when it is not callable. */
export function readFunction(host: object, key: string): ((...args: unknown[]) => unknown) | null {
    const value = readProperty(host, key);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : null;
}

/** Returns a property (or zero-argument method) as a finite number, or null. */
export function readNumber(host: object, key: string): number | null {
    const callable = readFunction(host, key);
    const raw = callable === null ? readProperty(host, key) : safely(() => callable.call(host));
    return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/**
 * Returns a property as an element, or null when it is not one. The check is
 * structural rather than `instanceof`, so elements coming from another
 * browsing context (an Obsidian popout window) are still recognized.
 */
export function readElement(host: object, key: string): HTMLElement | null {
    const value = readObject(host, key);
    if (value === null || typeof value["getBoundingClientRect"] !== "function") {
        return null;
    }
    return value as unknown as HTMLElement;
}
