import streamDeck from "@elgato/streamdeck";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import opentype, { type Font, type PathCommand } from "opentype.js";

const log = streamDeck.logger.createScope("text-paths");

/**
 * Text as vector outlines.
 *
 * Stream Deck rasterizes SVG <text> at the key's native resolution with
 * font hinting, which rounds every glyph out to whole pixels: the result is
 * both wider and blurrier than the browser canvas the original plugin drew
 * on, and the width can't be predicted, so titles truncate in the wrong
 * place. Converting the text to <path> outlines here sidesteps all of that:
 * paths scale exactly like the icon dots, and the advance widths are known
 * precisely, so text fits the way it did on the canvas.
 *
 * Two typefaces ship in the plugin's fonts/ folder (both SIL Open Font
 * License), picked per key or dial by its "Text Font" setting:
 *
 * - "classic": Liberation Sans, metrically identical to Arial, which is
 *   what the original plugin drew with. Text lays out exactly as it did.
 * - "condensed" (default): Fira Sans Condensed. Chosen for the keys' tiny
 *   physical size: its condensed width fits two or three more characters
 *   per line at the same point size, and its tall x-height stays legible
 *   at 72px.
 *
 * The shipped files are subset to Latin and have their OpenType
 * substitution tables stripped (opentype.js can't parse some of them, and
 * outlines don't need them); kerning is kept.
 */

const PLUGIN_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/**
 * Which typeface draws a key's or dial's text: "classic" is the Arial-style
 * face the original plugin used, "condensed" the narrower one that fits
 * more per line (the default).
 */
export type TextFont = "classic" | "condensed";

/** The font named by an action's settings, with the default applied. */
export function textFontOf(settings: { textFont?: unknown } | undefined): TextFont {
	return settings?.textFont === "classic" ? "classic" : "condensed";
}

const FILES: Record<TextFont, { regular: string; bold: string }> = {
	classic: { regular: "LiberationSans-Regular.ttf", bold: "LiberationSans-Bold.ttf" },
	condensed: { regular: "FiraSansCondensed-Regular.ttf", bold: "FiraSansCondensed-Bold.ttf" },
};

const loaded = new Map<string, Font | null>();

function load(file: string): Font | null {
	try {
		const buffer = fs.readFileSync(path.join(PLUGIN_ROOT, "fonts", file));
		return opentype.parse(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
	} catch (err) {
		log.error(`couldn't load font ${file}: ${err}`);
		return null;
	}
}

function fontFor(isBold: boolean, family: TextFont): Font | null {
	const file = FILES[family][isBold ? "bold" : "regular"];
	let font = loaded.get(file);
	if (font === undefined) {
		font = load(file);
		loaded.set(file, font);
	}
	return font;
}

/** Whether outline rendering is available (fonts loaded). */
export function hasFonts(family: TextFont = "condensed"): boolean {
	return fontFor(true, family) !== null && fontFor(false, family) !== null;
}

export function measureText(text: string, size: number, isBold: boolean, family: TextFont = "condensed"): number {
	const font = fontFor(isBold, family);
	return font ? font.getAdvanceWidth(text, size, { kerning: true }) : text.length * size * 0.55;
}

/**
 * SVG path data for `text`, with (x, y) at the horizontal anchor and the
 * vertical middle of the em box (what canvas textBaseline "middle" meant).
 */
export function textPath(text: string, x: number, yMiddle: number, size: number, isBold: boolean, anchor: "start" | "middle" | "end", family: TextFont = "condensed"): string | null {
	const font = fontFor(isBold, family);
	if (!font) {
		return null;
	}
	const width = font.getAdvanceWidth(text, size, { kerning: true });
	const startX = anchor === "middle" ? x - width / 2 : anchor === "end" ? x - width : x;
	// Baseline sits below the em-box middle by half of (ascender + descender).
	const baseline = yMiddle + ((font.ascender + font.descender) / 2 / font.unitsPerEm) * size;
	return toPathData(font.getPath(text, startX, baseline, size, { kerning: true }).commands);
}

/**
 * Path data from opentype.js glyph commands, written by hand rather than
 * with its toPathData(): that emits zero-length line segments (a lineTo the
 * current point, over a hundred per title) and never closes contours.
 * resvg's rasterizer stops drawing the rest of the path when it meets one
 * of those degenerate segments, so the text got cut off part way through;
 * and an unclosed contour leaves a gap in the stroke outline.
 */
function toPathData(commands: PathCommand[]): string {
	const n = (v: number) => (Math.round(v * 100) / 100).toString();
	let d = "";
	let open = false;
	let cx = NaN;
	let cy = NaN;

	for (const c of commands) {
		switch (c.type) {
			case "M":
				if (open) d += "Z";
				d += `M${n(c.x)} ${n(c.y)}`;
				open = true;
				break;
			case "L":
				if (Math.abs(c.x - cx) < 1e-6 && Math.abs(c.y - cy) < 1e-6) continue;
				d += `L${n(c.x)} ${n(c.y)}`;
				break;
			case "Q":
				d += `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
				break;
			case "C":
				d += `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
				break;
			case "Z":
				if (open) d += "Z";
				open = false;
				continue;
		}
		cx = c.x;
		cy = c.y;
	}
	if (open) d += "Z";
	return d;
}
