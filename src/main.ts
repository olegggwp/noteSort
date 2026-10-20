import { MarkdownView, Plugin, TFile } from "obsidian";

import { isEditorEditable } from "./editor-position";
import { showError } from "./lib/notify";
import { NotePickerModal } from "./note-picker-modal";
import { ParagraphTransport } from "./paragraph-transport";
import type { ParagraphLookup, ResolvedParagraph } from "./paragraph-transport";
import { clampSwipeThreshold, DEFAULT_SETTINGS, ParagraphSwipeSettingTab } from "./settings";
import type { ParagraphSwipeSettings } from "./settings";
import { SwipeCut } from "./swipe-cut";
import { TouchClaimTracker } from "./touch-claim";
import type { SwipeGesture } from "./touch-claim";

/** Finds the editable source-mode MarkdownView behind a check. */
function isEditableSourceView(view: MarkdownView): boolean {
    return view.getMode() === "source" && isEditorEditable(view.editor);
}

/** The conductor state of the swipe the tracker is currently reporting. */
interface SwipeSession {
    /** The paragraph resolved when the effect started, or a fresh one at the pick. */
    resolved: ResolvedParagraph | null;
    cut: SwipeCut | null;
    /** One failed effect disables it for the rest of the gesture. */
    broken: boolean;
    /** The picker has taken the paragraph over. */
    accepted: boolean;
}

/**
 * Swipe right over a paragraph in the editor to open a compact note picker;
 * the picked note receives the paragraph at its end (separated by one blank
 * line) and the paragraph is removed from the source note.
 *
 * This module is only the conductor: it wires the touch pipeline, the
 * paragraph transport, the picker and the cut effect together and holds the
 * state that connects them — which paragraph a swipe resolved and whether its
 * effect is alive. The claim mechanics live in `TouchClaimTracker`, the
 * content work in `ParagraphTransport`, the visuals in `SwipeCut`, the
 * window-event plumbing in `onload`.
 */
export default class ParagraphSwipePlugin extends Plugin {
    public settings: ParagraphSwipeSettings = { ...DEFAULT_SETTINGS };

    private transport!: ParagraphTransport;
    private tracker!: TouchClaimTracker;

    /** Effect state of each gesture, dying with the gesture object itself. */
    private readonly sessions = new WeakMap<SwipeGesture, SwipeSession>();
    /** The session of the gesture seen last: the scroll safety net uses it. */
    private currentSession: SwipeSession | null = null;

    public async onload(): Promise<void> {
        await this.loadSettings();
        this.addSettingTab(new ParagraphSwipeSettingTab(this.app, this));
        this.transport = new ParagraphTransport(this.app);
        this.tracker = new TouchClaimTracker(this.app, () => this.settings.swipeThresholdPx, {
            findEditableView: (target) => this.findEditableView(target),
            onTravel: (gesture, deltaX) => this.travel(gesture, deltaX, false),
            onCarry: (gesture, deltaX) => this.travel(gesture, deltaX, true),
            onAccepted: (gesture) => this.accept(gesture),
            onAbandoned: (gesture) => this.abandon(gesture),
            onReset: (gesture) => this.reset(gesture),
        });

        this.registerDomEvent(
            window,
            "touchstart",
            (event: TouchEvent) => {
                this.tracker.onTouchStart(event);
            },
            { capture: true, passive: true },
        );
        // passive: false is required — without it the browser treats the
        // listener as passive and preventDefault() inside it is ignored.
        this.registerDomEvent(
            window,
            "touchmove",
            (event: TouchEvent) => {
                this.tracker.onTouchMove(event);
            },
            { capture: true, passive: false },
        );
        this.registerDomEvent(
            window,
            "touchend",
            (event: TouchEvent) => {
                this.tracker.onTouchEnd(event);
            },
            { capture: true, passive: true },
        );
        this.registerDomEvent(
            window,
            "touchcancel",
            (event: TouchEvent) => {
                this.tracker.onTouchCancel(event);
            },
            { capture: true, passive: true },
        );
        // Second channel for the effect: some WebView builds stop delivering
        // touchmove once the gesture is claimed (which is why the threshold is
        // re-checked on touchend); pointer events are generated from the same
        // input pipeline independently, so the block keeps travelling with the
        // finger there. Passive: we only read coordinates.
        this.registerDomEvent(
            window,
            "pointermove",
            (event: PointerEvent) => {
                this.tracker.onPointerMove(event);
            },
            { capture: true, passive: true },
        );
        // Safety net for the cut effect: a claimed swipe blocks scrolling, so
        // any scroll seen while a block is travelling means the viewport moved
        // underneath it (the picker opening, the layout resizing) and the
        // displaced lines have to snap back at once. Capture is what makes the
        // non-bubbling scroll of any element in the document reach the window
        // listener.
        this.registerDomEvent(
            window,
            "scroll",
            () => {
                this.currentSession?.cut?.drop();
            },
            { capture: true, passive: true },
        );
    }

    public onunload(): void {
        this.currentSession?.cut?.drop();
        this.currentSession = null;
    }

