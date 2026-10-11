import streamDeck from "@elgato/streamdeck";
import { RoonLibraryClient, UnsupportedCoreError, type AddMode, type TrackInfo } from "roon-library-controls";

import { getPairedCore, onStatusChanged } from "./roon-connection";

const log = streamDeck.logger.createScope("library-link");

/**
 * Hearts and add-to-library for the "Add to Library / Heart" key.
 *
 * The official Roon extension API can't do either, so this opens a second,
 * separate connection to the paired Core over the protocol Roon's own apps
 * use (roon-library-controls, TCP 9332). Unofficial: a Roon update can
 * break it, in which case the Core turns us down and the key dims.
 *
 * The link only runs while at least one such key is on a deck (like the
 * Toasted poller): `watchLibrary()` starts it and the returned function
 * stops it when the last key goes away. It follows the paired Core (host
 * and id from the normal connection), reconnects with backoff when the
 * session drops, and starts a fresh session once a day so the Core
 * doesn't keep a session's objects forever.
 */

export type LibraryPhase = "off" | "waiting" | "connecting" | "ready" | "unsupported" | "unavailable";

export interface LibraryStatus {
	phase: LibraryPhase;
	detail?: string;
}

const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
// Changing pages removes every key on the old page before showing the new one,
// so the link must outlive a moment with no key on screen. It stops only after
// no key has been visible for this long.
const IDLE_STOP_MS = 10 * 60 * 1000;

/** Heart keys on screen. */
let heartKeys = 0;
/** Other Dialed Up keys and dials on screen (see keepLibraryWarm). */
let otherKeys = 0;
/** A Heart key has been on screen since the plugin started. */
let heartSeen = false;
let client: RoonLibraryClient | null = null;
let status: LibraryStatus = { phase: "off" };
let generation = 0;
let attempt = 0;
let retryTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let linkedTo = ""; // "host|coreId" of the session in progress
const listeners = new Set<() => void>();

export function getLibraryStatus(): LibraryStatus {
	return status;
}

/** Fires when the link's status changes or a zone's track state does. */
export function onLibraryChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify(): void {
	for (const l of listeners) l();
}

function setStatus(next: LibraryStatus): void {
	if (next.phase === status.phase && next.detail === status.detail) return;
	status = next;
	log.info(`library link ${next.phase}${next.detail ? `: ${next.detail}` : ""}`);
	notify();
}

/** The zone's current track with its heart / library state (null when nothing is loaded or not ready). */
export function getLibraryTrack(zoneId: string | undefined): TrackInfo | null {
	if (!zoneId || !client || status.phase !== "ready") return null;
	return client.trackForZone(zoneId);
}

export function isLibraryReady(): boolean {
	return status.phase === "ready" && client !== null;
}

/** Hearts (or un-hearts) the zone's track; adds it to the library first, per `mode`, when hearting. */
export async function libraryHeart(zoneId: string, favorite: boolean, mode: AddMode): Promise<TrackInfo> {
	if (!client || status.phase !== "ready") throw new Error("library link not ready");
	return client.setFavorite(zoneId, favorite, { addToLibrary: mode });
}

/** Adds the zone's track (or its whole album) to the library. */
export async function libraryAdd(zoneId: string, mode: AddMode): Promise<TrackInfo> {
	if (!client || status.phase !== "ready") throw new Error("library link not ready");
	return client.addToLibrary(zoneId, mode);
}

/** How many on-screen keys want the link open right now. */
function activeWatchers(): number {
	return heartKeys + (heartSeen ? otherKeys : 0);
}

/** Starts the link when the first watcher arrives, schedules the idle stop when the last one leaves. */
function watchersChanged(before: number): void {
	const now = activeWatchers();
	if (now > 0) {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
		if (before === 0) reconsider();
		return;
	}
	if (before === 0) return;
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		idleTimer = null;
		if (activeWatchers() > 0) return;
		log.info("no Dialed Up key on screen for a while, closing the library link");
		stop();
		setStatus({ phase: "off" });
	}, IDLE_STOP_MS);
}

function holder(add: () => void, remove: () => void): () => void {
	const before = activeWatchers();
	add();
	watchersChanged(before);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const b = activeWatchers();
		remove();
		watchersChanged(b);
	};
}

/**
 * Keeps the link up while the returned function hasn't been called. Each
 * Heart key on screen holds one.
 */
export function watchLibrary(): () => void {
	return holder(
		() => {
			heartKeys++;
			heartSeen = true;
		},
		() => {
			heartKeys = Math.max(0, heartKeys - 1);
		},
	);
}

/**
 * Held by every other Dialed Up key and dial on screen. Once a Heart key has
 * been seen since the plugin started, these keep the link open too, so a
 * Heart key coming back after a page change finds it already connected
 * instead of waiting for a new session (about 3 s). Before any Heart key has
 * appeared they do nothing, so people who never use it never open this
 * connection.
 */
export function keepLibraryWarm(): () => void {
	return holder(
		() => {
			otherKeys++;
		},
		() => {
			otherKeys = Math.max(0, otherKeys - 1);
		},
	);
}

onStatusChanged(() => {
	if (activeWatchers() > 0) reconsider();
});

function clearTimers(): void {
	if (retryTimer) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
}

function stop(): void {
	generation++;
	clearTimers();
	linkedTo = "";
	attempt = 0;
	if (client) {
		client.close();
		client = null;
	}
}

/** Connects to the paired Core if it isn't the one we're linked to already. */
function reconsider(): void {
	const paired = getPairedCore();
	if (!paired?.host || !paired.id) {
		if (linkedTo) stop();
		setStatus({ phase: "waiting", detail: "Waiting for the Roon Core." });
		return;
	}
	const key = `${paired.host}|${paired.id}`;
	if (key === linkedTo) return; // same Core, session (or its retries) already in progress
	stop();
	linkedTo = key;
	void run(generation, paired.host, paired.id);
}

async function run(gen: number, host: string, coreId: string): Promise<void> {
	if (gen !== generation) return;
	setStatus({ phase: "connecting" });
	const next = new RoonLibraryClient({ host, coreId, log: (m) => log.debug(m) });
	next.on("track", () => notify());
	next.on("disconnected", (reason) => {
		if (gen !== generation || client !== next) return;
		client = null;
		setStatus({ phase: "unavailable", detail: `Lost the connection: ${reason?.message ?? "closed by the Core"}` });
		scheduleRetry(gen, host, coreId);
	});
	try {
		await next.connect();
	} catch (err) {
		if (gen !== generation) {
			next.close();
			return;
		}
		if (err instanceof UnsupportedCoreError) {
			// A Roon we don't speak: no point retrying until the Core changes or the plugin restarts.
			setStatus({ phase: "unsupported", detail: `Not supported with this Roon version (${err.message}).` });
			return;
		}
		setStatus({ phase: "unavailable", detail: `Couldn't connect: ${err instanceof Error ? err.message : String(err)}` });
		scheduleRetry(gen, host, coreId);
		return;
	}
	if (gen !== generation) {
		next.close();
		return;
	}
	client = next;
	attempt = 0;
	setStatus({ phase: "ready" });
	refreshTimer = setTimeout(() => {
		if (gen !== generation || client !== next) return;
		log.info("daily reconnect");
		client = null;
		next.close();
		void run(gen, host, coreId);
	}, REFRESH_AFTER_MS);
}

function scheduleRetry(gen: number, host: string, coreId: string): void {
	const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
	attempt++;
	retryTimer = setTimeout(() => {
		retryTimer = null;
		void run(gen, host, coreId);
	}, delay);
}
