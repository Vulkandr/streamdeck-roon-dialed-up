import { action, type KeyAction, type KeyUpEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import { VolumeSetDisabled } from "../data-images/volume-set-key-disabled";
import { VolumeSetImage } from "../data-images/volume-set-key";
import { CANVAS } from "../icons/icon-renderer";
import { composeKeyImage } from "../icons/key-image";
import { textFontOf } from "../icons/text-paths";
import type { RoonOutput } from "../roon-connection";

export interface VolumeSetSettings extends RoonKeySettings {
	volume?: number | string;
	showCurrentVolume?: boolean;
}

export function formatVolume(volume: NonNullable<RoonOutput["volume"]>): string {
	return `${volume.value}${volume.type === "db" ? " dB" : ""}`;
}

/** Sets the output to a fixed volume; optionally shows the current level on the key. */
@action({ UUID: "com.vulkan.roon-dialed-up.volume-set" })
export class VolumeSetAction extends RoonAction<VolumeSetSettings> {
	protected override get iconName() { return "volume-set"; }
	protected override classicDisabledImage() { return VolumeSetDisabled; }
	protected override isAvailable(output: RoonOutput | null, _settings: VolumeSetSettings) { return !!output?.volume; }

	override async onKeyUp(ev: KeyUpEvent<VolumeSetSettings>) {
		const output = this.outputFor(ev.payload.settings);
		const volume = Number(ev.payload.settings.volume);
		if (!output?.volume || Number.isNaN(volume)) {
			await ev.action.showAlert();
			return;
		}
		this.changeVolume(ev.action, output, "absolute", volume, () => {
			void ev.action.showOk();
		});
	}

	protected override async render(action: KeyAction<VolumeSetSettings>, settings: VolumeSetSettings) {
		const output = this.outputFor(settings);
		if (!settings.showCurrentVolume || !output?.volume) {
			await action.setImage(this.styledImage(settings, !this.isAvailable(output, settings)));
			return;
		}

		const text = formatVolume(output.volume);
		// Same sizing steps as the original canvas version.
		// Same sizing steps as the original canvas version.
		const [left, size] = text.length <= 3 ? [70, 36] : text.length <= 6 ? [62, 26] : [62, 20];
		const body = this.styledIconBodyFor("volume-set");
		await action.setImage(
			composeKeyImage({
				base: body !== undefined ? { svgBody: body } : { dataUri: VolumeSetImage },
				lines: [{ text, x: left, y: CANVAS / 2 + 2, size, align: "left" }],
				font: textFontOf(settings),
			}),
		);
	}
}
