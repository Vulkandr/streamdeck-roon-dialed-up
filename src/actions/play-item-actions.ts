import streamDeck, { action, type KeyUpEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import { PlayItemDisabled } from "../data-images/play-item-key-disabled";
import { PlayThisDisabled } from "../data-images/play-this-key-disabled";
import { getBrowse, type RoonOutput } from "../roon-connection";

const log = streamDeck.logger.createScope("play-item");
const P = "com.vulkan.roon-dialed-up";

export type ItemType = "albums" | "artists" | "composers" | "internet_radio" | "genres" | "playlists" | "tags";

export interface PlayItemSettings extends RoonKeySettings {
	itemType?: ItemType;
	itemAction?: string;
	itemTitle?: string;
}

function browse(opts: Record<string, unknown>): Promise<any> {
	return new Promise((resolve, reject) => {
		const svc = getBrowse();
		if (!svc) return reject(new Error("not connected"));
		svc.browse(opts, (err: unknown, result: any) => (err ? reject(new Error(String(err))) : resolve(result)));
	});
}

function load(opts: Record<string, unknown>): Promise<any> {
	return new Promise((resolve, reject) => {
		const svc = getBrowse();
		if (!svc) return reject(new Error("not connected"));
		svc.load(opts, (err: unknown, result: any) => (err ? reject(new Error(String(err))) : resolve(result)));
	});
}

/**
 * Walks Roon's browse hierarchy by title, one level at a time, and
 * activates the final item (Play Now / Shuffle / Queue...). Ported from
 * ActionBase.roonBrowseAndActivate in the original.
 */
export async function browseAndActivate(output: RoonOutput, itemType: ItemType, itemTitle: string, itemAction: string): Promise<boolean> {
	let hierarchy: string = itemType;
	let path: string[] = [];

	switch (itemType) {
		case "artists": path = [itemTitle, "Play Artist", itemAction, itemAction]; break;
		case "albums": path = [itemTitle, "Play Album", itemAction, itemAction]; break;
		case "composers": path = [itemTitle, "Play Composer", itemAction, itemAction]; break;
		case "internet_radio": path = [itemTitle, itemTitle]; break;
		case "genres": path = [itemTitle, "Play Genre", itemAction, itemAction]; break;
		case "playlists": path = [itemTitle, "Play Playlist", itemAction, itemAction]; break;
		case "tags":
			hierarchy = "browse";
			path = ["Library", "Tags", itemTitle, "Play Tag", itemAction, itemAction];
			break;
	}

	let itemKey: string | undefined;
	let index = 0;

	for (const step of path) {
		index += 1;
		const options: Record<string, unknown> = { hierarchy, zone_or_output_id: output.outputId };
		if (itemKey) options.item_key = itemKey;
		else options.pop_all = true;

		const result = await browse(options);
		if (result?.action !== "list") {
			return false;
		}

		let found: any = null;
		let offset = 0;
		while (!found) {
			const page = await load({ hierarchy, offset });
			found = (page.items ?? []).find((item: any) => item.title?.toLowerCase() === step.toLowerCase()) ?? null;
			offset += page.items?.length ?? 0;
			if (!page.items?.length || offset >= (page.list?.count ?? 0)) break;
		}

		if (!found) {
			log.info(`browse: "${step}" not found at level ${index}`);
			return false;
		}
		itemKey = found.item_key;
	}

	return index !== 0 && index === path.length;
}

abstract class PlayItemBase extends RoonAction<PlayItemSettings> {
	protected abstract titleFor(settings: PlayItemSettings, output: RoonOutput): string;

	override async onKeyUp(ev: KeyUpEvent<PlayItemSettings>) {
		const settings = ev.payload.settings;
		const output = this.outputFor(settings);
		const title = output ? this.titleFor(settings, output) : "";

		if (!output || !title || !settings.itemType) {
			await ev.action.showAlert();
			return;
		}

		try {
			const ok = await browseAndActivate(output, settings.itemType, title, settings.itemAction ?? "Play Now");
			await (ok ? ev.action.showOk() : ev.action.showAlert());
		} catch (err) {
			log.warn(`browse failed: ${err}`);
			await ev.action.showAlert();
		}
	}
}

/** Plays a named playlist, artist, album, tag, genre, composer or radio station. */
@action({ UUID: `${P}.play-item` })
export class PlayItemAction extends PlayItemBase {
	protected override get iconName() { return "play-item"; }
	protected override classicDisabledImage() { return PlayItemDisabled; }
	protected override titleFor(settings: PlayItemSettings) { return settings.itemTitle ?? ""; }
}

/** Plays more of the current artist or album. */
@action({ UUID: `${P}.play-this` })
export class PlayThisAction extends PlayItemBase {
	protected override get iconName() { return "play-this"; }
	protected override classicDisabledImage() { return PlayThisDisabled; }

	protected override titleFor(settings: PlayItemSettings, output: RoonOutput) {
		if (settings.itemType === "albums") return output.albumName ?? "";
		if (settings.itemType === "artists") return output.artistName ?? "";
		return "";
	}

	protected override isAvailable(output: RoonOutput | null, settings: PlayItemSettings) {
		return !!output && this.titleFor(settings, output) !== "";
	}
}
