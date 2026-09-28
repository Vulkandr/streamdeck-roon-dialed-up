import streamDeck from "@elgato/streamdeck";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

import { fitText } from "./key-image";
import { type TextFont, textPath } from "./text-paths";

const log = streamDeck.logger.createScope("raster");

/**
 * SVG to PNG, for the places Stream Deck needs a bitmap: the touch strip's
 * pixmap items. Uses resvg compiled to WebAssembly (no native module), so
 * it runs anywhere the plugin does. Text is passed in as outlines (see
 * text-paths.ts), so no fonts are involved at this stage.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

let ready: Promise<boolean> | null = null;

function ensureReady(): Promise<boolean> {
	ready ??= (async () => {
		try {
			const wasm = fs.readFileSync(path.join(PLUGIN_ROOT, "node_modules/@resvg/resvg-wasm/index_bg.wasm"));
			await initWasm(wasm);
			return true;
		} catch (err) {
			log.error(`couldn't initialize the SVG rasterizer: ${err}`);
			return false;
		}
	})();
	return ready;
}

/** Renders SVG markup to a PNG data URI at `scale` times its declared size. */
export async function svgToPng(svg: string, scale = 1): Promise<string | null> {
	if (!(await ensureReady())) {
		return null;
	}
	try {
		const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 0) * scale;
		const resvg = new Resvg(svg, width > 0 ? { fitTo: { mode: "width", value: width } } : undefined);
		const png = resvg.render().asPng();
		return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
	} catch (err) {
		log.warn(`rasterize failed: ${err}`);
		return null;
	}
}

export interface StripTextOptions {
	width: number;
	height: number;
	size: number;
	bold?: boolean;
	color: string;
	align: "left" | "center" | "right";
	font?: TextFont;
}

const cache = new Map<string, string>();
const CACHE_MAX = 200;

/**
 * A line of text as a transparent PNG sized to a touch strip layout rect,
 * in the plugin's own font. The strip's built-in text items can't pick a
 * font, so this is what lets titles there match the keys. Rendered at 2x
 * for crispness; the strip scales it down. Cached, since the same title
 * is redrawn on every volume/seek update.
 */
export async function renderStripText(text: string, options: StripTextOptions): Promise<string | null> {
	const key = JSON.stringify([text, options]);
	const hit = cache.get(key);
	if (hit) {
		return hit;
	}

	const { width, height, size, bold = false, color, align, font = "condensed" } = options;
	const pad = 3;
	const fitted = fitText(text, width - pad * 2, size, bold, font);
	const x = align === "left" ? pad : align === "right" ? width - pad : width / 2;
	const anchor = align === "left" ? "start" : align === "right" ? "end" : "middle";
	const d = textPath(fitted, x, height / 2, size, bold, anchor, font);
	if (d === null) {
		return null;
	}

	// Black outline behind the fill, like the keys, so the text holds up
	// over album art. Scaled with the text size (about 2.5 at 16px).
	const stroke = (size * 0.16).toFixed(2);
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
		`<path d="${d}" fill="none" stroke="#000000" stroke-width="${stroke}" stroke-linejoin="round"/>` +
		`<path d="${d}" fill="${color}"/></svg>`;
	const png = await svgToPng(svg, 2);
	if (png) {
		if (cache.size >= CACHE_MAX) {
			cache.delete(cache.keys().next().value!);
		}
		cache.set(key, png);
	}
	return png;
}
