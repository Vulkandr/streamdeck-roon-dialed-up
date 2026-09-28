import { action } from "@elgato/streamdeck";

import { RoonToastedActionBase } from "./roon-toasted-action";

/**
 * "Toaster" button: opens (or brings to front) Roon: Toasted's Now Playing
 * screen, or links out to install the app if it isn't there yet.
 */
@action({ UUID: "com.vulkan.roon-dialed-up.roon-toasted-toggle" })
export class ToasterAction extends RoonToastedActionBase {
	protected override get iconName(): string {
		return "toaster";
	}

	protected override get urlScheme(): string {
		return "toggle";
	}
}
