import streamDeck, {
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	type KeyUpEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { getIconColor, getIconStyle, onGlobalSettingsChanged } from "../global-settings";
import { composeKeyImage, styledIconBody } from "../icons/key-image";
import { findOutput, getTransport, onStatusChanged, onZonesChanged, type RoonOutput } from "../roon-connection";

const log = streamDeck.logger.createScope("roon-action");

/** Settings every Roon key shares. */
export interface RoonKeySettings extends JsonObject {
	outputId?: string;
	outputName?: string;
	/** "Dim when action not available" (defaults to on, as before). */
	disableWhenUnavailable?: boolean;
	/** Typeface for any text drawn on the key ("classic" or "condensed"). */
	textFont?: string;
}

/**
 * Base for every Roon-controlling key action: the port of the original
 * plugin's ActionBase onto the SDK's SingletonAction model.
 *
 * One instance handles every placed copy of an action, so per-key state
 * (settings, timers) is kept in maps keyed by the key's id. Subclasses
 * override `iconName` (which LED icon to draw), `isAvailable()` (when the
 * key should dim), and the key press handlers, and get transport helpers
 * and styled-icon rendering from here.
 */
export abstract class RoonAction<TSettings extends RoonKeySettings = RoonKeySettings> extends SingletonAction<TSettings> {
	protected readonly settingsByKey = new Map<string, TSettings>();

	constructor() {
		super();
		onZonesChanged((seekOnly) => {
			if (!seekOnly || this.rendersOnSeek) {
				this.refreshAll();
			}
		});
		onStatusChanged(() => this.refreshAll());
		onGlobalSettingsChanged(() => this.refreshAll());
	}

	/** The LED icon this action shows (null: uses the manifest image only). */
	protected get iconName(): string | null {
		return null;
	}

	/** Whether playback-position updates (every second) should re-render. */
	protected get rendersOnSeek(): boolean {
		return false;
	}

	// ---- lifecycle -------------------------------------------------------

	override async onWillAppear(ev: WillAppearEvent<TSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsByKey.set(ev.action.id, ev.payload.settings);
		await this.render(ev.action, ev.payload.settings);
	}

	override onWillDisappear(ev: WillDisappearEvent<TSettings>): void {
		this.settingsByKey.delete(ev.action.id);
		this.onKeyRemoved(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<TSettings>): Promise<void> {
		if (!ev.action.isKey()) return;
		this.settingsByKey.set(ev.action.id, ev.payload.settings);
		this.onSettingsUpdated(ev.action.id, ev.payload.settings);
		await this.render(ev.action, ev.payload.settings);
	}

	/** Hook for subclasses with per-key resources (timers, caches). */
	protected onKeyRemoved(_keyId: string): void {}

	protected onSettingsUpdated(_keyId: string, _settings: TSettings): void {}

	// ---- rendering -------------------------------------------------------

	protected refreshAll(): void {
		for (const action of this.actions) {
			if (action.isKey()) {
				void this.render(action, this.settingsByKey.get(action.id) ?? ({} as TSettings));
			}
		}
	}

	protected outputFor(settings: TSettings): RoonOutput | null {
		return findOutput(settings.outputId, settings.outputName);
	}

	/** Whether the action can currently do anything (drives dimming). */
	protected isAvailable(output: RoonOutput | null, _settings: TSettings): boolean {
		return output !== null;
	}

	/**
	 * Default rendering: the styled icon, dimmed when unavailable and the
	 * person asked for that. Subclasses with richer images override this.
	 */
	protected async render(action: KeyAction<TSettings>, settings: TSettings): Promise<void> {
		const output = this.outputFor(settings);
		const available = this.isAvailable(output, settings);
		await this.setStateFor(action, output, settings);
		await action.setImage(this.styledImage(settings, !available));
	}

	/** Hook for two-state actions (mute, shuffle, loops, radio). */
	protected async setStateFor(_action: KeyAction<TSettings>, _output: RoonOutput | null, _settings: TSettings): Promise<void> {}


	/**
	 * The styled icon as a data URI, or undefined for Classic style (so the
	 * manifest image shows). `dim` applies only when the key's "dim when
	 * unavailable" setting is on (default), matching the original.
	 */
	protected styledImage(settings: TSettings, dim: boolean, iconName: string | null = this.iconName): string | undefined {
		const dimmed = dim && settings.disableWhenUnavailable !== false;
		const body = styledIconBody(iconName, getIconStyle(), getIconColor(), dimmed);
		if (body === undefined) {
			return dimmed ? this.classicDisabledImage() : undefined;
		}
		return composeKeyImage({ base: { svgBody: body } });
	}

	/** Classic-style dimmed image (the original plugin's *-key-disabled PNGs). */
	protected classicDisabledImage(): string | undefined {
		return undefined;
	}

	protected styledIconBodyFor(iconName: string | null, dim = false): string | undefined {
		return styledIconBody(iconName, getIconStyle(), getIconColor(), dim);
	}

	// ---- key presses -----------------------------------------------------

	override async onKeyDown(_ev: KeyDownEvent<TSettings>): Promise<void> {}

	override async onKeyUp(_ev: KeyUpEvent<TSettings>): Promise<void> {}

	/**
	 * For multi-actions: Stream Deck tells us the state the person wants;
	 * otherwise toggle from the current one. Ported as-is.
	 */
	protected toggleDesiredState(payload: { state?: number; userDesiredState?: number }): number {
		if (payload.userDesiredState !== undefined) {
			return payload.userDesiredState;
		}
		return payload.state === 0 ? 1 : 0;
	}

	// ---- Roon transport helpers -----------------------------------------

	protected transportControl(action: KeyAction<TSettings>, output: RoonOutput | null, control: string): void {
		const transport = getTransport();
		if (!transport || !output) {
			log.info(`${this.manifestId}: transport control unavailable`);
			void action.showAlert();
			return;
		}
		transport.control(output.outputId, control, (err: unknown) => {
			if (err) {
				log.warn(`${this.manifestId}: control "${control}" failed: ${err}`);
				void action.showAlert();
			}
		});
	}

	protected transportSeek(action: KeyAction<TSettings>, output: RoonOutput | null, how: string, seconds: number): void {
		const transport = getTransport();
		if (!transport || !output) {
			void action.showAlert();
			return;
		}
		transport.seek(output.outputId, how, seconds, (err: unknown) => {
			if (err) {
				log.warn(`${this.manifestId}: seek failed: ${err}`);
				void action.showAlert();
			}
		});
	}

	protected transportSetting(action: KeyAction<TSettings>, output: RoonOutput | null, settings: Record<string, unknown>): void {
		const transport = getTransport();
		if (!transport || !output) {
			void action.showAlert();
			return;
		}
		transport.change_settings(output.outputId, settings, (err: unknown) => {
			if (err) {
				log.warn(`${this.manifestId}: change_settings failed: ${err}`);
				void action.showAlert();
			}
		});
	}

	protected changeVolume(action: KeyAction<TSettings>, output: RoonOutput | null, how: string, value: number, onOk?: () => void): void {
		const transport = getTransport();
		if (!transport || !output) {
			void action.showAlert();
			return;
		}
		transport.change_volume(output.outputId, how, value, (err: unknown) => {
			if (err) {
				log.warn(`${this.manifestId}: change_volume failed: ${err}`);
				void action.showAlert();
			} else {
				onOk?.();
			}
		});
	}

	protected mute(action: KeyAction<TSettings>, output: RoonOutput | null, mute: boolean): void {
		const transport = getTransport();
		if (!transport || !output) {
			void action.showAlert();
			return;
		}
		transport.mute(output.outputId, mute ? "mute" : "unmute", (err: unknown) => {
			if (err) {
				log.warn(`${this.manifestId}: mute failed: ${err}`);
				void action.showAlert();
			}
		});
	}
}

/**
 * Playback progress estimate, ported from the original: records a baseline
 * whenever Roon sends a position, then extrapolates while playing so the
 * bar moves smoothly between updates.
 */
export class ProgressTracker {
	private state: string | undefined;
	private baseSeek = 0;
	private baseTime = 0;
	private trackLength = 0;

	update(output: RoonOutput): void {
		this.state = output.state;
		if (output.seekPosition !== undefined && output.trackLength) {
			this.baseSeek = output.seekPosition;
			this.baseTime = Date.now();
			this.trackLength = output.trackLength;
		} else {
			this.trackLength = 0;
		}
	}

	percent(): number {
		if (!this.trackLength) {
			return 0;
		}
		let elapsed = this.baseSeek;
		if (this.state === "playing") {
			elapsed += (Date.now() - this.baseTime) / 1000;
		}
		return Math.max(0, Math.min(100, Math.round((elapsed / this.trackLength) * 100)));
	}
}
