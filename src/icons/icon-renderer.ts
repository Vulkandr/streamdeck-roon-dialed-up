import { PNG } from "pngjs";

import type { Cell } from "./icon-cells";

// Shared renderer for the LED / LED Grid icon styles, ported from the
// original plugin's IconRenderer.js. Same geometry, same colors.
//
// Two output paths:
//  - renderIconSvg(): SVG, for anything shown on a key via setImage()
//    (and for compositing with cover art/text overlays, see key-image.ts).
//  - renderIconPng(): real PNG bytes via pngjs (pure JS, no native deps),
//    for the touch strip's pixmap items, which need a bitmap.

const GRID = 17;
const DOT_FRAC = 0.62;
export const CANVAS = 144;

// Spacing that lets the outer ring of dots sit as close to the edge as
// possible while still rendering as full circles: the edge offset ends up
// equal to the dot's own radius.
const D = CANVAS / (GRID - 1 + DOT_FRAC);
const DOT_D = D * DOT_FRAC;
const RADIUS = DOT_D / 2;
const OFFSET = RADIUS;

// Icons that render dimmed by definition, regardless of enabled/disabled
// state. Currently just Volume-Disabled, per the 45% rule.
const FIXED_BRIGHTNESS: Record<string, number> = {
	"volume-disabled": 0.45,
};

export type IconStyle = "ledGrid" | "led" | "classic";

export interface RenderOptions {
	color: string;
	style: IconStyle;
	iconName?: string;
	/** Overrides on-brightness for the "dim when unavailable" state. */
	disabledDim?: number;
}

export interface PngRenderOptions extends RenderOptions {
	overlayCells?: Cell[];
	overlayColor?: string;
	overlayBrightness?: number;
}

function parseHex(hex: string): [number, number, number] {
	const h = hex.replace("#", "");
	return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
}

function scaleColor(hex: string, brightness: number): string {
	const [r, g, b] = parseHex(hex).map((v) => Math.round(v * brightness));
	const toHex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function onBrightnessFor(options: RenderOptions): number {
	let brightness = 1.0;
	if (options.iconName && FIXED_BRIGHTNESS[options.iconName] !== undefined) {
		brightness = FIXED_BRIGHTNESS[options.iconName];
	}
	if (typeof options.disabledDim === "number") {
		brightness = options.disabledDim;
	}
	return brightness;
}

export function svgDataUri(svg: string): string {
	return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/**
 * The icon's SVG markup *without* the outer <svg> wrapper: a black rounded
 * background plus the dots. Used both on its own and as the bottom layer
 * of a composed key image.
 */
export function renderIconSvgBody(cells: Cell[], options: RenderOptions): string {
	const onColor = scaleColor(options.color, onBrightnessFor(options));
	const offColor = scaleColor(options.color, 0.2);
	const onSet = new Set(cells.map(([r, c]) => `${r},${c}`));

	const bgRadius = CANVAS * 0.16;
	let out = `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${bgRadius}" ry="${bgRadius}" fill="#000000"/>`;

	const circle = (r: number, c: number, fill: string) =>
		`<circle cx="${(OFFSET + c * D).toFixed(2)}" cy="${(OFFSET + r * D).toFixed(2)}" r="${RADIUS.toFixed(2)}" fill="${fill}"/>`;

	if (options.style === "ledGrid") {
		for (let r = 0; r < GRID; r++) {
			for (let c = 0; c < GRID; c++) {
				out += circle(r, c, onSet.has(`${r},${c}`) ? onColor : offColor);
			}
		}
	} else {
		for (const [r, c] of cells) {
			out += circle(r, c, onColor);
		}
	}

	return out;
}

export function wrapSvg(body: string): string {
	return `<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${body}</svg>`;
}

/** Renders an icon as an SVG data URI. */
export function renderIconSvg(cells: Cell[], options: RenderOptions): string {
	return svgDataUri(wrapSvg(renderIconSvgBody(cells, options)));
}

/**
 * Same geometry and options as renderIconSvg(), but returns a base64 PNG
 * data URI built from real pixel data.
 */
export function renderIconPng(cells: Cell[], options: PngRenderOptions): string {
	const onBrightness = onBrightnessFor(options);
	const [baseR, baseG, baseB] = parseHex(options.color);
	const onRgb = [baseR * onBrightness, baseG * onBrightness, baseB * onBrightness];
	const offRgb = [baseR * 0.2, baseG * 0.2, baseB * 0.2];
	const onSet = new Set(cells.map(([r, c]) => `${r},${c}`));
	const bgRadiusPx = CANVAS * 0.16;

	const png = new PNG({ width: CANVAS, height: CANVAS });

	// Overlay dots go first: the per-pixel loop takes the first match, so
	// wherever the overlay sits on top of a base dot, the overlay wins.
	const dots: { cx: number; cy: number; rgb: number[] }[] = [];

	if (options.overlayCells?.length) {
		const [ovR, ovG, ovB] = parseHex(options.overlayColor ?? "#ff2d2d");
		const ovBrightness = options.overlayBrightness ?? 0.65;
		const ovRgb = [ovR * ovBrightness, ovG * ovBrightness, ovB * ovBrightness];
		for (const [r, c] of options.overlayCells) {
			dots.push({ cx: OFFSET + c * D, cy: OFFSET + r * D, rgb: ovRgb });
		}
	}

	if (options.style === "ledGrid") {
		for (let r = 0; r < GRID; r++) {
			for (let c = 0; c < GRID; c++) {
				dots.push({ cx: OFFSET + c * D, cy: OFFSET + r * D, rgb: onSet.has(`${r},${c}`) ? onRgb : offRgb });
			}
		}
	} else {
		for (const [r, c] of cells) {
			dots.push({ cx: OFFSET + c * D, cy: OFFSET + r * D, rgb: onRgb });
		}
	}

	const isInRoundedRect = (px: number, py: number) => {
		if (px >= bgRadiusPx && px <= CANVAS - bgRadiusPx) return true;
		if (py >= bgRadiusPx && py <= CANVAS - bgRadiusPx) return true;
		const rx = Math.min(Math.max(px, bgRadiusPx), CANVAS - bgRadiusPx);
		const ry = Math.min(Math.max(py, bgRadiusPx), CANVAS - bgRadiusPx);
		const dx = px - rx;
		const dy = py - ry;
		return dx * dx + dy * dy <= bgRadiusPx * bgRadiusPx;
	};

	const r2 = RADIUS * RADIUS;
	for (let y = 0; y < CANVAS; y++) {
		for (let x = 0; x < CANVAS; x++) {
			const idx = (CANVAS * y + x) << 2;

			if (!isInRoundedRect(x + 0.5, y + 0.5)) {
				png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = png.data[idx + 3] = 0;
				continue;
			}

			let r = 0, g = 0, b = 0;
			for (const dot of dots) {
				const dx = x + 0.5 - dot.cx;
				const dy = y + 0.5 - dot.cy;
				if (dx * dx + dy * dy <= r2) {
					[r, g, b] = dot.rgb;
					break;
				}
			}

			png.data[idx] = Math.round(r);
			png.data[idx + 1] = Math.round(g);
			png.data[idx + 2] = Math.round(b);
			png.data[idx + 3] = 255;
		}
	}

	return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}
