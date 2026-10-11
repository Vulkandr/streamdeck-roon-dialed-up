import streamDeck, { action, type KeyAction, type KeyUpEvent } from "@elgato/streamdeck";

import { ProgressTracker, RoonAction, type RoonKeySettings } from "./roon-action";
import { PauseImage } from "../data-images/pause-key";
import { PlayDisabledImage } from "../data-images/play-key-disabled";
import { PlayImage } from "../data-images/play-key";
import { StopImage } from "../data-images/stop-key";
import { CANVAS } from "../icons/icon-renderer";
import { composeKeyImage, fitText, formatDuration, type TextLine } from "../icons/key-image";
import { measureText, textFontOf } from "../icons/text-paths";
import { getImage, type RoonOutput } from "../roon-connection";

const log = streamDeck.logger.createScope("play-actions");
const P = "com.vulkan.roon-dialed-up";

export interface PlaySettings extends RoonKeySettings {
	/**
	 * "Show Icon" (default on). Off: no play/pause/stop icon behind the art,
	 * text and bar, so a key that carries track info isn't competing with
	 * an icon under it. The dimmed icon still shows while the output is
	 * gone, since the key has nothing else to say then.
	 */
	showIcon?: boolean;
	showCoverArt?: boolean;
	showArtistTrack?: boolean;
	showProgressBar?: boolean;
	/** "Show Track Time": the playing position (or time left) on the key. */
	showSeekPosition?: boolean;
	/** What Show Track Time shows: elapsed (default) or remaining, as "-mm:ss". */
	trackTimeMode?: "elapsed" | "remaining";
	/** The track's full length, under the progress bar (the track time moves above it). */
	showTotalTime?: boolean;
}

interface KeyState {
	progress: ProgressTracker;
	/** Cover art currently held, and which image key it belongs to. */
	artKey?: string;
	artDataUri?: string;
	/** While paused, the elapsed time blinks: ticks once a second. */
	pauseTimer?: NodeJS.Timeout;
	pauseTicks: number;
}

/**
 * Port of PlayActionBase: the Play and Play/Pause keys, with the optional
 * "dynamic cover" overlays (album art, artist/track, progress bar, elapsed
 * time). Rendering is SVG composition instead of canvas; everything else
 * follows the original.
 */
abstract class PlayActionBase extends RoonAction<PlaySettings> {
	private readonly keyState = new Map<string, KeyState>();

	protected override get iconName() { return "play"; }
	protected override get rendersOnSeek() { return true; }
	protected override classicDisabledImage() { return PlayDisabledImage; }

	private stateFor(keyId: string): KeyState {
		let s = this.keyState.get(keyId);
		if (!s) {
			s = { progress: new ProgressTracker(), pauseTicks: 0 };
			this.keyState.set(keyId, s);
		}
		return s;
	}

	protected override onKeyRemoved(keyId: string): void {
		const s = this.keyState.get(keyId);
		if (s?.pauseTimer) clearInterval(s.pauseTimer);
		this.keyState.delete(keyId);
	}

	/**
	 * Which base picture to show for the current state: the styled icon
	 * name, or "art" for cover art, or null for nothing (dimmed icon).
	 */
	protected abstract pickBase(output: RoonOutput, settings: PlaySettings, hasArt: boolean): "play" | "pause" | "stop" | "art" | null;

