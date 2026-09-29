import { action } from "@elgato/streamdeck";

import { RoonToastedActionBase } from "./roon-toasted-action";

/**
 * "Launch App" button: opens (or brings to front) Roon: Toasted's Now Playing
 * screen, or links out to install the app if it isn't there yet.
 */
@action({ UUID: "com.vulkan.roon-dialed-up.launch-app" })
export class LaunchAppAction extends RoonToastedActionBase {
	protected override get iconName(): string {
		return "launch-app";
	}

	protected override get urlScheme(): string {
		return "toggle";
	}
}
