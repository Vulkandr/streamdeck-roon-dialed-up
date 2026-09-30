import RoonApi from "node-roon-api";
import RoonApiBrowse from "node-roon-api-browse";
import RoonApiImage from "node-roon-api-image";
import RoonApiStatus from "node-roon-api-status";
import RoonApiTransport from "node-roon-api-transport";
import WsWebSocket from "ws";
import streamDeck from "@elgato/streamdeck";

import { getRoonState, setRoonState } from "./global-settings";

const log = streamDeck.logger.createScope("roon-connection");

/**
 * Roon connection for the Node.js plugin: automatic Core discovery (SOOD),
 * pairing, zone tracking, and a Core picker.
 *
 * The old CEF-hosted plugin connected with `roon.ws_connect({host, port})`
 * against a host/port typed in by hand, because real UDP (which Roon's SOOD
 * discovery needs) was never available inside that sandbox. Here the
 * plugin is a real Node process, so it discovers Cores on its own, the
 * same way Roon's own apps (and Roon: Toasted) do.
 */

// node-roon-api's websocket transport only falls back to the `ws` package
// when there's no global `WebSocket`:
//     if (typeof(WebSocket) == "undefined") global.WebSocket = require('ws');
// That check was written when Node never had one. Node 22+ (Stream Deck
// runs plugins on Node 24) ships a built-in, browser-style global
// WebSocket, so the library silently picks *that* instead. The built-in
// one hands incoming binary frames over as `Blob` objects, which Roon's
// MOO message parser can't read (it only understands Buffer/ArrayBuffer),
// so the very first reply from the Core (the registry "info" response)
// fails to parse and the library closes the connection -- before it ever
// sends the "register" request that makes the extension show up in Roon's
// Settings > Extensions list. Confirmed directly (Node's global WebSocket
// delivers `[object Blob]`, the `ws` package delivers a Buffer) and end to
// end against a fake Core: without this line, the connect/drop loop the
// real plugin showed; with it, registration, pairing and playback control.
//
// The transport reads the global at connection time (`new WebSocket(...)`
// inside its constructor), so pointing it at `ws` any time before
// start_discovery() is enough. Nothing else in this plugin uses the global
// (@elgato/streamdeck ships its own bundled copy of `ws` for its own
// connection to Stream Deck).
(globalThis as any).WebSocket = WsWebSocket;

const ROON_CORE_SERVICE_ID = "00720724-5143-4a9b-abac-0e50cba674bb";

// Cores re-announce on every query (every 10s while unpaired, and on each
// Rescan); one not heard from in this long is treated as gone. Same window
// Roon: Toasted uses.
const CORE_STALE_MS = 150_000;

// ---------------------------------------------------------------------------
// Persisted state (pairing tokens, preferred Core)
// ---------------------------------------------------------------------------

// node-roon-api defaults to "config.json" in the process's working
// directory, which for a Stream Deck plugin isn't something we control, and
// a plugin's own folder is replaced on every update. Stream Deck's global
// settings are neither: they persist across updates, and the 1.x plugin
// kept its Roon state there too (`roonState`), so an upgrade inherits the
// same extension id and token and Roon doesn't ask to be enabled again.
// Global settings must be loaded before startRoonConnection() runs.
function loadRoonState(): any {
	return structuredClone(getRoonState());
}