    public async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }

    private async loadSettings(): Promise<void> {
        const stored: unknown = await this.loadData();
        this.settings = { ...DEFAULT_SETTINGS };
        if (typeof stored !== "object" || stored === null) {
            return;
        }
        const threshold = (stored as Record<string, unknown>)["swipeThresholdPx"];
        if (typeof threshold === "number" && Number.isFinite(threshold)) {
            this.settings.swipeThresholdPx = clampSwipeThreshold(threshold);
        }
    }

    /**
     * Finds the editable source-mode MarkdownView that contains the touched
     * element. The active view is checked first; the loop over all markdown
     * leaves covers swipes in unfocused split panes.
     */
    private findEditableView(target: Element): MarkdownView | null {
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (active !== null && isEditableSourceView(active) && active.contentEl.contains(target)) {
            return active;
        }
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
            const view = leaf.view;
            if (view instanceof MarkdownView && isEditableSourceView(view) && view.contentEl.contains(target)) {
                return view;
            }
        }
        return null;
    }

    /**
     * Collects (or opens) the effect state of a gesture. The per-gesture map
     * keeps the state from outliving its gesture: every terminal event of the
     * tracker is handled through the same object until the gesture object
     * itself dies.
     */
    private sessionFor(gesture: SwipeGesture): SwipeSession {
        let session = this.sessions.get(gesture);
        if (session === undefined) {
            session = { resolved: null, cut: null, broken: false, accepted: false };
            this.sessions.set(gesture, session);
            this.currentSession = session;
        }
        return session;
    }

    private sessionOf(gesture: SwipeGesture): SwipeSession | null {
        return this.sessions.get(gesture) ?? null;
    }

    /**
     * Carries the effect along the swipe. Touch travel may start the effect
     * (the block leaves the note at the very first pixel of rightward travel,
     * well before the claim); pointer travel may only feed a started block,
     * because the pointer channel runs independently of the touch pipeline
     * and must never claim anything on its own. The whole feedback is
     * optional: one exception disables it for the rest of the gesture.
     */
    private travel(gesture: SwipeGesture, deltaX: number, fromPointer: boolean): void {
        const session = this.sessionFor(gesture);
        if (session.broken || session.accepted) {
            return;
        }
        try {
            if (session.cut === null) {
                if (fromPointer || deltaX < 1) {
                    return; // not a rightward touch travel: nothing to carry away
                }
                this.startEffect(session, gesture, deltaX);
            } else {
                session.cut.feed(deltaX, this.settings.swipeThresholdPx);
            }
        } catch {
            session.broken = true;
            session.cut?.drop();
            session.cut = null;
        }
    }

    /**
     * Cuts the paragraph under the finger out of its note and hands it to the
     * swipe. Everything is measured once, here: from now on the gesture
     * swallows its own touchmove events, so the editor cannot scroll and the
     * block cannot drift away from the finger.
     */
    private startEffect(session: SwipeSession, gesture: SwipeGesture, deltaX: number): void {
        const lookup = this.transport.resolveParagraph(gesture.view, gesture.startX, gesture.startY);
        if (lookup.kind !== "paragraph") {
            return; // a blank line or an unresolvable position under the finger
        }
        // Remembered for the picker: the lines are about to move out from under
        // the start coordinates.
        session.resolved = lookup.paragraph;
        const cut = SwipeCut.attach(
            gesture.view,
            lookup.paragraph.range,
            lookup.paragraph.line,
            gesture.startX,
            gesture.startY,
        );
        if (cut === null) {
            return;
        }
        session.cut = cut;
        cut.feed(deltaX, this.settings.swipeThresholdPx);
    }

    /** The threshold is crossed: the block leaves the note for good, the picker opens. */
    private accept(gesture: SwipeGesture): void {
        const session = this.sessionFor(gesture);
        session.accepted = true;
        session.cut?.detach();
        session.cut = null;
        try {
            this.openPicker(session, gesture);
        } catch (error) {
            showError("internal error", error);
        }
    }

    /** Opens the note picker for the paragraph this gesture started on. */
    private openPicker(session: SwipeSession, gesture: SwipeGesture): void {
        const lookup: ParagraphLookup =
            session.resolved !== null
                ? { kind: "paragraph", paragraph: session.resolved }
                : this.transport.resolveParagraph(gesture.view, gesture.startX, gesture.startY);
        if (lookup.kind !== "paragraph") {
            return;
        }
        const sourceFile = gesture.view.file;
        if (!sourceFile) {
            return;
        }
        const modal = new NotePickerModal(this.app, sourceFile.path, (targetFile: TFile) => {
            void this.transport
                .moveParagraph(gesture.view, lookup.paragraph.range.start, targetFile)
                .catch((error: unknown) => {
                    showError("failed to move the paragraph", error);
                });
        });
        modal.open();
    }

    /** A claimed swipe finished below the threshold: the block glides back. */
    private abandon(gesture: SwipeGesture): void {
        this.sessionOf(gesture)?.cut?.release();
        this.reset(gesture);
    }

    /** The text is about to move: the block snaps back at once. */
    private reset(gesture: SwipeGesture): void {
        const session = this.sessionOf(gesture);
        if (session !== null) {
            session.cut?.drop();
            session.cut = null;
        }
    }
}
