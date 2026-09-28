import { action, type DidReceiveSettingsEvent, type KeyAction, type KeyUpEvent, SingletonAction, type WillAppearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { CANVAS, svgDataUri, wrapSvg } from "../icons/icon-renderer";
import { fitText } from "../icons/key-image";
import { measureText, type TextFont, textFontOf, textPath } from "../icons/text-paths";
import { type ConnectionStatus, getConnectionStatus, getPairedCore, onCoresChanged, onStatusChanged } from "../roon-connection";

/** Text size under the light: the same as the touch strip's two-row title. */
const NAME_SIZE = 18;

export interface StatusSettings extends JsonObject {
	/** Show the Core's name (or the current state) under the light. Off by default. */
	showName?: boolean;
	textFont?: TextFont;
}

/**
 * Connection status key: a light that's green while paired with a Core,
 * amber while getting there (searching, connecting, waiting for approval
 * in Roon), red when something's wrong. Optionally the Core's name
 * underneath, wrapped across lines so it fits.
 */
@action({ UUID: "com.vulkan.roon-dialed-up.status" })
export class StatusAction extends SingletonAction<StatusSettings> {
	private readonly settingsByKey = new Map<string, StatusSettings>();

	constructor() {
		super();
		onStatusChanged(() => this.refreshAll());
		onCoresChanged(() => this.refreshAll());
	}

	override async onWillAppear(ev: WillAppearEvent<StatusSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsByKey.set(ev.action.id, ev.payload.settings);
		await ev.action.setTitle("");
		await this.render(ev.action, ev.payload.settings);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<StatusSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsByKey.set(ev.action.id, ev.payload.settings);
		await this.render(ev.action, ev.payload.settings);
	}

	override async onKeyUp(ev: KeyUpEvent<StatusSettings>): Promise<void> {
		// A press just redraws: a quick way to confirm the plugin is alive.
		await this.render(ev.action, ev.payload.settings);
	}

	private refreshAll(): void {
		for (const a of this.actions) {
			if (a.isKey()) void this.render(a, this.settingsByKey.get(a.id) ?? {});
		}
	}

	private async render(action: KeyAction<StatusSettings>, settings: StatusSettings): Promise<void> {
		const status = getConnectionStatus();
		const font = textFontOf(settings);
		const lines = settings.showName === true ? wrapWords(labelFor(status), 3, CANVAS - 16, NAME_SIZE, font) : [];
		await action.setImage(statusKeyImage(colorFor(status.phase), lines, font));
	}
}

function colorFor(phase: ConnectionStatus["phase"]): string {
	switch (phase) {
		case "paired":
			return "#4ade80";
		case "error":
		case "unpaired":
		case "connection-closed":
			return "#f26d6d";
		default:
			return "#f5b64a";
	}
}

function labelFor(status: ConnectionStatus): string {
	switch (status.phase) {
		case "paired":
			return getPairedCore()?.name ?? status.detail ?? "Connected";
		case "awaiting-approval":
			return "Enable in Roon";
		case "connecting":
			return "Connecting";
		case "connection-closed":
			return "Reconnecting";
		case "unpaired":
			return "Disconnected";
		case "error":
			return "Error";
		default:
			return "Searching";
	}
}

/** Greedy word wrap using real text metrics; a lone word that's too long gets an ellipsis. */
export function wrapWords(text: string, maxLines: number, maxWidth: number, size: number, font: TextFont = "condensed"): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const candidate = current ? `${current} ${word}` : word;
		if (measureText(candidate, size, true, font) <= maxWidth) {
			current = candidate;
		} else {
			if (current) lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);

	const out = lines.slice(0, maxLines).map((line) => fitText(line, maxWidth, size, true, font));
	if (lines.length > maxLines) {
		out[maxLines - 1] = fitText(`${out[maxLines - 1]}…`, maxWidth, size, true, font);
	}
	return out;
}

/**
 * The key image: a lit indicator (soft glow, bright center), and optional
 * text lines under it. Everything is vector so it stays crisp.
 */
export function statusKeyImage(color: string, lines: string[], font: TextFont = "condensed"): string {
	const hasText = lines.length > 0;
	const cx = CANVAS / 2;
	const cy = hasText ? 42 : CANVAS / 2;
	const r = hasText ? 16 : 24;
	const bgRadius = CANVAS * 0.16;

	let body = `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${bgRadius}" ry="${bgRadius}" fill="#000000"/>`;
	body += `<defs><radialGradient id="glow"><stop offset="0" stop-color="${color}" stop-opacity="0.55"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>`;
	body += `<circle cx="${cx}" cy="${cy}" r="${r * 2.2}" fill="url(#glow)"/>`;
	body += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
	body += `<circle cx="${cx - r * 0.3}" cy="${cy - r * 0.3}" r="${r * 0.35}" fill="#ffffff" fill-opacity="0.35"/>`;

	if (hasText) {
		const size = NAME_SIZE;
		const lineHeight = 21;
		const top = cy + r + 12 + size / 2;
		lines.forEach((line, i) => {
			const d = textPath(line, cx, top + i * lineHeight, size, true, "middle", font);
			if (d) {
				body += `<path d="${d}" fill="none" stroke="#000000" stroke-width="3" stroke-linejoin="round"/><path d="${d}" fill="#ffffff"/>`;
			}
		});
	}

	return svgDataUri(wrapSvg(body));
}
