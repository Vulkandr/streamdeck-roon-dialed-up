import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { getPublicGlobalSettings, onGlobalSettingsChanged, updateGlobalSettings } from "./global-settings";
import {
	clearManualCore,
	DEFAULT_ROON_PORT,
	getConnectionStatus,
	getDiscoveredCores,
	getManualCore,
	getOutputs,
	getPairedCore,
	onCoresChanged,
	onStatusChanged,
	onZonesChanged,
	rescan,
	setManualCore,
	switchCore,
} from "./roon-connection";
import { openRoonToasted, ROON_TOASTED_GITHUB_URL, ROON_TOASTED_WEBSITE_URL } from "./roon-toasted-link";
import { getToastedStatus, onToastedStatusChanged, refreshToastedStatus } from "./roon-toasted-status";

const log = streamDeck.logger.createScope("pi-bridge");

/**
 * Plugin side of the settings panel (ui/roon.html): answers its requests
 * (current state, rescan, switch Core) and pushes live updates while it's
 * open, so the Core card, Available Cores list and zone list stay current
 * without the panel having to be reopened.
 *
 * Plugin-wide rather than per action: the connection is shared by every
 * Roon action, so any action's panel shows the same Core information, and
 * only the parts that are specific to an action (the zone picker) differ.
 */

let panelVisible = false;
let pushTimer: NodeJS.Timeout | null = null;

function buildState(): JsonValue {
	const paired = getPairedCore();
	const status = getConnectionStatus();

	return {
		type: "state",
		status: { phase: status.phase, detail: status.detail ?? null },
		pairedCore: paired
			? { id: paired.id, name: paired.name, host: paired.host ?? null, port: paired.port ?? null }
			: null,
		cores: getDiscoveredCores().map((core) => ({
			id: core.id,
			name: core.name,
			version: core.version,
			host: core.host,
			port: core.port,
			inUse: !!paired && (core.id === paired.id || (core.host === paired.host && core.port === paired.port)),
		})),
		outputs: getOutputs().map((o) => ({
			id: o.outputId,
			name: o.displayName,
			state: String(o.state ?? "stopped"),
			hasVolume: !!o.volume,
		})),
		toasted: (() => {
			const s = getToastedStatus();
			return { phase: s.phase, version: s.version ?? null, roon: s.roon ?? null, core: s.core ?? null };
		})(),
		manual: (() => { const m = getManualCore(); return m ? { host: m.host, port: m.port } : null; })(),
		defaultPort: DEFAULT_ROON_PORT,
		global: getPublicGlobalSettings(),
	};
}

async function pushNow(): Promise<void> {
	if (!panelVisible) {
		return;
	}
	try {
		await streamDeck.ui.sendToPropertyInspector(buildState());
	} catch (err) {
		log.warn(`couldn't push state to settings panel: ${err}`);
	}
}

/**
 * Coalesces bursts of changes into one update. Zone updates in particular
 * arrive every second while anything is playing (seek position), which the
 * panel doesn't need at that rate.
 */
function schedulePush(): void {
	if (!panelVisible || pushTimer) {
		return;
	}
	pushTimer = setTimeout(() => {
		pushTimer = null;
		void pushNow();
	}, 400);
}

export function startPropertyInspectorBridge(): void {
	streamDeck.ui.onDidAppear(() => {
		panelVisible = true;
		void pushNow();
	});

	streamDeck.ui.onDidDisappear(() => {
		panelVisible = false;
	});

	streamDeck.ui.onSendToPlugin(async (ev) => {
		const message = ev.payload as
			| { type?: string; coreId?: string; global?: Record<string, unknown>; host?: string; port?: number | string }
			| null;

		switch (message?.type) {
			case "getState":
				await pushNow();
				break;

			case "rescan":
				rescan();
				await pushNow();
				break;

			case "setGlobal":
				// Icon style/color, last-used output: shared by every key.
				await updateGlobalSettings((message.global ?? {}) as any);
				break;

			case "launchToasted":
				openRoonToasted("open");
				setTimeout(() => void refreshToastedStatus(), 2000);
				break;

			case "getToasted":
				// The panel needs the download page opened from here: it can't open URLs itself.
				await streamDeck.system.openUrl(ROON_TOASTED_WEBSITE_URL ?? ROON_TOASTED_GITHUB_URL);
				break;

			case "setManual": {
				const result = setManualCore(String(message.host ?? ""), Number(message.port ?? DEFAULT_ROON_PORT));
				log.info(`setManual(${message.host}:${message.port}) -> ${JSON.stringify(result)}`);
				await streamDeck.ui.sendToPropertyInspector({ type: "manualResult", ...result });
				await pushNow();
				break;
			}

			case "clearManual":
				clearManualCore();
				await pushNow();
				break;

			case "switchCore": {
				const result = switchCore(String(message.coreId ?? ""));
				log.info(`switchCore(${message.coreId}) -> ${JSON.stringify(result)}`);
				await streamDeck.ui.sendToPropertyInspector({ type: "switchResult", coreId: message.coreId ?? null, ...result });
				await pushNow();
				break;
			}
		}
	});

	onStatusChanged(schedulePush);
	onCoresChanged(schedulePush);
	onToastedStatusChanged(schedulePush);
	onZonesChanged((seekOnly) => {
		if (!seekOnly) schedulePush();
	});
	onGlobalSettingsChanged(schedulePush);
}