function saveRoonState(state: any): void {
	setRoonState(state);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Live connection status, shown on the Status key and in the settings
 * panel. Phases:
 *   starting            -- before start_discovery() has run at all
 *   searching           -- discovery running, nothing heard at all yet
 *   self-loopback-only  -- only this process's own outbound SOOD query has
 *                          come back (normal OS multicast loopback), no
 *                          Core has replied yet
 *   heard-broadcast     -- a genuine reply from a real Roon Core arrived
 *   connecting          -- opening the websocket to that Core's http_port
 *   awaiting-approval   -- websocket open and registration sent; Roon holds
 *                          its reply until the extension is enabled in
 *                          Settings > Extensions (instant if a token from an
 *                          earlier approval exists)
 *   connection-closed   -- the websocket dropped before pairing finished
 *                          (discovery retries on the Core's next reply)
 *   paired              -- core_paired fired, transport is live
 *   unpaired            -- was paired, core_unpaired fired
 *   error               -- something threw; caught and shown here instead
 *                          of crashing the whole plugin process silently
 */
export type ConnectionPhase =
	| "starting"
	| "searching"
	| "self-loopback-only"
	| "heard-broadcast"
	| "connecting"
	| "awaiting-approval"
	| "connection-closed"
	| "paired"
	| "unpaired"
	| "error";

export interface ConnectionStatus {
	phase: ConnectionPhase;
	detail?: string;
}

export interface DiscoveredCore {
	id: string;
	name: string;
	version: string;
	host: string;
	port: number;
	lastSeen: number;
}

export interface PairedCore {
	id: string;
	name: string;
	host?: string;
	port?: number;
}

/**
 * One Roon output, flattened from Roon's zone data into the shape the
 * actions work with (the same view model the original plugin used, so the
 * per-action logic ports over almost line for line). Volume is per output;
 * playback state, transport permissions, settings and now-playing all come
 * from the output's zone.
 */
export interface RoonOutput {
	outputId: string;
	zoneId: string;
	displayName: string;
	volume?: {
		type: string;
		min: number;
		max: number;
		value: number;
		step: number;
		isMuted: boolean;
	};
	state?: string;
	isNextAllowed?: boolean;
	isPreviousAllowed?: boolean;
	isPauseAllowed?: boolean;
	isPlayAllowed?: boolean;
	isSeekAllowed?: boolean;
	loop?: string;
	shuffle?: boolean;
	autoRadio?: boolean;
	seekPosition?: number;
	trackLength?: number;
	imageKey?: string;
	songName?: string;
	artistName?: string;
	albumName?: string;
}

let roon: any = null;
let roonStatusService: any = null;
let core: any = null;
let transport: any = null;
let zones: Record<string, any> = {};
let connectionStatus: ConnectionStatus = { phase: "starting" };
let pairedCore: PairedCore | null = null;

const discoveredCores = new Map<string, DiscoveredCore>();

// Every websocket the library opens (one per Core that answers discovery),
// keyed by "host:port", so the Core picker can find the registered
// connection for a given Core, and so the paired Core's address is known.
const connections = new Map<string, any>();

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

type ZoneListener = (seekOnly: boolean) => void;

const zoneListeners = new Set<ZoneListener>();
const statusListeners = new Set<() => void>();
const coreListeners = new Set<() => void>();

function subscribe<T extends (...args: any[]) => void>(set: Set<T>, listener: T): () => void {
	set.add(listener);
	return () => set.delete(listener);
}

function notify<T extends (...args: any[]) => void>(set: Set<T>, ...args: Parameters<T>): void {
	for (const listener of set) {
		try {
			listener(...args);
		} catch (err) {
			log.error(`listener threw: ${err instanceof Error ? err.stack : err}`);
		}
	}
}

/**
 * Fires on any zone/output change. `seekOnly` is true when the only thing
 * that changed is playback position (Roon sends that every second while
 * anything plays); most actions can ignore those.
 */
export const onZonesChanged = (listener: ZoneListener) => subscribe(zoneListeners, listener);
export const onStatusChanged = (listener: () => void) => subscribe(statusListeners, listener);
/** Fires when the discovered-Cores list or the paired Core changes. */
export const onCoresChanged = (listener: () => void) => subscribe(coreListeners, listener);

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getConnectionStatus(): ConnectionStatus {
	return connectionStatus;
}

export function getPairedCore(): PairedCore | null {
	return pairedCore;
}

export function getDiscoveredCores(): DiscoveredCore[] {
	const now = Date.now();
	for (const [id, core] of discoveredCores) {
		if (now - core.lastSeen > CORE_STALE_MS && id !== pairedCore?.id) {
			discoveredCores.delete(id);
		}
	}
	return [...discoveredCores.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getZones(): any[] {
	return Object.values(zones).sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
}

function toOutput(zone: any, output: any): RoonOutput {
	const result: RoonOutput = {
		outputId: output.output_id,
		zoneId: zone.zone_id,
		displayName: output.display_name,
		state: zone.state,
		isNextAllowed: zone.is_next_allowed,
		isPreviousAllowed: zone.is_previous_allowed,
		isPauseAllowed: zone.is_pause_allowed,
		isPlayAllowed: zone.is_play_allowed,
		isSeekAllowed: zone.is_seek_allowed,
	};

	if (output.volume) {
		result.volume = {
			type: output.volume.type,
			min: output.volume.min,
			max: output.volume.max,
			value: output.volume.value,
			step: output.volume.step,
			isMuted: output.volume.is_muted === true,
		};
	}

	if (zone.settings) {
		result.loop = zone.settings.loop;
		result.shuffle = zone.settings.shuffle;
		result.autoRadio = zone.settings.auto_radio;
	}

	const np = zone.now_playing;
	if (np) {
		result.seekPosition = np.seek_position;
		result.trackLength = np.length;
		result.imageKey = np.image_key;
		const lines = np.three_line ?? np.two_line;
		if (lines) {
			result.songName = lines.line1;
			result.artistName = lines.line2;
			result.albumName = lines.line3;
		}
	}

	return result;
}

/** Every output across every zone, sorted by name. */
export function getOutputs(): RoonOutput[] {
	const result: RoonOutput[] = [];
	for (const zone of Object.values(zones)) {
		for (const output of zone.outputs ?? []) {
			result.push(toOutput(zone, output));
		}
	}
	return result.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Finds an output by id, falling back to its display name (the original
 * plugin matched by name only). Output ids are stable, but the name
 * fallback keeps a key working if an output is re-added to Roon.
 */
export function findOutput(outputId?: string, outputName?: string): RoonOutput | null {
	const all = getOutputs();
	if (outputId) {
		const byId = all.find((o) => o.outputId === outputId);
		if (byId) {
			return byId;
		}
	}
	if (outputName) {
		const lower = outputName.toLowerCase();
		return all.find((o) => o.displayName.toLowerCase() === lower) ?? null;
	}
	return null;
}

export function getTransport(): any {
	return transport;
}

export function getBrowse(): any {
	return core?.services?.RoonApiBrowse ?? null;
}

/**
 * Fetches an image from the paired Core as a data URI. Roon does the
 * scaling/cropping itself (`fill` = center-crop to cover, `fit` = letterbox
 * inside), so nothing has to be decoded here.
 */
export function getImage(
	imageKey: string,
	options: { scale: "fit" | "fill" | "stretch"; width: number; height: number; format: "image/jpeg" | "image/png" },
): Promise<string> {
	return new Promise((resolve, reject) => {
		const image = core?.services?.RoonApiImage;
		if (!image) {
			reject(new Error("not connected"));
			return;
		}
		image.get_image(imageKey, options, (err: unknown, contentType: string, body: Buffer) => {
			if (err) {
				reject(err);
			} else {
				resolve(`data:${contentType};base64,${Buffer.from(body).toString("base64")}`);
			}
		});
	});
}

function setCore(value: any): void {
	core = value;
}

export function isConnected(): boolean {
	return core !== null;
}

function setConnectionStatus(next: ConnectionStatus): void {
	connectionStatus = next;
	log.info(`status -> ${next.phase}${next.detail ? ` (${next.detail})` : ""}`);
	notify(statusListeners);
}

/**
 * Records an error against the on-device status instead of letting it
 * silently crash the whole plugin process. Called both from this module's
 * own try/catch and from plugin.ts's process-level uncaughtException/
 * unhandledRejection handlers.
 */
export function reportFatalError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	const stack = err instanceof Error ? err.stack : undefined;
	log.error(`fatal error: ${stack ?? message}`);
	setConnectionStatus({ phase: "error", detail: message.slice(0, 60) });
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

function subscribeZones(): void {
	transport.subscribe_zones((cmd: string, body: any) => {
		let seekOnly = false;

		if (cmd === "Subscribed") {
			zones = {};
			for (const zone of body.zones ?? []) {
				zones[zone.zone_id] = zone;
			}
		} else if (cmd === "Changed") {
			const structural =
				(body.zones_added?.length ?? 0) + (body.zones_changed?.length ?? 0) + (body.zones_removed?.length ?? 0);
			seekOnly = structural === 0 && (body.zones_seek_changed?.length ?? 0) > 0;

			for (const zone of body.zones_added ?? []) {
				zones[zone.zone_id] = zone;
			}
			for (const zone of body.zones_changed ?? []) {
				zones[zone.zone_id] = zone;
			}
			for (const seek of body.zones_seek_changed ?? []) {
				const zone = zones[seek.zone_id];
				if (zone) {
					if (zone.now_playing) {
						zone.now_playing.seek_position = seek.seek_position;
					}
					zone.queue_time_remaining = seek.queue_time_remaining;
				}
			}
			for (const zoneId of body.zones_removed ?? []) {
				delete zones[zoneId];
			}
		}

		notify(zoneListeners, seekOnly);
	});
}

// ---------------------------------------------------------------------------
// Discovery / Core picker
// ---------------------------------------------------------------------------

/** Sends a fresh discovery query right away, instead of waiting for the next periodic one. */
export function rescan(): void {
	try {
		roon?._sood?.query({ query_service_id: ROON_CORE_SERVICE_ID });
	} catch (err) {
		log.warn(`rescan failed: ${err}`);
	}
}

export type SwitchCoreResult = { ok: true } | { ok: false; reason: "unknown-core" | "not-approved" | "not-started" };

/**
 * Pairs with a different Core. Uses the library's own pairing service, the
 * exact lost_core/found_core sequence its "pair" request handler runs when
 * a Core asks to take over, and remembers the choice so it sticks across
 * restarts. The target Core must already have this extension enabled in
 * its own Settings > Extensions (each Core approves extensions separately).
 */
export function switchCore(coreId: string): SwitchCoreResult {
	if (!roon?.pairing_service_1) {
		return { ok: false, reason: "not-started" };
	}

	const target = discoveredCores.get(coreId);
	if (!target) {
		return { ok: false, reason: "unknown-core" };
	}

	// Match the registered connection by Core id (SOOD's unique_id is the
	// same id the Core registers with), falling back to its address.
	const moo =
		[...connections.values()].find((m) => m?.core?.core_id === target.id) ??
		connections.get(`${target.host}:${target.port}`);
	if (!moo?.core) {
		return { ok: false, reason: "not-approved" };
	}

	const pairing = roon.pairing_service_1;
	if (roon.paired_core_id !== moo.core.core_id) {
		if (roon.paired_core) {
			pairing.lost_core(roon.paired_core);
		}
		delete roon.paired_core_id;
		delete roon.paired_core;
	}
	pairing.found_core(moo.core);

	const state = loadRoonState();
	state.preferred_core_id = moo.core.core_id;
	saveRoonState(state);

	return { ok: true };
}

// ---------------------------------------------------------------------------
// Manual address
// ---------------------------------------------------------------------------

export interface ManualCore {
	host: string;
	port: number;
}

/** Roon Server's API port. */
export const DEFAULT_ROON_PORT = 9330;

let manualCore: ManualCore | null = null;
let manualRetry: NodeJS.Timeout | null = null;

export function getManualCore(): ManualCore | null {
	return manualCore;
}

export type SetManualResult = { ok: true } | { ok: false; reason: "bad-host" | "bad-port" | "not-started" };

/**
 * Connects to a Core at a typed-in address, for networks where discovery
 * doesn't reach it (VLANs, VPNs, multicast filtering). Discovery keeps
 * running alongside; the manual address is simply one more connection,
 * and once its Core registers it becomes the paired one. Remembered
 * across restarts until cleared.
 */
export function setManualCore(host: string, port: number): SetManualResult {
	const cleanHost = host.trim();
	if (!cleanHost || /[\s/:]/.test(cleanHost)) {
		return { ok: false, reason: "bad-host" };
	}
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		return { ok: false, reason: "bad-port" };
	}
	if (!roon) {
		return { ok: false, reason: "not-started" };
	}

	if (manualCore && (manualCore.host !== cleanHost || manualCore.port !== port)) {
		closeManualConnection();
	}
	manualCore = { host: cleanHost, port };
	const state = loadRoonState();
	state.manual_core = manualCore;
	saveRoonState(state);
	log.info(`manual Core address set: ${cleanHost}:${port}`);

	connectManual(true);
	notify(coreListeners);
	return { ok: true };
}

/** Back to discovery only. Drops the manual connection unless discovery also knows that Core. */
export function clearManualCore(): void {
	if (!manualCore) return;
	const where = `${manualCore.host}:${manualCore.port}`;
	log.info(`manual Core address cleared (${where})`);
	const closing = connections.get(where);
	const wasPaired = !!pairedCore && `${pairedCore.host}:${pairedCore.port}` === where;
	const closed = closeManualConnection();
	manualCore = null;
	const state = loadRoonState();
	delete state.manual_core;
	saveRoonState(state);

	// The library never fails over by itself: a Core that registered while
	// another was paired stays unpaired until something calls found_core.
	// So if the manual Core was the one in use and it's going away, pair
	// with any other Core that's already registered.
	if (wasPaired && closed) {
		const fallback = [...connections.values()].find((m) => m !== closing && m?.core);
		if (fallback) {
			log.info(`falling back to "${fallback.core.display_name}"`);
			pairWith(fallback);
		}
	}
	rescan();
	notify(coreListeners);
}

/** Closes the manual connection; returns whether one was actually closed. */
function closeManualConnection(): boolean {
	if (manualRetry) {
		clearTimeout(manualRetry);
		manualRetry = null;
	}
	if (!manualCore) return false;
	const where = `${manualCore.host}:${manualCore.port}`;
	const moo = connections.get(where);
	// Keep it if discovery found the same Core; it's a normal connection then.
	const discovered = [...discoveredCores.values()].some((c) => `${c.host}:${c.port}` === where);
	if (moo && !discovered) {
		try {
			moo.transport.close();
			return true;
		} catch (err) {
			log.warn(`couldn't close manual connection to ${where}: ${err}`);
		}
	}
	return false;
}

/**
 * Opens the manual connection if it isn't open already, and makes its Core
 * the paired one once (or as soon as) it has registered. `wantPair` is
 * true on a fresh request from the panel; on a reconnect it stays with
 * whatever is paired.
 */
function connectManual(wantPair: boolean): void {
	if (!roon || !manualCore) return;
	const where = `${manualCore.host}:${manualCore.port}`;
	if (wantPair) pairManualWhenRegistered = where;

	const existing = connections.get(where);
	if (existing) {
		if (existing.core && wantPair) {
			pairManualWhenRegistered = null;
			pairWith(existing);
		}
		return;
	}

	log.info(`connecting to manual Core address ${where}`);
	roon.ws_connect({
		host: manualCore.host,
		port: manualCore.port,
		onclose: () => {
			// Only the manual address retries on its own; discovery handles
			// the rest by re-answering SOOD queries.
			if (manualCore && `${manualCore.host}:${manualCore.port}` === where && !manualRetry) {
				manualRetry = setTimeout(() => {
					manualRetry = null;
					connectManual(false);
				}, 10_000);
			}
		},
	});
}

/** "host:port" of a manual connection whose Core should be paired as soon as it registers. */
let pairManualWhenRegistered: string | null = null;

/** Pairs with a registered connection (the switchCore sequence) and remembers it. */
function pairWith(moo: any): void {
	const pairing = roon?.pairing_service_1;
	if (!pairing || !moo?.core) return;
	if (roon.paired_core_id !== moo.core.core_id) {
		if (roon.paired_core) pairing.lost_core(roon.paired_core);
		delete roon.paired_core_id;
		delete roon.paired_core;
	}
	pairing.found_core(moo.core);
	const state = loadRoonState();
	state.preferred_core_id = moo.core.core_id;
	saveRoonState(state);
}

function recordDiscoveredCore(msg: any): void {
	const id = String(msg.props.unique_id);
	const existing = discoveredCores.get(id);
	const port = Number(msg.props.http_port);

	// A Core can answer on more than one network interface (and a PC with
	// several adapters hears it on each), so replies for the same Core can
	// arrive from different addresses. Keep the address we already have a
	// live connection to, so the list doesn't flicker between addresses and
	// always shows the one actually in use.
	const keepExistingHost = !!existing && connections.has(`${existing.host}:${existing.port}`);

	const core: DiscoveredCore = {
		id,
		name: msg.props.name ?? msg.props.display_name ?? "Roon Core",
		version: msg.props.display_version ?? "",
		host: keepExistingHost ? existing!.host : msg.from?.ip,
		port: keepExistingHost ? existing!.port : port,
		lastSeen: Date.now(),
	};
	discoveredCores.set(id, core);

	const changed =
		!existing || existing.name !== core.name || existing.host !== core.host || existing.port !== core.port;
	if (changed) {
		log.info(`discovered Core: ${core.name} @ ${core.host}:${core.port}`);
		notify(coreListeners);
	}
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

export function startRoonConnection(): void {
	if (roon) {
		return;
	}

	try {
		roon = new RoonApi({
			extension_id: "com.vulkan.roon-dialed-up",
			display_name: "Roon: Dialed Up",
			display_version: "2.1.0",
			publisher: "Vulkandr",
			email: "vulkandr@users.noreply.github.com",
			website: "https://github.com/Vulkandr",

			get_persisted_state: loadRoonState,
			set_persisted_state: saveRoonState,

			core_paired: (paired: any) => {
				// When the paired Core id was preloaded from saved state (see
				// below), the library skips recording the Core object itself;
				// record it so a later switch can unpair it cleanly.
				roon.paired_core ??= paired;

				const where = [...connections.entries()].find(([, moo]) => moo === paired.moo)?.[0];
				const [host, port] = where ? where.split(":") : [];
				pairedCore = { id: paired.core_id, name: paired.display_name, host, port: port ? Number(port) : undefined };

				log.info(`paired with core "${paired.display_name}" (${where ?? "unknown address"})`);
				setCore(paired);
				transport = paired.services.RoonApiTransport;
				roonStatusService?.set_status(`Connected to ${paired.display_name}`, false);
				setConnectionStatus({ phase: "paired", detail: paired.display_name });
				notify(coreListeners);
				subscribeZones();
			},

			core_unpaired: (lost: any) => {
				// The library calls this whenever *any* registered Core's
				// connection drops, not only the paired one (its lost_core
				// has no guard around the callback). Only tear down if it's
				// actually the Core we're using.
				if (pairedCore && lost.core_id !== pairedCore.id) {
					log.info(`non-paired core "${lost.display_name}" went away`);
					return;
				}
				log.info(`unpaired from core "${lost.display_name}"`);
				setCore(null);
				transport = null;
				zones = {};
				pairedCore = null;
				setConnectionStatus({ phase: "unpaired", detail: lost.display_name });
				notify(coreListeners);
				notify(zoneListeners, false);
			},
		});

		roonStatusService = new RoonApiStatus(roon);

		roon.init_services({
			required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
			provided_services: [roonStatusService],
		});

		// The library remembers which Core it paired with but never reads it
		// back on startup, so without this it would pair with whichever Core
		// happens to answer first after every restart. Preloading it makes a
		// Core picked in the settings panel stick.
		const preferred = loadRoonState().preferred_core_id;
		if (preferred) {
			roon.paired_core_id = preferred;
		}

		// Wraps the library's own ws_connect (which start_discovery() calls
		// for each Core that answers) to track each connection and show each
		// step between "found it" and "paired". Behavior is unchanged: this
		// only observes open/close and passes everything through.
		const originalWsConnect = roon.ws_connect.bind(roon);
		roon.ws_connect = (opts: { host: string; port: number; onclose?: () => void }) => {
			const where = `${opts.host}:${opts.port}`;
			// One connection per address: a manually entered Core that
			// discovery then also finds (or the reverse) must not register
			// twice. Discovery ignores the return value, so handing back the
			// live connection is enough.
			const live = connections.get(where);
			if (live) {
				log.info(`ws_connect -> ${where} (already connected, reusing)`);
				return live;
			}
			log.info(`ws_connect -> ${where}`);
			if (connectionStatus.phase !== "paired") {
				setConnectionStatus({ phase: "connecting", detail: where });
			}

			let closedHandled = false;
			const onClosed = (reason: string) => {
				if (closedHandled) return;
				closedHandled = true;
				log.warn(`websocket to ${where} ${reason}`);
				connections.delete(where);
				// Let discovery reconnect to this Core next time it answers
				// (its own onclose only runs for the connection it opened,
				// which may have been the reused one above).
				for (const c of discoveredCores.values()) {
					if (`${c.host}:${c.port}` === where) delete roon._sood_conns?.[c.id];
				}
				if (connectionStatus.phase !== "paired" && connectionStatus.phase !== "error") {
					setConnectionStatus({ phase: "connection-closed", detail: where });
				}
				opts.onclose?.();
			};

			const moo = originalWsConnect({ ...opts, onclose: () => onClosed("closed") });
			connections.set(where, moo);

			// The library's transport has no error handler and only reports a
			// close after a successful open. A refused or unreachable address
			// (possible with a typed-in one) would otherwise throw out of the
			// socket and never be noticed as gone; handle both here.
			const ws = moo.transport?.ws;
			if (ws) {
				ws.onerror = (ev: any) => {
					log.warn(`websocket to ${where} error: ${ev?.message ?? ev?.error?.message ?? "unknown"}`);
				};
				ws.on?.("close", () => {
					if (!moo.transport._isonopencalled) onClosed("couldn't connect");
				});
			}

			const originalOnOpen = moo.transport.onopen;
			moo.transport.onopen = () => {
				log.info(`websocket to ${where} open, registering`);
				if (connectionStatus.phase !== "paired") {
					setConnectionStatus({ phase: "awaiting-approval", detail: where });
				}
				originalOnOpen();
			};

			return moo;
		};

		// A Core that registers over the manual address becomes the paired
		// one, whatever was paired before (the user asked for it by name).
		const pairing = roon.pairing_service_1;
		if (pairing) {
			const originalFoundCore = pairing.found_core;
			pairing.found_core = (found: any) => {
				const where = [...connections.entries()].find(([, moo]) => moo === found?.moo)?.[0];
				if (where && where === pairManualWhenRegistered && roon.paired_core_id !== found.core_id) {
					pairManualWhenRegistered = null;
					if (roon.paired_core) pairing.lost_core(roon.paired_core);
					delete roon.paired_core_id;
					delete roon.paired_core;
					const state = loadRoonState();
					state.preferred_core_id = found.core_id;
					saveRoonState(state);
				}
				originalFoundCore(found);
			};
		}

		roonStatusService.set_status("Looking for a Roon Core...", false);
		setConnectionStatus({ phase: "searching" });
		roon.start_discovery();

		const savedManual = loadRoonState().manual_core;
		if (savedManual?.host && Number.isInteger(savedManual.port)) {
			manualCore = { host: String(savedManual.host), port: Number(savedManual.port) };
			connectManual(false);
		}

		// Listens on the same SOOD socket start_discovery() just opened
		// (roon._sood is internal, but this only observes) to build the
		// "Available Cores" list and drive the early status phases.
		//
		// This process's own outbound query is delivered straight back to
		// this socket by normal OS multicast loopback, from this machine's
		// own addresses. A message is only a genuine Core reply when it
		// carries Roon's Core `service_id` AND a `unique_id` -- the same
		// check the library itself uses to decide what to connect to.
		try {
			roon._sood?.on("message", (msg: any) => {
				const isGenuineCoreReply = msg?.props?.service_id === ROON_CORE_SERVICE_ID && !!msg?.props?.unique_id;

				if (isGenuineCoreReply) {
					recordDiscoveredCore(msg);
					// RoonApi's own listener (registered first) has usually
					// already moved the status on to "connecting" for this same
					// reply, so only fill in the earlier phases.
					if (connectionStatus.phase === "searching" || connectionStatus.phase === "self-loopback-only") {
						const name = msg.props.name ?? "Roon Core";
						setConnectionStatus({ phase: "heard-broadcast", detail: `${name} @ ${msg.from?.ip}` });
					}
				} else if (connectionStatus.phase === "searching") {
					setConnectionStatus({ phase: "self-loopback-only", detail: msg?.from?.ip ?? "unknown" });
				}
			});
		} catch (err) {
			log.warn(`couldn't attach SOOD listener: ${err}`);
		}
	} catch (err) {
		reportFatalError(err);
	}
}
