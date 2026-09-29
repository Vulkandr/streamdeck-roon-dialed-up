import { exec, execSync } from "node:child_process";
import streamDeck from "@elgato/streamdeck";

const log = streamDeck.logger.createScope("roon-toasted-link");

// Roon: Toasted registers this custom URL scheme with Windows the first
// time it's launched (its own installer/first-run step, not this plugin's
// job). We just check whether that registration exists, so a Launch App/
// Search button press can tell "app installed, not running yet" (still
// fine, the URL launch starts it) apart from "app never installed at all"
// (in which case we send the person to the GitHub page instead of a URL
// the OS won't know what to do with).
//
// NOTE: this is the exact same approach the old CEF-hosted plugin tried to
// use, but there `process.platform`/`execSync` resolved to empty browser
// polyfill stubs (no real Node runtime), so the check always silently
// reported "installed" and the launch below never had a working
// `child_process` to run through. Under the Node.js SDK this is a real
// Node process, so both actually work.
const REGISTRY_KEY = "HKCU\\Software\\Classes\\roon-toasted";

// Windows resolves a custom scheme lookup in well under the width of a
// key press, but there's no reason to shell out to `reg query` on every
// single icon refresh. Cache briefly and re-check on a short TTL rather
// than either per-call cost or a stale forever-cached answer if the
// person installs the app mid-session.
const CACHE_MS = 10000;
let cachedResult: boolean | null = null;
let cachedAt = 0;

function queryRegistry(): boolean {
	if (process.platform !== "win32") {
		// Roon: Toasted is Windows-only. Elsewhere the button shows
		// "Install" and links to its page instead of doing nothing.
		return false;
	}

	try {
		execSync(`reg query "${REGISTRY_KEY}"`, { stdio: ["ignore", "ignore", "ignore"] });
		return true;
	} catch (err) {
		// reg query exits non-zero (and throws here) when the key doesn't
		// exist, which is the expected, common "not installed yet" case,
		// not a real error -- so this is deliberately silent.
		return false;
	}
}

/**
 * Whether Roon: Toasted appears to be installed on this machine, per the
 * roon-toasted:// URL scheme registration it leaves in the registry on
 * first run. Windows-only: always false elsewhere.
 */
export function isRoonToastedInstalled(): boolean {
	const now = Date.now();
	if (cachedResult === null || now - cachedAt > CACHE_MS) {
		cachedResult = queryRegistry();
		cachedAt = now;
		log.debug(`registry check: ${cachedResult ? "installed" : "not installed"}`);
	}
	return cachedResult;
}

/**
 * Forces the next isRoonToastedInstalled() call to re-check rather than
 * use the cached value. Call this after a button press that leads to an
 * install (so the very next icon refresh can pick up "just installed"
 * rather than waiting out the cache window).
 */
export function invalidateRoonToastedInstallCache(): void {
	cachedResult = null;
}

export const ROON_TOASTED_GITHUB_URL = "https://github.com/Vulkandr/roon-toasted";

// Filled in once Vulk's own site is live; the "not installed" state and
// this button's future Property Inspector link both read from here, so
// there's exactly one place to update when it exists.
export const ROON_TOASTED_WEBSITE_URL: string | null = null;

export function buildOpenUrl(scheme: string): string {
	return `roon-toasted://${scheme}`;
}

/**
 * Launches (or focuses) Roon: Toasted on a specific screen via its custom
 * URL scheme. `streamDeck.system.openUrl()` explicitly does not support
 * custom schemes ("my-app://") as of SDK v3, so this shells out directly
 * instead -- the same mechanism a manual Win+R launch uses. `start` is a
 * cmd.exe builtin rather than its own executable, and `exec()` already
 * runs its command through a shell, so this needs the empty `""` title
 * argument `start` expects when the following argument is quoted.
 */
export function openRoonToasted(scheme: string): void {
	const url = buildOpenUrl(scheme);

	if (process.platform === "win32") {
		exec(`start "" "${url}"`, (err) => {
			if (err) {
				log.error(`failed to launch ${url}: ${err.message}`);
			}
		});
		return;
	}

	// No Mac/Linux build yet -- log rather than silently doing nothing, so
	// this is easy to spot if it ever runs on an unsupported platform.
	log.warn(`openRoonToasted() called on unsupported platform "${process.platform}" for url ${url}`);
}
