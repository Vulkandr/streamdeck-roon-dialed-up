import streamDeck, { KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent } from "@elgato/streamdeck";

import { getIconColor, getIconStyle, onGlobalSettingsChanged } from "../global-settings";
import { composeKeyImage, styledIconBody } from "../icons/key-image";

import {
	invalidateRoonToastedInstallCache,
	isRoonToastedInstalled,
	openRoonToasted,
	ROON_TOASTED_GITHUB_URL,
	ROON_TOASTED_WEBSITE_URL,
} from "../roon-toasted-link";
import { getToastedStatus, onToastedStatusChanged, refreshToastedStatus, watchToasted } from "../roon-toasted-status";

/**
 * Shared base for the Roon: Toasted link-out buttons (Toaster and Search).
 * Neither talks to Roon at all, they just launch or focus the separate
 * companion app on a specific screen, or point out to its GitHub page when
 * it isn't installed yet, so unlike a normal Roon action this deliberately
 * doesn't do anything with Roon Core/output state, only "is the app
 * installed".
 *
 * Mirrors the old CEF-hosted plugin's RoonToastedActionBase, adapted to
 * the Node.js SDK's SingletonAction model: one instance handles every
 * placed copy of the action, told apart via `ev.action` rather than one
 * instance per placement.
 */
export abstract class RoonToastedActionBase extends SingletonAction {
	/**
	 * The roon-toasted:// URL scheme this button opens the app to (e.g.
	 * "toggle" or "search"). Subclasses must override.
	 */
	protected abstract get urlScheme(): string;

	/** LED icon name ("toaster" / "search"). */
	protected abstract get iconName(): string;

	constructor() {
		super();
		onGlobalSettingsChanged(() => {
			for (const action of this.actions) void this.updateImage(action);
		});
		onToastedStatusChanged(() => {
			for (const action of this.actions) void this.updateImage(action);
		});
	}

	/** Releases the status polling for each placed key (see watchToasted). */
	private readonly releases = new Map<string, () => void>();

	override async onWillAppear(ev: WillAppearEvent): Promise<void> {
		this.releases.get(ev.action.id)?.();
		this.releases.set(ev.action.id, watchToasted());
		await this.updateImage(ev.action);
	}

	override onWillDisappear(ev: WillDisappearEvent): void {
		this.releases.get(ev.action.id)?.();
		this.releases.delete(ev.action.id);
	}

	override async onKeyUp(ev: KeyUpEvent): Promise<void> {
		// A live answer beats the registry check: if Toasted is answering, it's
		// certainly installed.
		const status = await refreshToastedStatus();
		if (status.phase === "running" || isRoonToastedInstalled()) {
			openRoonToasted(this.urlScheme);
		} else {
			// Not installed (or can't tell, e.g. not on Windows yet) -- send
			// them to the GitHub page for now, and to the website instead once
			// that's live. Invalidate the cached install check, so if this
			// press is what leads to installing it, the very next icon
			// refresh picks up "installed" rather than waiting out the cache
			// window.
			invalidateRoonToastedInstallCache();
			await streamDeck.system.openUrl(ROON_TOASTED_WEBSITE_URL ?? ROON_TOASTED_GITHUB_URL);
		}

		await this.updateImage(ev.action);
		await ev.action.showOk();
	}

	private async updateImage(action: WillAppearEvent["action"] | KeyUpEvent["action"]): Promise<void> {
		if (!action.isKey()) {
			return;
		}

		const installed = getToastedStatus().phase !== "not-installed";
		// Passing undefined resets the title to whatever the person set in
		// the panel, rather than forcing it blank; "Install" overrides it
		// until the app is there.
		await action.setTitle(installed ? undefined : "Install");

		// Styled LED icon (dimmed while not installed), or the manifest's
		// static image in Classic style.
		const body = styledIconBody(this.iconName, getIconStyle(), getIconColor(), !installed);
		await action.setImage(body === undefined ? undefined : composeKeyImage({ base: { svgBody: body } }));
	}
}
