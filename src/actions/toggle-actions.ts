import { action, type KeyAction, type KeyUpEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import { LoopAllDisabled } from "../data-images/loop-all-key-disabled";
import { LoopOneDisabled } from "../data-images/loop-one-key-disabled";
import { MuteDisabled } from "../data-images/mute-key-disabled";
import { RoonRadioDisabled } from "../data-images/roon-radio-key-disabled";
import { ShuffleDisabled } from "../data-images/shuffle-key-disabled";
import type { RoonOutput } from "../roon-connection";

const P = "com.vulkan.roon-dialed-up";

/**
 * Two-state keys (on/off). The manifest lists the "on" look as state 0 and
 * "off" as state 1, exactly as the original did, so setState(0) means on.
 * The LED icon name also switches between the plain and "-on" variants.
 */
abstract class ToggleAction extends RoonAction {
	protected abstract isOn(output: RoonOutput): boolean;
	protected abstract get baseIconName(): string;

	protected override async setStateFor(action: KeyAction<RoonKeySettings>, output: RoonOutput | null, _settings: RoonKeySettings) {
		const on = !!output && this.isOn(output);
		await action.setState(on ? 0 : 1);
	}

	protected override async render(action: KeyAction<RoonKeySettings>, settings: RoonKeySettings) {
		const output = this.outputFor(settings);
		const on = !!output && this.isOn(output);
		await this.setStateFor(action, output, settings);
		const icon = on ? `${this.baseIconName}-on` : this.baseIconName;
		await action.setImage(this.styledImage(settings, !this.isAvailable(output, settings), icon));
	}
}

@action({ UUID: `${P}.mute-unmute` })
export class MuteUnmuteAction extends ToggleAction {
	protected override get baseIconName() { return "mute"; }
	protected override isOn(output: RoonOutput) { return output.volume?.isMuted === true; }
	protected override classicDisabledImage() { return MuteDisabled; }
	protected override isAvailable(output: RoonOutput | null) { return !!output?.volume; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		const mute = this.toggleDesiredState(ev.payload) === 0;
		this.mute(ev.action, this.outputFor(ev.payload.settings), mute);
	}
}

@action({ UUID: `${P}.shuffle` })
export class ShuffleAction extends ToggleAction {
	protected override get baseIconName() { return "shuffle"; }
	protected override isOn(output: RoonOutput) { return output.shuffle === true; }
	protected override classicDisabledImage() { return ShuffleDisabled; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		const shuffle = this.toggleDesiredState(ev.payload) === 0;
		this.transportSetting(ev.action, this.outputFor(ev.payload.settings), { shuffle });
	}
}

@action({ UUID: `${P}.loop-one` })
export class LoopOneAction extends ToggleAction {
	protected override get baseIconName() { return "loop-one"; }
	protected override isOn(output: RoonOutput) { return output.loop === "loop_one"; }
	protected override classicDisabledImage() { return LoopOneDisabled; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		const loop = this.toggleDesiredState(ev.payload) === 0 ? "loop_one" : "disabled";
		this.transportSetting(ev.action, this.outputFor(ev.payload.settings), { loop });
	}
}

@action({ UUID: `${P}.loop-all` })
export class LoopAllAction extends ToggleAction {
	protected override get baseIconName() { return "loop-all"; }
	protected override isOn(output: RoonOutput) { return output.loop === "loop"; }
	protected override classicDisabledImage() { return LoopAllDisabled; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		const loop = this.toggleDesiredState(ev.payload) === 0 ? "loop" : "disabled";
		this.transportSetting(ev.action, this.outputFor(ev.payload.settings), { loop });
	}
}

@action({ UUID: `${P}.roon-radio` })
export class RoonRadioAction extends ToggleAction {
	protected override get baseIconName() { return "roon-radio"; }
	protected override isOn(output: RoonOutput) { return output.autoRadio === true; }
	protected override classicDisabledImage() { return RoonRadioDisabled; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		const auto_radio = this.toggleDesiredState(ev.payload) === 0;
		this.transportSetting(ev.action, this.outputFor(ev.payload.settings), { auto_radio });
	}
}
