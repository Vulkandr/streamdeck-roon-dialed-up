import streamDeck from "@elgato/streamdeck";

import { isRoonToastedInstalled } from "./roon-toasted-link";

const log = streamDeck.logger.createScope("roon-toasted-status");

/**
 * Whether Roon: Toasted is running, asked the same way the plugin watches
 * the Roon Core: Toasted, while it runs, answers a tiny read-only status
 * request on its own PC-only address, and this polls it. No answer means
 * it isn't running. The answer also says whether Toasted itself is
 * connected to Roon, and to which Core.
 *
 * The address and reply shape are the contract with Roon: Toasted:
 *   GET http://127.0.0.1:58421/status
 *   { "app": "Roon: Toasted", "version": "0.9.0", "roon": "connected", "core": "Core name" }
 * Only `app` is required; the rest is shown when present.
 */
export const TOASTED_STATUS_URL = "http://127.0.0.1:58421/status";

export type ToastedPhase = "running" | "not-running" | "not-installed";

export interface ToastedStatus {
	phase: ToastedPhase;
	version?: string;
	/** Toasted's own Roon connection: "connected", or whatever state it reports. */
	roon?: string;
	core?: string;
}

const POLL_MS = 3000;
const TIMEOUT_MS = 1000;

let current: ToastedStatus = { phase: "not-running" };
let timer: NodeJS.Timeout | null = null;
let watchers = 0;
let inFlight = false;
const listeners = new Set<() => void>();

export function getToastedStatus(): ToastedStatus {
	return current;
}

export function onToastedStatusChanged(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

async function probe(): Promise<ToastedStatus> {
	try {
		const res = await fetch(TOASTED_STATUS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (res.ok) {
			const body = (await res.json()) as Record<string, unknown>;
			if (typeof body.app === "string" && /toasted/i.test(body.app)) {
				return {
					phase: "running",
					version: typeof body.version === "string" ? body.version : undefined,
					roon: typeof body.roon === "string" ? body.roon : undefined,
					core: typeof body.core === "string" && body.core ? body.core : undefined,
				};
			}
		}
	} catch {
		// Refused, timed out, or not JSON: not running (the normal case).
	}
	return { phase: isRoonToastedInstalled() ? "not-running" : "not-installed" };
}

export async function refreshToastedStatus(): Promise<ToastedStatus> {
	if (inFlight) return current;
	inFlight = true;
	try {
		const next = await probe();
		const changed = JSON.stringify(next) !== JSON.stringify(current);
		current = next;
		if (changed) {
			log.info(`Roon: Toasted ${next.phase}${next.version ? ` v${next.version}` : ""}${next.core ? ` (${next.core})` : ""}`);
			for (const l of listeners) l();
		}
	} finally {
		inFlight = false;
	}
	return current;
}

/**
 * Starts polling while at least one Toaster/Search button is on a deck;
 * call the returned function when it goes away. Nothing runs otherwise.
 */
export function watchToasted(): () => void {
	watchers++;
	if (!timer) {
		void refreshToastedStatus();
		timer = setInterval(() => void refreshToastedStatus(), POLL_MS);
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		watchers--;
		if (watchers <= 0 && timer) {
			clearInterval(timer);
			timer = null;
			watchers = 0;
		}
	};
}
