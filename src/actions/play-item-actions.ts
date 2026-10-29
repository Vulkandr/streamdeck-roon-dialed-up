import streamDeck, { action, type KeyUpEvent, type WillAppearEvent } from "@elgato/streamdeck";

import { RoonAction, type RoonKeySettings } from "./roon-action";
import { PlayItemDisabled } from "../data-images/play-item-key-disabled";
import { PlayThisDisabled } from "../data-images/play-this-key-disabled";
import { getBrowse, type RoonOutput } from "../roon-connection";
import { getLibraryPlaylists, isLibraryReady, libraryPlayPlaylist, waitForLibrary, watchLibraryForPlaylists } from "../library-link";

const log = streamDeck.logger.createScope("play-item");
const P = "com.vulkan.roon-dialed-up";

export type ItemType = "albums" | "artists" | "composers" | "internet_radio" | "genres" | "playlists" | "tags";

export interface PlayItemSettings extends RoonKeySettings {
	itemType?: ItemType;
	itemAction?: string;
	itemTitle?: string;
	/**
	 * Playlists picked from the list: Roon's durable PlaylistId (hex) and its
	 * kind ("roon", "smart", "qobuz", "tidal"...). Both come from the library
	 * link (Roon's internal protocol). With them the key plays exactly that
	 * playlist, not the first one with the same name, and smart playlists
	 * play at all (the extension API can't open them).
	 */
	playlistId?: string;
	playlistKind?: string;
}

/** No Roon answer within this long counts as a failure, so nothing can wait forever. */
const BROWSE_TIMEOUT_MS = 10_000;

function call(kind: "browse" | "load", opts: Record<string, unknown>): Promise<any> {
	return new Promise((resolve, reject) => {
		const svc = getBrowse();
		if (!svc) return reject(new Error("not connected"));
		const timer = setTimeout(() => reject(new Error(`${kind} timed out`)), BROWSE_TIMEOUT_MS);
		svc[kind](opts, (err: unknown, result: any) => {
			clearTimeout(timer);
			if (err) reject(new Error(String(err)));
			else resolve(result);
		});
	});
}

