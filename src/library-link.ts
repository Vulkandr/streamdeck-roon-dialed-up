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

let watchers = 0;
let client: RoonLibraryClient | null = null;
let status: LibraryStatus = { phase: "off" };
let generation = 0;
let attempt = 0;
let retryTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
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

/**
 * Keeps the link up while the returned function hasn't been called. Each
 * placed key holds one; the link stops when the last one is released.
 */
export function watchLibrary(): () => void {
	watchers++;
	if (watchers === 1) {
		reconsider();
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		watchers--;
		if (watchers <= 0) {
			watchers = 0;
			stop();
			setStatus({ phase: "off" });
		}
	};
}

// The paired Core can change (switching Cores, re-pairing); follow it.
onStatusChanged(() => {
	if (watchers > 0) reconsider();
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
