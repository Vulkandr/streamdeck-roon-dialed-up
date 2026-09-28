import { IconCells } from "./icon-cells";
import { CANVAS, renderIconSvgBody, svgDataUri, wrapSvg, type IconStyle } from "./icon-renderer";
import { measureText, type TextFont, textPath } from "./text-paths";

/**
 * Composes a key image as SVG: a base layer (an LED icon, or any image
 * such as cover art or a classic PNG) with optional text and progress
 * overlays drawn on top. Replaces the original plugin's canvas
 * compositing, which needed a browser; SVG needs nothing and Stream Deck
 * renders it natively.
 */

export interface TextLine {
	text: string;
	y: number;
	size: number;
	bold?: boolean;
	align?: "left" | "center";
	x?: number;
}

export interface KeyImageSpec {
	/** Bottom layer: raw SVG markup, or a data URI (PNG/JPEG/SVG). */
	base: { svgBody: string } | { dataUri: string } | null;
	lines?: TextLine[];
	/** 0..100; draws the original plugin's bar near the bottom. */
	progressPercent?: number;
	/** Typeface for `lines` (the key's Text Font setting). */
	font?: TextFont;
}

const FONT = "Arial, Helvetica, sans-serif";

function esc(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Fits text to a width using the real font metrics (the same font the text
 * is drawn with), trimming with an ellipsis exactly as the original's
 * canvas measureText loop did.
 */
export function fitText(text: string, maxWidth: number, size: number, bold = false, font: TextFont = "condensed"): string {
	// Half a pixel of tolerance: a title that measures exactly the limit
	// (as "Tyrant of Death" does at 18px) shouldn't lose its last letter to
	// floating point.
	const limit = maxWidth + 0.5;
	if (measureText(text, size, bold, font) <= limit) {
		return text;
	}
	let truncated = text;
	while (truncated.length > 1 && measureText(`${truncated.trimEnd()}…`, size, bold, font) > limit) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated.trimEnd()}…`;
}

function textElement(line: TextLine, font: TextFont): string {
	const x = line.x ?? (line.align === "left" ? 0 : CANVAS / 2);
	const anchor = line.align === "left" ? "start" : "middle";

	// Vector outlines (see text-paths.ts): stroke pass then fill pass, a
	// black outline like the canvas version drew, a touch heavier (4 vs 3)
	// so it reads over busy cover art at key size.
	const d = textPath(line.text, x, line.y, line.size, line.bold === true, anchor, font);
	if (d !== null) {
		return (
			`<path d="${d}" fill="none" stroke="#000000" stroke-width="4" stroke-linejoin="round"/>` +
			`<path d="${d}" fill="#ffffff"/>`
		);
	}

	// Fonts unavailable: fall back to renderer text.
	const weight = line.bold ? "bold" : "normal";
	const baseline = (line.y + line.size * 0.35).toFixed(1);
	const common = `x="${x}" y="${baseline}" font-family="${FONT}" font-size="${line.size}px" font-weight="${weight}" text-anchor="${anchor}"`;
	const text = esc(line.text);
	return (
		`<text ${common} fill="none" stroke="#000000" stroke-width="3" stroke-linejoin="round">${text}</text>` +
		`<text ${common} fill="#ffffff">${text}</text>`
	);
}

export function composeKeyImage(spec: KeyImageSpec): string {
	let body = "";

	if (spec.base) {
		if ("svgBody" in spec.base) {
			body += spec.base.svgBody;
		} else {
			body += `<image href="${spec.base.dataUri}" x="0" y="0" width="${CANVAS}" height="${CANVAS}" preserveAspectRatio="xMidYMid slice"/>`;
		}
	} else {
		body += `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" fill="#000000"/>`;
	}

	for (const line of spec.lines ?? []) {
		body += textElement(line, spec.font ?? "condensed");
	}

	if (spec.progressPercent !== undefined) {
		const barLeft = 10;
		const barWidth = CANVAS - 20;
		const barTop = CANVAS - 50;
		const barHeight = 5;
		const pct = Math.max(0, Math.min(100, spec.progressPercent));
		body += `<rect x="${barLeft}" y="${barTop}" width="${barWidth}" height="${barHeight}" fill="rgba(0,0,0,0.55)"/>`;
		body += `<rect x="${barLeft}" y="${barTop}" width="${(barWidth * pct) / 100}" height="${barHeight}" fill="#ffffff"/>`;
	}

	return svgDataUri(wrapSvg(body));
}

/**
 * The LED-style icon for `iconName` in the current global style, or
 * `undefined` for Classic (meaning: use the manifest's static image).
 */
export function styledIconBody(iconName: string | null, style: IconStyle, color: string, dimmed = false): string | undefined {
	if (style === "classic" || !iconName) {
		return undefined;
	}
	const cells = IconCells[iconName];
	if (!cells) {
		return undefined;
	}
	return renderIconSvgBody(cells, { color, style, iconName, disabledDim: dimmed ? 0.4 : undefined });
}

export function formatDuration(duration: number): string {
	const total = Math.max(0, Math.floor(duration));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total - hours * 3600) / 60);
	const seconds = total - hours * 3600 - minutes * 60;
	const mm = minutes < 10 ? `0${minutes}` : `${minutes}`;
	const ss = seconds < 10 ? `0${seconds}` : `${seconds}`;
	return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
