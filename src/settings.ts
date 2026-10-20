import { App, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";

import type ParagraphSwipePlugin from "./main";

export interface ParagraphSwipeSettings {
    /** Minimum horizontal finger travel, in pixels, recognized as a swipe. */
    swipeThresholdPx: number;
    /** Show a notice at every step of the swipe pipeline (for diagnostics). */
    debugMode: boolean;
}

export const DEFAULT_SETTINGS: ParagraphSwipeSettings = {
    swipeThresholdPx: 100,
    debugMode: false,
};

export const MIN_SWIPE_THRESHOLD_PX = 20;
export const MAX_SWIPE_THRESHOLD_PX = 600;

export function clampSwipeThreshold(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_SETTINGS.swipeThresholdPx;
    }
    return Math.min(MAX_SWIPE_THRESHOLD_PX, Math.max(MIN_SWIPE_THRESHOLD_PX, Math.round(value)));
}

export class ParagraphSwipeSettingTab extends PluginSettingTab {
    private readonly plugin: ParagraphSwipePlugin;

    constructor(app: App, plugin: ParagraphSwipePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    /**
     * Declarative definitions for Obsidian 1.13+ — the same controls that
     * display() renders below. The framework then renders them itself and
     * feeds the settings search; older app versions keep using display().
     */
    public getSettingDefinitions(): SettingDefinitionItem[] {
        return [
            {
                name: "Swipe threshold",
                desc: "Minimum horizontal finger travel in pixels that opens the note picker when swiping right over a paragraph.",
                control: {
                    key: "swipeThresholdPx",
                    type: "number",
                    defaultValue: DEFAULT_SETTINGS.swipeThresholdPx,
                    placeholder: String(DEFAULT_SETTINGS.swipeThresholdPx),
                    min: MIN_SWIPE_THRESHOLD_PX,
                    max: MAX_SWIPE_THRESHOLD_PX,
                    step: 10,
                },
            },
            {
                name: "Debug notices",
                desc: "Show a toast at every step of the swipe pipeline to diagnose gesture problems.",
                control: {
                    key: "debugMode",
                    type: "toggle",
                    defaultValue: DEFAULT_SETTINGS.debugMode,
                },
            },
        ];
    }

    /** Shared parser for both renderers: numeric input only, clamped. */
    private applyThreshold(value: unknown): boolean {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return false;
        }
        this.plugin.settings.swipeThresholdPx = clampSwipeThreshold(parsed);
        return true;
    }

    /** Keeps the clamping semantics on the declarative path too. */
    public async setControlValue(key: string, value: unknown): Promise<void> {
        if (key === "swipeThresholdPx") {
            if (!this.applyThreshold(value)) {
                return;
            }
        } else if (key === "debugMode") {
            this.plugin.settings.debugMode = value === true;
        } else {
            return;
        }
        await this.plugin.saveSettings();
    }

    public display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Swipe threshold")
            .setDesc(
                "Minimum horizontal finger travel in pixels that opens the note picker when swiping right over a paragraph.",
            )
            .addText((text) => {
                text.setPlaceholder(String(DEFAULT_SETTINGS.swipeThresholdPx));
                text.setValue(String(this.plugin.settings.swipeThresholdPx));
                text.inputEl.type = "number";
                text.inputEl.min = String(MIN_SWIPE_THRESHOLD_PX);
                text.inputEl.max = String(MAX_SWIPE_THRESHOLD_PX);
                text.inputEl.step = "10";
                text.onChange((value) => {
                    if (value.trim().length === 0 || !this.applyThreshold(value)) {
                        return;
                    }
                    void this.plugin.saveSettings();
                });
                return text;
            });

        new Setting(containerEl)
            .setName("Debug notices")
            .setDesc("Show a toast at every step of the swipe pipeline to diagnose gesture problems.")
            .addToggle((toggle) => {
                toggle.setValue(this.plugin.settings.debugMode);
                toggle.onChange((value) => {
                    this.plugin.settings.debugMode = value;
                    void this.plugin.saveSettings();
                });
                return toggle;
            });
    }
}