const browse = (opts: Record<string, unknown>) => call("browse", opts);
const load = (opts: Record<string, unknown>) => call("load", opts);

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
		case "genres": {
			// Genres are a tree (Pop/Rock > Hard Rock > ...): find where this one sits.
			const where = await findGenre(itemTitle);
			if (!where) {
				log.info(`browse: genre "${itemTitle}" not found anywhere in Roon's genres`);
				return false;
			}
			path = [...where, "Play Genre", itemAction, itemAction];
			break;
		}
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
		log.debug(`browse ${itemType} step ${index}/${path.length} "${step}" -> ${result?.action}${result?.list ? ` list "${result.list.title}" (${result.list.count})` : ""}${result?.message ? ` message "${result.message}"${result.is_error ? " (error)" : ""}` : ""}`);
		// The last step activates the action (Play Now, Queue...). Roon has done it once this
		// call returns; what it answers with varies (a message, or the action list again),
		// so don't look for the action a second time.
		if (index === path.length) {
			return true;
		}
		if (result?.action !== "list") {
			return false;
		}

		let found: any = null;
		let offset = 0;
		const seen: string[] = [];
		while (!found) {
			const page = await load({ hierarchy, offset });
			if (seen.length < 12) seen.push(...(page.items ?? []).slice(0, 12).map((item: any) => `${item.title} [${item.hint}]`));
			found = (page.items ?? []).find((item: any) => item.title?.toLowerCase() === step.toLowerCase()) ?? null;
			offset += page.items?.length ?? 0;
			if (!page.items?.length || offset >= (page.list?.count ?? 0)) break;
		}

		if (!found) {
			log.info(`browse: "${step}" not found at level ${index} (saw: ${JSON.stringify(seen.slice(0, 12))})`);
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
			if (settings.itemType === "playlists") {
				const viaLibrary = await playPlaylistKey(output, settings, title);
				if (viaLibrary !== null) {
					await (viaLibrary ? ev.action.showOk() : ev.action.showAlert());
					return;
				}
			}
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
	/** Smart playlist keys on screen keep the library link up, so the first press is quick. */
	private readonly linkByKey = new Map<string, () => void>();

	protected override get iconName() { return "play-item"; }
	protected override classicDisabledImage() { return PlayItemDisabled; }
	protected override titleFor(settings: PlayItemSettings) { return settings.itemTitle ?? ""; }

	override async onWillAppear(ev: WillAppearEvent<PlayItemSettings>): Promise<void> {
		await super.onWillAppear(ev);
		this.syncLink(ev.action.id, this.settingsByKey.get(ev.action.id) ?? ev.payload.settings);
	}

	protected override onSettingsUpdated(keyId: string, settings: PlayItemSettings): void {
		this.syncLink(keyId, settings);
	}

	protected override onKeyRemoved(keyId: string): void {
		this.linkByKey.get(keyId)?.();
		this.linkByKey.delete(keyId);
	}

	private syncLink(keyId: string, settings: PlayItemSettings): void {
		const wants = settings.itemType === "playlists" && settings.playlistKind === "smart";
		const held = this.linkByKey.get(keyId);
		if (wants && !held) this.linkByKey.set(keyId, watchLibraryForPlaylists());
		else if (!wants && held) {
			held();
			this.linkByKey.delete(keyId);
		}
	}
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

export interface BrowseListItem {
	title: string;
	subtitle: string | null;
	/** From the library link, when it's up: PlaylistType as a word, and the durable id. */
	kind?: string;
	id?: string;
}

/**
 * Lists the playlists Roon's browse service knows, for the settings
 * panel's dropdown. Uses its own browse session (multi_session_key) so
 * opening the panel never disturbs a key press walking the same
 * hierarchy at the same moment.
 *
 * Smart playlists show up here by name too, but the official API can't
 * open or play them, and nothing in its rows tells them apart.
 */
export async function listPlaylists(): Promise<BrowseListItem[]> {
	const session = "dialed-up-panel-list";
	const result = await browse({ hierarchy: "playlists", pop_all: true, multi_session_key: session });
	if (result?.action !== "list") return [];

	const count: number = result.list?.count ?? 0;
	const items: BrowseListItem[] = [];
	let offset = 0;

	while (offset < count) {
		const page = await load({ hierarchy: "playlists", offset, count: 100, multi_session_key: session });
		const rows: any[] = page.items ?? [];
		if (!rows.length) break;
		for (const row of rows) {
			if (typeof row.title !== "string" || !row.title) continue;
			items.push({ title: row.title, subtitle: typeof row.subtitle === "string" ? row.subtitle : null });
		}
		offset += rows.length;
	}

	log.debug(`playlists: ${items.length} listed by the extension API`);
	// Roon lists them oldest first; its own sidebar shows newest first, so match that.
	return items.reverse();
}

/**
 * The list for the settings panel: from the library link when it's up (it
 * knows each playlist's kind and id, so smart, Qobuz and TIDAL ones can be
 * marked and duplicates told apart), else from the extension API (names only).
 */
export async function listPlaylistsForPanel(): Promise<BrowseListItem[]> {
	const release = watchLibraryForPlaylists();
	try {
		await waitForLibrary(6000);
		const internal = getLibraryPlaylists();
		if (internal && internal.length) {
			return internal
				.filter((p) => p.name)
				.map((p) => ({ title: p.name, subtitle: p.trackCount !== null ? `${p.trackCount} Tracks` : null, kind: p.kind, id: p.playlistId ?? undefined }))
				.reverse();
		}
		return await listPlaylists();
	} finally {
		// The link stays up a while after this (idle stop), so picking one right after is quick.
		release();
	}
}

const HOW: Record<string, { how: "now" | "next" | "queue"; shuffle: boolean }> = {
	"Play Now": { how: "now", shuffle: false },
	Shuffle: { how: "now", shuffle: true },
	"Add Next": { how: "next", shuffle: false },
	Queue: { how: "queue", shuffle: false },
};

/**
 * Plays a playlist key through the library link when it should: always for
 * smart playlists (nothing else can), and for any picked playlist (with an
 * id) while the link happens to be up, so the exact one plays. Returns null
 * when the key should fall back to the extension API's browse by name.
 */
async function playPlaylistKey(output: RoonOutput, settings: PlayItemSettings, title: string): Promise<boolean | null> {
	const smart = settings.playlistKind === "smart";
	if (!smart && !(settings.playlistId && isLibraryReady())) return null;
	if (!(await waitForLibrary(smart ? 8000 : 0))) {
		if (smart) log.info(`smart playlist "${title}": the library link isn't up, can't play it`);
		return smart ? false : null;
	}
	const how = HOW[settings.itemAction ?? "Play Now"] ?? HOW["Play Now"];
	try {
		await libraryPlayPlaylist(output.zoneId, settings.playlistId || title, how);
		return true;
	} catch (err) {
		log.warn(`library play of "${title}" failed: ${err}`);
		// A regular playlist can still go the official way; a smart one can't.
		return smart ? false : null;
	}
}

/** Where Roon's search puts each item type, for suggestions while typing a name. */
const SEARCH_CATEGORY: Partial<Record<ItemType, string>> = { artists: "Artists", albums: "Albums", composers: "Composers" };
const SUGGEST_SESSION = "dialed-up-panel-suggest";
const SUGGEST_MAX = 20;
/** Genre, tag and radio station names: short lists, loaded whole and filtered here. Kept a minute. */
const nameCache = new Map<ItemType, { at: number; items: BrowseListItem[] }>();
const nameLoads = new Map<ItemType, Promise<BrowseListItem[]>>();
/** Suggestions share one browse session, so they run one at a time; a newer one replaces any still waiting. */
let suggestChain: Promise<unknown> = Promise.resolve();
let latestSuggest = 0;

async function loadAll(hierarchy: string, maxItems: number): Promise<BrowseListItem[]> {
	const out: BrowseListItem[] = [];
	let offset = 0;
	for (;;) {
		const page = await load({ hierarchy, offset, count: 100, multi_session_key: SUGGEST_SESSION });
		const rows: any[] = page.items ?? [];
		if (!rows.length) break;
		for (const row of rows) {
			if (typeof row.title === "string" && row.title) out.push({ title: row.title, subtitle: typeof row.subtitle === "string" ? row.subtitle : null });
		}
		offset += rows.length;
		if (offset >= (page.list?.count ?? 0) || out.length >= maxItems) break;
	}
	return out;
}

async function namesFor(itemType: ItemType): Promise<BrowseListItem[]> {
	const cached = nameCache.get(itemType);
	if (cached && Date.now() - cached.at < 5 * 60_000) return cached.items;
	const loading = nameLoads.get(itemType);
	if (loading) return loading;
	const job = loadNames(itemType).finally(() => nameLoads.delete(itemType));
	nameLoads.set(itemType, job);
	return job;
}

async function loadNames(itemType: ItemType): Promise<BrowseListItem[]> {
	let items: BrowseListItem[] = [];
	if (itemType === "tags") {
		// Tags live under Library > Tags in the browse hierarchy.
		const open = async (title: string, first: boolean): Promise<boolean> => {
			const r = first
				? await browse({ hierarchy: "browse", pop_all: true, multi_session_key: SUGGEST_SESSION })
				: null;
			if (first && r?.action !== "list") return false;
			const page = await load({ hierarchy: "browse", offset: 0, count: 100, multi_session_key: SUGGEST_SESSION });
			const row = (page.items ?? []).find((i: any) => i.title === title);
			if (!row) return false;
			const next = await browse({ hierarchy: "browse", item_key: row.item_key, multi_session_key: SUGGEST_SESSION });
			return next?.action === "list";
		};
		if ((await open("Library", true)) && (await open("Tags", false))) items = await loadAll("browse", 2000);
	} else {
		const r = await browse({ hierarchy: itemType, pop_all: true, multi_session_key: SUGGEST_SESSION });
		if (r?.action === "list") items = await loadAll(itemType, 5000);
	}
	// An empty list is more likely a hiccup than the truth: don't keep it.
	if (items.length) nameCache.set(itemType, { at: Date.now(), items });
	log.info(`suggest: loaded ${items.length} ${itemType} names`);
	return items;
}

/**
 * Names matching what's typed so far, for the Item title field. Artists,
 * albums and composers come from Roon's own search (library and streaming,
 * like the search in Roon); genres, tags and radio stations from their full
 * lists, filtered here. Names that start with the text come first.
 */
export async function suggestItems(itemType: ItemType, query: string): Promise<BrowseListItem[] | null> {
	const ticket = ++latestSuggest;
	if (itemType === "genres") {
		// Its own browse session and cache, so it waits outside the queue and never holds it up.
		const q = query.trim().toLowerCase();
		if (q.length < 2) return [];
		const all = (await genreTree()).map((g) => ({ title: g.label, subtitle: g.path.length > 1 ? g.path.slice(0, -1).join(" > ") : null }));
		if (ticket !== latestSuggest) return null;
		const starts = all.filter((i) => i.title.toLowerCase().startsWith(q));
		const contains = all.filter((i) => !i.title.toLowerCase().startsWith(q) && i.title.toLowerCase().includes(q));
		return [...starts, ...contains].slice(0, SUGGEST_MAX);
	}
	const run = suggestChain.then(() => (ticket === latestSuggest ? findSuggestions(itemType, query) : null));
	suggestChain = run.catch(() => undefined);
	return run;
}

async function findSuggestions(itemType: ItemType, query: string): Promise<BrowseListItem[]> {
	const q = query.trim().toLowerCase();
	if (q.length < 2 || itemType === "playlists") return [];

	const category = SEARCH_CATEGORY[itemType];
	if (category) {
		const r = await browse({ hierarchy: "search", input: query.trim(), pop_all: true, multi_session_key: SUGGEST_SESSION });
		if (r?.action !== "list") return [];
		const top = await load({ hierarchy: "search", offset: 0, count: 20, multi_session_key: SUGGEST_SESSION });
		const section = (top.items ?? []).find((i: any) => i.title === category);
		if (!section) return [];
		const inner = await browse({ hierarchy: "search", item_key: section.item_key, multi_session_key: SUGGEST_SESSION });
		if (inner?.action !== "list") return [];
		return loadAll("search", SUGGEST_MAX).then((items) => items.slice(0, SUGGEST_MAX));
	}

	const all = await namesFor(itemType);
	const starts = all.filter((i) => i.title.toLowerCase().startsWith(q));
	const contains = all.filter((i) => !i.title.toLowerCase().startsWith(q) && i.title.toLowerCase().includes(q));
	return [...starts, ...contains].slice(0, SUGGEST_MAX);
}

// ---- genres: Roon's genres are a tree -------------------------------------

interface GenreNode {
	/** Titles from the top level down to this genre, e.g. ["Pop/Rock", "Hard Rock", "Metal"]. */
	path: string[];
	/** What the Item title field uses: the genre's own name, or "Parent > Name" when that name is used twice. */
	label: string;
}

const GENRE_SESSION = "dialed-up-genres";
const GENRE_TTL_MS = 60 * 60_000;
const GENRE_MAX_NODES = 400;
const GENRE_MAX_MS = 30_000;
/** Lists on a genre's page that aren't sub-genres. */
const NOT_GENRES = new Set(["Artists", "Albums", "Composers", "Tracks", "Works", "Playlists", "Performers", "Compositions"]);
let genreCache: { at: number; nodes: GenreNode[] } | null = null;
let genreLoad: Promise<GenreNode[]> | null = null;

async function loadLevel(): Promise<any[]> {
	const out: any[] = [];
	let offset = 0;
	for (;;) {
		const page = await load({ hierarchy: "genres", offset, count: 100, multi_session_key: GENRE_SESSION });
		const rows: any[] = page.items ?? [];
		if (!rows.length) break;
		out.push(...rows);
		offset += rows.length;
		if (offset >= (page.list?.count ?? 0)) break;
	}
	return out;
}

/** Every genre with its place in the tree. Walked once and kept for an hour. */
export function genreTree(): Promise<GenreNode[]> {
	if (genreCache && Date.now() - genreCache.at < GENRE_TTL_MS) return Promise.resolve(genreCache.nodes);
	if (genreLoad) return genreLoad;
	genreLoad = walkGenres()
		.then((nodes) => {
			if (nodes.length) genreCache = { at: Date.now(), nodes };
			log.info(`genres: ${nodes.length} in the tree`);
			return nodes;
		})
		.finally(() => {
			genreLoad = null;
		});
	return genreLoad;
}

async function walkGenres(): Promise<GenreNode[]> {
	const paths: string[][] = [];
	const top = await browse({ hierarchy: "genres", pop_all: true, multi_session_key: GENRE_SESSION });
	if (top?.action !== "list") return [];

	// Depth first: open each sub-genre, list it, come back up. Item keys only hold for the
	// list they came from, so a level is listed again after returning to it. A genre's page
	// also lists its artists and albums: those aren't sub-genres, so they're skipped, and a
	// budget stops the walk if Roon's layout ever surprises us.
	const started = Date.now();
	let opened = 0;
	let sampled = 0;
	const overBudget = () => opened >= GENRE_MAX_NODES || Date.now() - started > GENRE_MAX_MS;
	const visit = async (trail: string[], depth: number): Promise<void> => {
		const rows = await loadLevel();
		if (sampled < 3) {
			sampled++;
			log.debug(`genres: "${trail.join(" > ") || "(top)"}" lists ${JSON.stringify(rows.slice(0, 15).map((r) => `${r.title} [${r.hint}${r.subtitle ? `, ${r.subtitle}` : ""}]`))}`);
		}
		const titles = rows
			.filter((row) => row.hint === "list" && typeof row.title === "string" && row.title && !NOT_GENRES.has(row.title))
			.map((row) => row.title as string);
		for (const title of titles) {
			const path = [...trail, title];
			paths.push(path);
			if (depth >= 4 || overBudget()) continue;
			opened++;
			const row = (await loadLevel()).find((r) => r.title === title && r.hint === "list");
			if (!row) continue;
			const inside = await browse({ hierarchy: "genres", item_key: row.item_key, multi_session_key: GENRE_SESSION });
			if (inside?.action === "list") {
				await visit(path, depth + 1);
				await browse({ hierarchy: "genres", pop_levels: 1, multi_session_key: GENRE_SESSION });
			}
		}
	};
	await visit([], 1);
	if (overBudget()) log.warn(`genres: walk stopped early (${opened} opened, ${Date.now() - started} ms); the list may be incomplete`);

	const counts = new Map<string, number>();
	for (const p of paths) counts.set(p[p.length - 1].toLowerCase(), (counts.get(p[p.length - 1].toLowerCase()) ?? 0) + 1);
	return paths.map((path) => {
		const name = path[path.length - 1];
		const label = (counts.get(name.toLowerCase()) ?? 0) > 1 && path.length > 1 ? `${path[path.length - 2]} > ${name}` : name;
		return { path, label };
	});
}

/** The path to a genre typed as its name, or as "Parent > Name". */
async function findGenre(title: string): Promise<string[] | null> {
	const wanted = title.trim().toLowerCase();
	const nodes = await genreTree();
	const byLabel = nodes.find((n) => n.label.toLowerCase() === wanted);
	if (byLabel) return byLabel.path;
	const byName = nodes.find((n) => n.path[n.path.length - 1].toLowerCase() === wanted);
	if (byName) return byName.path;
	// A full path typed out: "Pop/Rock > Hard Rock > Metal".
	const parts = wanted.split(">").map((x) => x.trim()).filter(Boolean);
	if (parts.length > 1) {
		const tail = nodes.find((n) => {
			const p = n.path.map((x) => x.toLowerCase());
			return p.length >= parts.length && parts.every((x, i) => p[p.length - parts.length + i] === x);
		});
		if (tail) return tail.path;
	}
	return null;
}
