import streamDeck, {
	action,
	type DialAction,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { ProgressTracker } from "./roon-action";
import { formatVolume } from "./volume-set";
import { MuteOnDialImage } from "../data-images/mute-on-dial-image";
import { RoonEncoderFeedback } from "../data-images/roon-encoder-feedback";
import { RoonEncoderKeyFeedback } from "../data-images/roon-encoder-key-feedback";
import { TransparentPixel } from "../data-images/transparent-pixel";
import { VolumeDisabledEncoderFeedback } from "../data-images/volume-disabled-encoder-feedback";
import { getIconColor, getIconStyle, onGlobalSettingsChanged } from "../global-settings";
import { IconCells } from "../icons/icon-cells";
import { renderIconPng } from "../icons/icon-renderer";
import { renderStripText, svgToPng } from "../icons/raster";
import { textFontOf } from "../icons/text-paths";
import { findOutput, getImage, getTransport, onStatusChanged, onZonesChanged, type RoonOutput } from "../roon-connection";

const log = streamDeck.logger.createScope("encoder");
const P = "com.vulkan.roon-dialed-up";

export interface EncoderSettings extends JsonObject {
	outputId?: string;
	outputName?: string;
	showAlbumArt?: boolean;
	showLogo?: boolean;
	/** Typeface for the strip's text ("classic" or "condensed"). */
	textFont?: string;
	albumArtTransparency?: number;
	uiTransparency?: number;
	titleMode?: "off" | "output" | "track";
	progressBarMode?: "off" | "replace" | "separate";
	textColor?: string;
	barColor?: string;
	/** Adjust Volume only: what a press/tap does. */
	buttonPressMode?: "mute" | "playpause";
	/** Player Controls only. */
	showVolume?: boolean;
}

interface DialState {
	settings: EncoderSettings;
	layoutMode: "normal" | "disabled" | null;
	layoutKey: string | null;
	artKey: string | null;
	artDataUri: string;
	isMuted: boolean;
	isAllMuted: boolean;
	progress: ProgressTracker;
}

/**
 * Port of VolumeEncoderAction (the "Adjust Volume" dial): rotate for
 * volume, press/tap to mute or play/pause, hold to mute everything. The
 * touch strip shows title, icon, volume and bars laid out dynamically from
 * the Screen settings, with optional album art behind it.
 */
@action({ UUID: `${P}.volume-encoder` })
export class VolumeEncoderAction extends SingletonAction<EncoderSettings> {
	protected readonly dials = new Map<string, DialState>();
	private volumeDisabledIcon = VolumeDisabledEncoderFeedback;

	constructor() {
		super();
		this.refreshVolumeDisabledIcon();
		onZonesChanged((seekOnly) => this.refreshAll(seekOnly));
		onStatusChanged(() => this.refreshAll(false));
		onGlobalSettingsChanged(() => {
			this.refreshVolumeDisabledIcon();
			this.refreshAll(false);
		});
	}

	/** Player Controls keeps its normal icon even when the zone has no volume. */
	protected get showVolumeDisabledIconWhenUnavailable(): boolean {
		return true;
	}

	// ---- lifecycle -------------------------------------------------------

	protected stateFor(id: string, settings?: EncoderSettings): DialState {
		let s = this.dials.get(id);
		if (!s) {
			s = {
				settings: settings ?? {},
				layoutMode: null,
				layoutKey: null,
				artKey: null,
				artDataUri: TransparentPixel,
				isMuted: false,
				isAllMuted: false,
				progress: new ProgressTracker(),
			};
			this.dials.set(id, s);
		}
		if (settings) s.settings = settings;
		return s;
	}

	override async onWillAppear(ev: WillAppearEvent<EncoderSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		state.layoutMode = null;
		// The native Title field has no effect on this action's display, so
		// it's set to a plain label rather than left looking editable.
		await ev.action.setTitle("Disabled");
		await this.updateTriggerDescription(ev.action, state.settings);
		await this.render(ev.action, state, false);
	}

	override onWillDisappear(ev: WillDisappearEvent<EncoderSettings>): void {
		this.dials.delete(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<EncoderSettings>): Promise<void> {
		if (!ev.action.isDial()) return;
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		// Opacity/enabled values are baked into the layout itself, so force it
		// to be rebuilt on the next update.
		state.layoutMode = null;
		await this.updateTriggerDescription(ev.action, state.settings);
		await this.render(ev.action, state, false);
	}

	protected refreshAll(seekOnly: boolean): void {
		for (const a of this.actions) {
			if (!a.isDial()) continue;
			const state = this.dials.get(a.id);
			if (state) void this.render(a, state, seekOnly);
		}
	}

	// ---- input -------------------------------------------------------------

	override async onDialUp(ev: DialUpEvent<EncoderSettings>): Promise<void> {
		this.primaryPress(ev.action, this.stateFor(ev.action.id, ev.payload.settings));
	}

	override async onDialRotate(ev: DialRotateEvent<EncoderSettings>): Promise<void> {
		this.setVolume(ev.action, this.stateFor(ev.action.id, ev.payload.settings), ev.payload.ticks);
	}

	override async onTouchTap(ev: TouchTapEvent<EncoderSettings>): Promise<void> {
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		if (ev.payload.hold) {
			if (state.settings.buttonPressMode === "playpause") {
				// Muting every zone doesn't make sense as a side effect of a
				// dial that's primarily being used for playback control.
				this.toggleMute(ev.action, state);
			} else {
				this.toggleMuteAll(ev.action, state);
			}
		} else {
			this.primaryPress(ev.action, state);
		}
	}

	protected primaryPress(dial: DialAction<EncoderSettings>, state: DialState): void {
		if (state.settings.buttonPressMode === "playpause") {
			this.control(dial, state, "playpause");
		} else {
			this.toggleMute(dial, state);
		}
	}

	protected output(state: DialState): RoonOutput | null {
		return findOutput(state.settings.outputId, state.settings.outputName);
	}

	protected control(dial: DialAction<EncoderSettings>, state: DialState, control: string): void {
		const transport = getTransport();
		const output = this.output(state);
		if (!transport || !output) {
			void dial.showAlert();
			return;
		}
		transport.control(output.outputId, control, (err: unknown) => {
			if (err) void dial.showAlert();
		});
	}

	private setVolume(dial: DialAction<EncoderSettings>, state: DialState, ticks: number): void {
		const transport = getTransport();
		const output = this.output(state);
		if (!transport || !output?.volume) {
			void dial.showAlert();
			return;
		}
		const step = (output.volume.step ?? 1) * ticks;
		transport.change_volume(output.outputId, "relative_step", step, (err: unknown) => {
			if (err) void dial.showAlert();
		});
	}

	protected toggleMute(dial: DialAction<EncoderSettings>, state: DialState): void {
		const transport = getTransport();
		const output = this.output(state);
		if (!transport || !output) {
			void dial.showAlert();
			return;
		}
		transport.mute(output.outputId, state.isMuted ? "unmute" : "mute", (err: unknown) => {
			if (err) void dial.showAlert();
		});
	}

	private toggleMuteAll(dial: DialAction<EncoderSettings>, state: DialState): void {
		const transport = getTransport();
		if (!transport) {
			void dial.showAlert();
			return;
		}
		const mute = !state.isAllMuted;
		transport.mute_all(mute ? "mute" : "unmute", (err: unknown) => {
			if (err) void dial.showAlert();
			else state.isAllMuted = mute;
		});
	}

	protected async updateTriggerDescription(dial: DialAction<EncoderSettings>, settings: EncoderSettings): Promise<void> {
		const isPlayPause = settings.buttonPressMode === "playpause";
		await dial.setTriggerDescription({
			rotate: "Adjust volume",
			push: isPlayPause ? "Play/Pause" : "Mute/unmute",
			touch: isPlayPause ? "Play/Pause" : "Mute/unmute",
			longTouch: isPlayPause ? "Mute/unmute" : "Mute/unmute all zones",
		});
	}

	// ---- rendering -------------------------------------------------------

	protected async render(dial: DialAction<EncoderSettings>, state: DialState, seekOnly: boolean): Promise<void> {
		const output = this.output(state);
		const settings = state.settings;

		if (!seekOnly) {
			// The physical dial's key image: always the Roon branding (or the
			// mute icon), regardless of Show Logo.
			state.isMuted = output?.volume?.isMuted === true;
			await dial.setImage(state.isMuted ? MuteOnDialImage : RoonEncoderKeyFeedback);
		}

		if (!output) {
			return;
		}

		const payload: Record<string, unknown> = {};
		await this.ensureLayout(dial, state, "normal");

		const showLogo = settings.showLogo !== false;
		const titleMode = settings.titleMode ?? "output";
		const twoRowTitle = titleMode === "track" && !showLogo;
		const textColor = settings.textColor ?? "#ffffff";

		// Text on the strip is rendered by the plugin in its own font (the
		// strip's built-in text items can't choose one), so each text item in
		// the layout is a pixmap sized to the same rect the text used to
		// occupy. The rects come from the layout so the two always agree.
		const rects = this.textRects(settings);
		const font = textFontOf(settings);
		const text = async (key: string, value: string, color: string, size: number) => {
			const rect = rects[key];
			if (!rect) return;
			const png = await renderStripText(value, {
				width: rect.w, height: rect.h, size, bold: true, color, align: rect.align, font,
			});
			if (png) payload[key] = png;
		};

		if (twoRowTitle) {
			const lines = this.titleLines(output);
			await text("displayTitle", lines.line1, textColor, rects.displayTitle?.size ?? 18);
			await text("songTitle", lines.line2, textColor, rects.songTitle?.size ?? 18);
		} else {
			await text("displayTitle", this.titleText(output, settings), textColor, rects.displayTitle?.size ?? 16);
		}

		// Album art behind everything, kept in sync with the current track.
		const showAlbumArt = settings.showAlbumArt === true;
		const imageKey = showAlbumArt ? (output.imageKey ?? null) : null;
		if (imageKey !== state.artKey) {
			state.artKey = imageKey;
			if (imageKey) {
				void this.fetchAlbumArt(dial, state, imageKey);
			} else {
				state.artDataUri = TransparentPixel;
			}
		}
		payload.background = showAlbumArt ? state.artDataUri : TransparentPixel;

		const hasVolume = !!output.volume;
		if (hasVolume) {
			if (state.isMuted) {
				await text("value", "MUTED", "#ff3b30", rects.value?.size ?? 24);
			} else {
				await text("value", formatVolume(output.volume!), textColor, rects.value?.size ?? 24);
			}

			const range = output.volume!.max - output.volume!.min;
			const percent = range > 0 ? ((output.volume!.value - output.volume!.min) / range) * 100 : 0;
			const progressBarMode = settings.progressBarMode ?? "off";
			if (progressBarMode === "off" || progressBarMode === "separate") {
				payload.indicator = { value: Math.round(percent), enabled: true };
				payload.range = { min: output.volume!.min, max: output.volume!.max };
			}
		} else {
			await text("value", "N/A", textColor, rects.value?.size ?? 24);
			payload.indicator = { value: 0, enabled: false };
		}

		const progressBarMode = settings.progressBarMode ?? "off";
		if (progressBarMode === "replace" || progressBarMode === "separate") {
			state.progress.update(output);
			payload.progress = state.progress.percent();
		}

		if (showLogo) {
			if (!hasVolume && this.showVolumeDisabledIconWhenUnavailable) {
				payload.icon = this.volumeDisabledIcon;
			} else {
				payload.icon = state.isMuted ? MuteOnDialImage : RoonEncoderFeedback;
			}
		}

		await dial.setFeedback(payload as any);
	}

	private titleText(output: RoonOutput, settings: EncoderSettings): string {
		const titleMode = settings.titleMode ?? "output";
		if (titleMode === "off") return "";
		if (titleMode === "track" && output.artistName && output.songName) {
			return `${output.artistName} - ${output.songName}`;
		}
		return output.displayName;
	}

	private titleLines(output: RoonOutput): { line1: string; line2: string } {
		if (output.artistName && output.songName) {
			return { line1: output.artistName, line2: output.songName };
		}
		return { line1: output.displayName, line2: "" };
	}

	private async fetchAlbumArt(dial: DialAction<EncoderSettings>, state: DialState, imageKey: string): Promise<void> {
		try {
			// Same as the original: fetch the full, undistorted image, then
			// center-crop it to cover the strip's 2:1 background. Roon's own
			// "fill" scaling doesn't produce the same crop, so it's done here.
			const source = await getImage(imageKey, { scale: "fit", width: 400, height: 400, format: "image/jpeg" });
			const cropped = await svgToPng(
				`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200">` +
					`<image href="${source}" x="0" y="0" width="400" height="200" preserveAspectRatio="xMidYMid slice"/></svg>`,
			);
			if (state.artKey === imageKey) {
				state.artDataUri = cropped ?? TransparentPixel;
				await this.render(dial, state, false);
			}
		} catch (err) {
			log.warn(`album art fetch failed: ${err}`);
			if (state.artKey === imageKey) {
				state.artDataUri = TransparentPixel;
			}
		}
	}

	private refreshVolumeDisabledIcon(): void {
		// Volume-Disabled always renders in plain LED (no grid) with its red X
		// overlay; Classic falls back to the static image.
		if (getIconStyle() === "classic") {
			this.volumeDisabledIcon = VolumeDisabledEncoderFeedback;
			return;
		}
		this.volumeDisabledIcon = renderIconPng(IconCells["volume-disabled"], {
			color: getIconColor(),
			style: "led",
			iconName: "volume-disabled",
			overlayCells: IconCells["volume-disabled-x"],
			overlayColor: "#ff2d2d",
			overlayBrightness: 0.7,
		});
	}

	// ---- layouts ---------------------------------------------------------

	private async ensureLayout(dial: DialAction<EncoderSettings>, state: DialState, mode: "normal" | "disabled"): Promise<void> {
		const key = this.layoutSettingsKey(state.settings);
		if (state.layoutMode !== mode || state.layoutKey !== key) {
			// Stream Deck accepts an inline layout object here (the original
			// plugin relied on that too); the SDK's type only mentions strings.
			// Strip the plugin-side text metadata off pixmap items before the
			// layout goes to Stream Deck, so it only ever sees schema-valid items.
			const layout = mode === "normal" ? this.cleanLayout(this.buildLayout(state.settings)) : "$A1";
			await dial.setFeedbackLayout(layout as any);
			state.layoutMode = mode;
			state.layoutKey = key;
		}
	}

	/**
	 * Geometry of each text-as-pixmap item in the current layout, keyed by
	 * item key: what render() needs to draw text that lands exactly where
	 * the layout puts it.
	 */
	protected textRects(settings: EncoderSettings): Record<string, { w: number; h: number; size: number; align: "left" | "center" | "right" }> {
		const layout = this.buildLayout(settings) as { items: any[] };
		const rects: Record<string, { w: number; h: number; size: number; align: "left" | "center" | "right" }> = {};
		for (const item of layout.items) {
			if (item.type === "pixmap" && item.font) {
				rects[item.key] = { w: item.rect[2], h: item.rect[3], size: item.font.size, align: item.alignment ?? "center" };
			}
		}
		return rects;
	}

	private cleanLayout(layout: object): object {
		const { items, ...rest } = layout as { items: any[] };
		return {
			...rest,
			items: items.map((item) => {
				if (item.type !== "pixmap") return item;
				const { font: _font, alignment: _alignment, ...clean } = item;
				return clean;
			}),
		};
	}

	protected layoutSettingsKey(settings: EncoderSettings): string {
		return [
			settings.showAlbumArt === true,
			settings.showLogo !== false,
			settings.albumArtTransparency,
			settings.uiTransparency,
			settings.progressBarMode ?? "off",
			settings.titleMode ?? "output",
			settings.barColor ?? "#ffffff",
		].join("|");
	}

	protected toOpacity(value: unknown, defaultValue: number): number {
		const raw = value !== undefined ? Number(value) : defaultValue;
		const percent = Math.max(0, Math.min(100, Math.round(raw / 10) * 10));
		return percent / 100;
	}

	protected buildLayout(settings: EncoderSettings): object {
		const albumArtOpacity = this.toOpacity(settings.albumArtTransparency, 50);
		const uiOpacity = this.toOpacity(settings.uiTransparency, 100);
		const progressBarMode = settings.progressBarMode ?? "off";
		const showLogo = settings.showLogo !== false;
		const titleMode = settings.titleMode ?? "output";
		const twoRowTitle = titleMode === "track" && !showLogo;

		const background = { key: "background", type: "pixmap", rect: [0, 0, 200, 100], zOrder: 0, opacity: albumArtOpacity };
		const cleanBarStyle = { type: "bar", subtype: 0, border_w: 0, bar_bg_c: "#404040", bar_fill_c: settings.barColor ?? "#ffffff" };

		// Text items are pixmaps drawn by the plugin (see render()); the font
		// size and alignment ride along as extra properties Stream Deck
		// ignores, so textRects() can read them back from the same source.
		const title = (rect: number[], fontSize: number) => ({
			key: "displayTitle", type: "pixmap", rect, font: { size: fontSize, weight: 600 }, alignment: "center",
			zOrder: 1, opacity: uiOpacity,
		});
		const titleLine2 = (rect: number[], fontSize: number) => ({ ...title(rect, fontSize), key: "songTitle" });
		const icon = (rect: number[]) => ({ key: "icon", type: "pixmap", rect, zOrder: 1, opacity: uiOpacity });
		const valueText = (rect: number[], fontSize = 24) => ({
			key: "value", type: "pixmap", rect, font: { size: fontSize, weight: 600 },
			alignment: showLogo ? "right" : "center", zOrder: 1, opacity: uiOpacity,
		});
		const progressBar = (rect: number[]) => ({ key: "progress", rect, value: 0, zOrder: 1, opacity: uiOpacity, ...cleanBarStyle });
		const volumeBar = (rect: number[]) => ({ key: "indicator", rect, value: 0, zOrder: 1, opacity: uiOpacity, ...cleanBarStyle });

		const sideRect = (y: number, height: number) => (showLogo ? [76, y, 108, height] : [16, y, 168, height]);
		const iconItem = showLogo ? [icon([16, 40, 48, 48])] : [];
		const iconItemSeparate = showLogo ? [icon([16, 42, 48, 48])] : [];

		let items: object[];
		if (progressBarMode === "separate") {
			items = twoRowTitle
				? [background, title([16, 3, 168, 21], 18), titleLine2([16, 24, 168, 21], 18), progressBar([16, 47, 168, 6]), valueText(sideRect(55, 26), 18), volumeBar(sideRect(81, 10))]
				: [background, title([16, 10, 168, 20], 16), progressBar([16, 32, 168, 6]), ...iconItemSeparate, valueText(sideRect(42, 32)), volumeBar(sideRect(76, 10))];
		} else if (progressBarMode === "replace") {
			items = twoRowTitle
				? [background, title([16, 3, 168, 21], 18), titleLine2([16, 24, 168, 21], 18), progressBar(sideRect(47, 8)), valueText(sideRect(57, 34), 24)]
				: [background, title([16, 10, 168, 24], 16), ...iconItem, progressBar(sideRect(40, 10)), valueText(sideRect(54, 34))];
		} else {
			items = twoRowTitle
				? [background, title([16, 5, 168, 21], 18), titleLine2([16, 26, 168, 21], 18), valueText(sideRect(49, 32), 24), volumeBar(sideRect(81, 10))]
				: [background, title([16, 10, 168, 24], 16), ...iconItem, valueText(sideRect(40, 32)), volumeBar(sideRect(74, 10))];
		}

		return { id: `volume-layout-dynamic-${progressBarMode}-${showLogo}-${twoRowTitle}`, items };
	}
}

/**
 * Port of PlayerControlsAction: play/pause on press, previous/next on
 * rotate, mute on hold. Shares the whole Screen settings system with
 * Adjust Volume, plus a "Show Volume" switch that collapses the strip to
 * just the title (and progress bar).
 */
@action({ UUID: `${P}.player-controls` })
export class PlayerControlsAction extends VolumeEncoderAction {
	protected override get showVolumeDisabledIconWhenUnavailable(): boolean {
		return false;
	}

	protected override async updateTriggerDescription(): Promise<void> {
		// Fixed in the manifest (always Play/Pause); nothing to relabel.
	}

	override async onDialRotate(ev: DialRotateEvent<EncoderSettings>): Promise<void> {
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		if (ev.payload.ticks < 0) this.control(ev.action, state, "previous");
		else if (ev.payload.ticks > 0) this.control(ev.action, state, "next");
	}

	override async onDialUp(ev: DialUpEvent<EncoderSettings>): Promise<void> {
		this.control(ev.action, this.stateFor(ev.action.id, ev.payload.settings), "playpause");
	}

	override async onTouchTap(ev: TouchTapEvent<EncoderSettings>): Promise<void> {
		const state = this.stateFor(ev.action.id, ev.payload.settings);
		if (ev.payload.hold) this.toggleMute(ev.action, state);
		else this.control(ev.action, state, "playpause");
	}

	protected override layoutSettingsKey(settings: EncoderSettings): string {
		return `${super.layoutSettingsKey(settings)}|${settings.showVolume !== false}`;
	}

	protected override buildLayout(settings: EncoderSettings): object {
		if (settings.showVolume === false) {
			return this.buildCenteredLayout(settings);
		}
		return super.buildLayout(settings);
	}

	/** Show Volume off: title (and progress bar) centered, no icon/value/volume bar. */
	private buildCenteredLayout(settings: EncoderSettings): object {
		const uiOpacity = this.toOpacity(settings.uiTransparency, 100);
		const albumArtOpacity = this.toOpacity(settings.albumArtTransparency, 50);
		const progressBarMode = settings.progressBarMode ?? "off";
		const titleMode = settings.titleMode ?? "output";
		const showLogo = settings.showLogo !== false;
		const twoRowTitle = titleMode === "track" && !showLogo;
		const hasProgress = progressBarMode !== "off";

		const items: object[] = [{ key: "background", type: "pixmap", rect: [0, 0, 200, 100], zOrder: 0, opacity: albumArtOpacity }];
		const titleHeight = twoRowTitle ? 21 : 24;
		const titleFont = twoRowTitle ? 18 : 16;
		const titleBlockHeight = twoRowTitle ? titleHeight * 2 : titleHeight;
		const blockHeight = hasProgress ? titleBlockHeight + 8 + 10 : titleBlockHeight;
		const top = Math.round((100 - blockHeight) / 2);

		const text = (key: string, y: number) => ({
			key, type: "pixmap", rect: [16, y, 168, titleHeight], font: { size: titleFont, weight: 600 },
			alignment: "center", zOrder: 1, opacity: uiOpacity,
		});
		items.push(text("displayTitle", top));
		if (twoRowTitle) items.push(text("songTitle", top + titleHeight));
		if (hasProgress) {
			items.push({
				key: "progress", rect: [16, top + titleBlockHeight + 8, 168, 10], value: 0, zOrder: 1, opacity: uiOpacity,
				type: "bar", subtype: 0, border_w: 0, bar_bg_c: "#404040", bar_fill_c: settings.barColor ?? "#ffffff",
			});
		}

		return { id: `player-controls-layout-centered-${progressBarMode}-${twoRowTitle}`, items };
	}
}
