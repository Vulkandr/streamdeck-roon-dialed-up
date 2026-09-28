import { action, type KeyAction, type KeyUpEvent } from "@elgato/streamdeck";

import { RepeatingAction, seekAmount } from "./repeating-action";
import { RoonAction, type RoonKeySettings } from "./roon-action";
import { NextDisabled } from "../data-images/next-key-disabled";
import { PauseDisabled } from "../data-images/pause-key-disabled";
import { PreviousDisabled } from "../data-images/previous-key-disabled";
import { StopDisabled } from "../data-images/stop-key-disabled";
import { VolumeDownDisabled } from "../data-images/volume-down-key-disabled";
import { VolumeUpDisabled } from "../data-images/volume-up-key-disabled";
import type { RoonOutput } from "../roon-connection";

const P = "com.vulkan.roon-dialed-up";

@action({ UUID: `${P}.pause` })
export class PauseAction extends RoonAction {
	protected override get iconName() { return "pause"; }
	protected override classicDisabledImage() { return PauseDisabled; }
	protected override isAvailable(output: RoonOutput | null) { return output?.isPauseAllowed === true; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		this.transportControl(ev.action, this.outputFor(ev.payload.settings), "pause");
	}
}

@action({ UUID: `${P}.stop` })
export class StopAction extends RoonAction {
	protected override get iconName() { return "stop"; }
	protected override classicDisabledImage() { return StopDisabled; }
	protected override isAvailable(output: RoonOutput | null) { return output !== null && output.state !== "stopped"; }
	override async onKeyUp(ev: KeyUpEvent<RoonKeySettings>) {
		this.transportControl(ev.action, this.outputFor(ev.payload.settings), "stop");
	}
}

@action({ UUID: `${P}.next` })
export class NextAction extends RepeatingAction {
	protected override get iconName() { return "next"; }
	protected override classicDisabledImage() { return NextDisabled; }
	protected override isAvailable(output: RoonOutput | null) { return output?.isNextAllowed === true; }
	protected override onTrigger(action: KeyAction<RoonKeySettings>, output: RoonOutput | null, count: number) {
		if (count === 0) {
			this.transportControl(action, output, "next");
		} else if (output?.isSeekAllowed) {
			this.transportSeek(action, output, "relative", seekAmount(count));
		}
	}
}

@action({ UUID: `${P}.previous` })
export class PreviousAction extends RepeatingAction {
	protected override get iconName() { return "previous"; }
	protected override classicDisabledImage() { return PreviousDisabled; }
	protected override isAvailable(output: RoonOutput | null) { return output?.isPreviousAllowed === true; }
	protected override onTrigger(action: KeyAction<RoonKeySettings>, output: RoonOutput | null, count: number) {
		if (count === 0) {
			this.transportControl(action, output, "previous");
		} else if (output?.isSeekAllowed) {
			this.transportSeek(action, output, "relative", -seekAmount(count));
		}
	}
}

@action({ UUID: `${P}.volume-up` })
export class VolumeUpAction extends RepeatingAction {
	protected override get iconName() { return "volume-up"; }
	protected override classicDisabledImage() { return VolumeUpDisabled; }
	protected override isAvailable(output: RoonOutput | null) {
		return !!output?.volume && output.volume.value < output.volume.max;
	}
	protected override onTrigger(action: KeyAction<RoonKeySettings>, output: RoonOutput | null, count: number) {
		const step = (output?.volume?.step ?? 1) * (count + 1);
		this.changeVolume(action, output, "relative_step", step);
	}
}

@action({ UUID: `${P}.volume-down` })
export class VolumeDownAction extends RepeatingAction {
	protected override get iconName() { return "volume-down"; }
	protected override classicDisabledImage() { return VolumeDownDisabled; }
	protected override isAvailable(output: RoonOutput | null) {
		return !!output?.volume && output.volume.value > output.volume.min;
	}
	protected override onTrigger(action: KeyAction<RoonKeySettings>, output: RoonOutput | null, count: number) {
		const step = -(output?.volume?.step ?? 1) * (count + 1);
		this.changeVolume(action, output, "relative_step", step);
	}
}