	protected override async render(action: KeyAction<PlaySettings>, settings: PlaySettings): Promise<void> {
		const output = this.outputFor(settings);
		const state = this.stateFor(action.id);

		if (!output) {
			await action.setState(0);
			await action.setImage(this.styledImage(settings, true));
			this.stopPauseBlink(state);
			return;
		}

		const playing = output.state === "playing" || output.state === "loading";
		await action.setState(playing ? 1 : 0);
		state.progress.update(output);
		this.syncPauseBlink(state, output, action, settings);

		// Cover art: fetch when the track's image changes, render again once it arrives.
		const wantArt = settings.showCoverArt === true && !!output.imageKey;
		if (wantArt && state.artKey !== output.imageKey) {
			state.artKey = output.imageKey;
			state.artDataUri = undefined;
			void this.fetchArt(action, settings, state, output.imageKey!);
		} else if (!wantArt) {
			state.artKey = undefined;
			state.artDataUri = undefined;
		}

		const base = this.pickBase(output, settings, !!state.artDataUri);
		if (base === null) {
			await action.setImage(this.styledImage(settings, true));
			return;
		}

		const font = textFontOf(settings);
		const lines: TextLine[] = [];
		if (settings.showArtistTrack && (output.artistName || output.songName)) {
			[output.artistName, output.songName]
				.filter((t): t is string => !!t)
				.forEach((text, i) => {
					lines.push({ text: fitText(text, CANVAS - 12, 18, true, font), y: 17 + i * 19, size: 18, bold: true });
				});
		}

		// Times: on their own, the track time sits under the bar as the
		// original drew it. With the total shown too, the track time moves
		// above the bar and the total takes its place below, and a plain line
		// stands in for the bar when that is off, so the spacing never changes.
		const showTotal = settings.showTotalTime === true && !!output.trackLength;
		const blinkOff = state.pauseTimer !== undefined && state.pauseTicks % 2 !== 0;
		if (settings.showSeekPosition && output.seekPosition !== undefined && !blinkOff) {
			const remaining = settings.trackTimeMode === "remaining" && !!output.trackLength;
			const y = showTotal ? CANVAS - 71 : CANVAS - 24;
			const text = remaining
				? formatDuration(Math.max(0, output.trackLength! - output.seekPosition))
				: formatDuration(output.seekPosition);
			lines.push({ text, y, size: 32 });
			if (remaining) {
				// The minus sits just left of the digits, so the digits stay
				// centered and line up with the total time under them.
				const digitsWidth = measureText(text, 32, false, font);
				const minusWidth = measureText("-", 32, false, font);
				lines.push({ text: "-", y, size: 32, x: CANVAS / 2 - digitsWidth / 2 - minusWidth - 3, align: "left" });
			}
		}
		if (showTotal) {
			lines.push({ text: formatDuration(output.trackLength!), y: CANVAS - 24, size: 32 });
		}

		const baseLayer =
			base === "art"
				? { dataUri: state.artDataUri! }
				: settings.showIcon === false
					? { svgBody: "" }
					: this.iconBase(base);

		await action.setImage(
			composeKeyImage({
				base: baseLayer,
				lines,
				font,
				progressPercent: settings.showProgressBar ? state.progress.percent() : undefined,
				divider: showTotal && !settings.showProgressBar,
			}),
		);
	}

	private iconBase(name: "play" | "pause" | "stop"): { svgBody: string } | { dataUri: string } {
		const body = this.styledIconBodyFor(name);
		if (body !== undefined) {
			return { svgBody: body };
		}
		// Classic style: the original's static key images.
		const classic = { play: PlayImage, pause: PauseImage, stop: StopImage }[name];
		return { dataUri: classic };
	}

	private async fetchArt(action: KeyAction<PlaySettings>, settings: PlaySettings, state: KeyState, imageKey: string): Promise<void> {
		try {
			const dataUri = await getImage(imageKey, { scale: "fit", width: CANVAS, height: CANVAS, format: "image/jpeg" });
			if (state.artKey === imageKey) {
				state.artDataUri = dataUri;
				await this.render(action, this.settingsByKey.get(action.id) ?? settings);
			}
		} catch (err) {
			log.warn(`cover art fetch failed: ${err}`);
		}
	}

	private syncPauseBlink(state: KeyState, output: RoonOutput, action: KeyAction<PlaySettings>, settings: PlaySettings): void {
		const shouldBlink = output.state === "paused" && settings.showSeekPosition === true;
		if (shouldBlink && !state.pauseTimer) {
			state.pauseTicks = 0;
			state.pauseTimer = setInterval(() => {
				state.pauseTicks += 1;
				void this.render(action, this.settingsByKey.get(action.id) ?? settings);
			}, 1000);
		} else if (!shouldBlink) {
			this.stopPauseBlink(state);
		}
	}

	private stopPauseBlink(state: KeyState): void {
		if (state.pauseTimer) {
			clearInterval(state.pauseTimer);
			state.pauseTimer = undefined;
			state.pauseTicks = 0;
		}
	}
}

@action({ UUID: `${P}.play-pause` })
export class PlayPauseAction extends PlayActionBase {
	protected override pickBase(output: RoonOutput, settings: PlaySettings, hasArt: boolean) {
		switch (output.state) {
			case "playing":
			case "loading":
				if (settings.showCoverArt && hasArt) return "art";
				return output.isPauseAllowed ? "pause" : "stop";
			default:
				return output.isPlayAllowed ? "play" : null;
		}
	}

	override async onKeyUp(ev: KeyUpEvent<PlaySettings>) {
		this.transportControl(ev.action, this.outputFor(ev.payload.settings), "playpause");
	}
}

@action({ UUID: `${P}.play` })
export class PlayAction extends PlayActionBase {
	protected override pickBase(output: RoonOutput, settings: PlaySettings, hasArt: boolean) {
		switch (output.state) {
			case "playing":
			case "loading":
				// Already playing: nothing to do unless showing the art.
				return settings.showCoverArt && hasArt ? "art" : null;
			default:
				return output.isPlayAllowed ? "play" : null;
		}
	}

	override async onKeyUp(ev: KeyUpEvent<PlaySettings>) {
		this.transportControl(ev.action, this.outputFor(ev.payload.settings), "play");
	}
}
