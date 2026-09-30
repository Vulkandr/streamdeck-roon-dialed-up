import streamDeck, { action, type KeyAction, type KeyUpEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import { getLibraryTrack, isLibraryReady, libraryAdd, libraryHeart, onLibraryChanged, watchLibrary } from "../library-link";
import type { RoonOutput } from "../roon-connection";

const log = streamDeck.logger.createScope("heart");

const P = "com.vulkan.roon-dialed-up";

export interface HeartSettings extends RoonKeySettings {
	/** What "add to library" adds: just the song ("track", the default) or its whole album. */
	libraryAddMode?: string;
}

/**
 * "Add to Library / Heart": one key that follows the playing track through
 * the states Roon's own apps use, the way Roon: Toasted does it.
 *
 *   not in the library  ->  "+"           press: add it (the song, or its whole album, per the key's setting)
 *   in the library      ->  outline heart  press: heart it
 *   hearted             ->  filled heart   press: un-heart it (never removes it from the library)
 *
 * Manifest states: 0 = hearted, 1 = in the library, 2 = not in the library.
 * LED styles dim when nothing is playing or the library link isn't up (see
 * library-link.ts); Classic shows the manifest image for the state as is.
 */
@action({ UUID: `${P}.heart` })
export class HeartAction extends RoonAction<HeartSettings> {
	private readonly releaseByKey = new Map<string, () => void>();
	private readonly busy = new Set<string>();

	constructor() {
		super();
		onLibraryChanged(() => this.refreshAll());
	}

	override async onWillAppear(ev: Parameters<RoonAction<HeartSettings>["onWillAppear"]>[0]): Promise<void> {
		if (ev.action.isKey() && !this.releaseByKey.has(ev.action.id)) {
			this.releaseByKey.set(ev.action.id, watchLibrary());
		}
		await super.onWillAppear(ev);
	}

	protected override onKeyRemoved(keyId: string): void {
		this.releaseByKey.get(keyId)?.();
		this.releaseByKey.delete(keyId);
		this.busy.delete(keyId);
	}

	protected override isAvailable(output: RoonOutput | null): boolean {
		return isLibraryReady() && getLibraryTrack(output?.zoneId) !== null;
	}

	protected override async render(action: KeyAction<HeartSettings>, settings: HeartSettings): Promise<void> {
		const output = this.outputFor(settings);
		const track = getLibraryTrack(output?.zoneId);
		const state = !track || !track.inLibrary ? 2 : track.favorite ? 0 : 1;
		await action.setState(state);
		const icon = state === 0 ? "heart-on" : state === 1 ? "heart" : "add-library";
		const dim = !this.isAvailable(output) || this.busy.has(action.id);
		await action.setImage(this.styledImage(settings, dim, icon));
	}

	override async onKeyUp(ev: KeyUpEvent<HeartSettings>): Promise<void> {
		const output = this.outputFor(ev.payload.settings);
		const zoneId = output?.zoneId;
		const track = getLibraryTrack(zoneId);
		if (!zoneId || !track || this.busy.has(ev.action.id)) {
			await ev.action.showAlert();
			return;
		}
		const mode = ev.payload.settings.libraryAddMode === "album" ? "album" : "track";
		this.busy.add(ev.action.id);
		await this.render(ev.action, ev.payload.settings);
		try {
			// Adding first, hearting second: the heart only shows once Roon says it's in.
			if (!track.inLibrary) {
				await libraryAdd(zoneId, mode);
			} else {
				await libraryHeart(zoneId, !track.favorite, mode);
			}
		} catch (err) {
			log.warn(`${this.manifestId}: ${err instanceof Error ? err.message : err}`);
			await ev.action.showAlert();
		} finally {
			this.busy.delete(ev.action.id);
			await this.render(ev.action, ev.payload.settings);
		}
	}
}
