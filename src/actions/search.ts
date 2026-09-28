import { action } from "@elgato/streamdeck";

import { RoonToastedActionBase } from "./roon-toasted-action";

/**
 * "Search" button: opens (or brings to front) Roon: Toasted's Search
 * screen, or links out to install the app if it isn't there yet.
 */
@action({ UUID: "com.vulkan.roon-dialed-up.roon-toasted-search" })
export class SearchAction extends RoonToastedActionBase {
	protected override get iconName(): string {
		return "search";
	}

	protected override get urlScheme(): string {
		return "search";
	}
}
