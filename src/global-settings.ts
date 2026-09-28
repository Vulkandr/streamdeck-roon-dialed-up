import streamDeck from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { IconStyle } from "./icons/icon-renderer";

const log = streamDeck.logger.createScope("global-settings");

/**
 * Settings shared by every key (the original plugin's "apply to all
 * actions" settings): the LED icon style and color, and the output most
 * recently picked, used as the default for newly placed keys.
 *
 * Stored with Stream Deck's global settings. The settings panel writes them
 * directly with the standard setGlobalSettings event, and this module hears
 * about it through didReceiveGlobalSettings, so there's a single source of
 * truth either way.
 */
export interface GlobalSettings extends JsonObject {
	iconStyle?: IconStyle;
	customColor?: string;
	lastOutputName?: string;
	/**
	 * The Roon library's saved state (pairing tokens, preferred Core). Kept
	 * here, under the same key the 1.x plugin used, because global settings
	 * survive plugin updates: an upgrade keeps its Roon authorization, so
	 * nobody has to enable the extension in Roon again. Never sent to the
	 * settings panel.
	 */
	roonState?: JsonObject;
}

let current: GlobalSettings = {};
const listeners = new Set<() => void>();

export function getGlobalSettings(): GlobalSettings {
	return current;
}

/** The panel-facing settings: everything except the Roon library's private state. */
export function getPublicGlobalSettings(): GlobalSettings {
	const { roonState: _omit, ...rest } = current;
	return rest;
}

/** Roon library state, synchronous (the library reads and writes it that way). */
export function getRoonState(): JsonObject {
	return current.roonState ?? {};
}

/** Saves Roon library state without notifying listeners (it isn't a setting anyone renders). */
export function setRoonState(state: JsonObject): void {
	current = { ...current, roonState: state };
	void streamDeck.settings.setGlobalSettings(current).catch((err) => log.warn(`couldn't save Roon state: ${err}`));
}

export function getIconStyle(): IconStyle {
	return current.iconStyle ?? "ledGrid";
}

export function getIconColor(): string {
	return current.customColor ?? "#ffffff";
}

/** Fires whenever the global settings change (from the panel or elsewhere). */
export function onGlobalSettingsChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export async function updateGlobalSettings(patch: Partial<GlobalSettings>): Promise<void> {
	current = { ...current, ...patch };
	await streamDeck.settings.setGlobalSettings(current);
	// Stream Deck doesn't echo our own setGlobalSettings back, so notify here.
	for (const listener of listeners) listener();
}

export async function startGlobalSettings(): Promise<void> {
	streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
		current = ev.settings ?? {};
		log.info(`global settings: ${JSON.stringify(current)}`);
		for (const listener of listeners) listener();
	});

	try {
		current = (await streamDeck.settings.getGlobalSettings<GlobalSettings>()) ?? {};
		for (const listener of listeners) listener();
	} catch (err) {
		log.warn(`couldn't load global settings: ${err}`);
	}
}
