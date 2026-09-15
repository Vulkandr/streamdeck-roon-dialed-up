import { PNG } from "pngjs";

// Shared renderer for the LED / LED Grid icon styles.
//
// Two output paths:
//  - renderIconSvg(): SVG data URI via setImage() directly. Proven reliable
//    in this codebase (see DataImages/mute-off-encoder.js, stop-key-disabled.js).
//  - renderIconPng(): real PNG bytes via pngjs (pure JS, no native deps,
//    consistent with this project's established aversion to native
//    dependencies after the lightningcss platform-mismatch lesson). Used
//    anywhere the result needs to be a genuine bitmap rather than a string
//    handed straight to setImage() -- touchscreen feedback (payload.icon,
//    confirmed PNG-only), and anywhere the icon is loaded into an Image()
//    object for canvas compositing (album art, seek-time/volume overlays).
//    SVG through Image()+canvas has no working precedent anywhere in this
//    codebase, so it isn't used for those cases.

const GRID = 17;
const DOT_FRAC = 0.62;
const CANVAS = 144;

// Solve for the spacing that lets the outer ring of dots sit as close to
// the edge as possible while still rendering as full circles (not sliced
// by the raw canvas bounds). The offset from the edge ends up equal to the
// dot's own radius -- any less and the edge dots get clipped in half; any
// more just wastes space. Shared by both LED Grid and plain LED, so the
// two styles render at identical dot size and spacing and differ only in
// whether the off-dots get drawn. Corner dots can still get clipped by the
// rounded background corner (bgRadiusPx below), which is expected and fine.
const D = CANVAS / (GRID - 1 + DOT_FRAC);
const DOT_D = D * DOT_FRAC;
const RADIUS = DOT_D / 2;
const OFFSET = RADIUS;

// Icons that render at a dimmed brightness by definition, rather than
// full brightness, regardless of the enabled/disabled state machinery.
// Currently just Volume-Disabled, per the 45% rule.
const FIXED_BRIGHTNESS = {
  "volume-disabled": 0.45,
};

function scaleColor(hex, brightness) {
  const h = hex.replace("#", "");
  const r = Math.round(parseInt(h.substring(0, 2), 16) * brightness);
  const g = Math.round(parseInt(h.substring(2, 4), 16) * brightness);
  const b = Math.round(parseInt(h.substring(4, 6), 16) * brightness);
  const toHex = (v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Render an icon as an SVG data URI.
 *
 * @param {Array<[number,number]>} cells - "on" grid cells, [row, col] pairs
 * @param {Object} options
 * @param {string} options.color - hex color, e.g. "#ffffff"
 * @param {"ledGrid"|"led"} options.style - whether to show the full dim grid
 * @param {string} [options.iconName] - used to look up FIXED_BRIGHTNESS overrides
 * @param {number} [options.disabledDim] - if set, overrides on-brightness for
 *   the action's own "disabled when unavailable" state (dimmed, not a
 *   different icon, matching the existing per-action disabled convention)
 * @returns {string} data:image/svg+xml;charset=utf8,... URI
 */
export function renderIconSvg(cells, options) {
  const { color, style, iconName, disabledDim } = options;

  const o = OFFSET;
  const radius = RADIUS;

  let onBrightness = 1.0;
  if (iconName && FIXED_BRIGHTNESS[iconName] !== undefined) {
    onBrightness = FIXED_BRIGHTNESS[iconName];
  }
  if (typeof disabledDim === "number") {
    onBrightness = disabledDim;
  }

  const onColor = scaleColor(color, onBrightness);
  const offColor = scaleColor(color, 0.20);

  const onSet = new Set(cells.map(([r, c]) => `${r},${c}`));

  let circles = "";
  const bgRadius = CANVAS * 0.16;
  const bg = `<rect x="0" y="0" width="${CANVAS}" height="${CANVAS}" rx="${bgRadius}" ry="${bgRadius}" fill="#000000"/>`;

  if (style === "ledGrid") {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cx = o + c * D;
        const cy = o + r * D;
        const fill = onSet.has(`${r},${c}`) ? onColor : offColor;
        circles += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="${fill}"/>`;
      }
    }
  } else {
    // plain LED: only the "on" dots, black background baked in for
    // consistency between the physical key and the software's grey panels
    for (const [r, c] of cells) {
      const cx = o + c * D;
      const cy = o + r * D;
      circles += `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${radius.toFixed(2)}" fill="${onColor}"/>`;
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">${bg}${circles}</svg>\n`;

  return `data:image/svg+xml;charset=utf8,${svg}`;
}

/**
 * Same geometry and options as renderIconSvg(), but returns a base64 PNG
 * data URI built from real pixel data via pngjs, rather than an SVG string.
 * See the file header for why this exists as a separate path.
 */
export function renderIconPng(cells, options) {
  const { color, style, iconName, disabledDim, overlayCells, overlayColor, overlayBrightness } = options;

  const o = OFFSET;
  const radius = RADIUS;

  let onBrightness = 1.0;
  if (iconName && FIXED_BRIGHTNESS[iconName] !== undefined) {
    onBrightness = FIXED_BRIGHTNESS[iconName];
  }
  if (typeof disabledDim === "number") {
    onBrightness = disabledDim;
  }

  const parseHex = (hex) => {
    const h = hex.replace("#", "");
    return [
      parseInt(h.substring(0, 2), 16),
      parseInt(h.substring(2, 4), 16),
      parseInt(h.substring(4, 6), 16),
    ];
  };
  const [baseR, baseG, baseB] = parseHex(color);
  const onRgb = [baseR * onBrightness, baseG * onBrightness, baseB * onBrightness];
  const offRgb = [baseR * 0.20, baseG * 0.20, baseB * 0.20];

  const onSet = new Set(cells.map(([r, c]) => `${r},${c}`));
  const bgRadiusPx = CANVAS * 0.16;

  const png = new PNG({ width: CANVAS, height: CANVAS });

  // Precompute dot centers for whichever dots need drawing. Overlay dots
  // (currently just Volume-Disabled's red X) go first, since the per-pixel
  // loop below takes the first match -- so wherever the overlay sits on
  // top of a base dot, the overlay's color wins, as if it were drawn after.
  const dotsToRender = [];

  if (overlayCells && overlayCells.length) {
    const [ovR, ovG, ovB] = parseHex(overlayColor || "#ff2d2d");
    const ovBrightness = typeof overlayBrightness === "number" ? overlayBrightness : 0.65;
    const ovRgb = [ovR * ovBrightness, ovG * ovBrightness, ovB * ovBrightness];
    for (const [r, c] of overlayCells) {
      dotsToRender.push({ cx: o + c * D, cy: o + r * D, rgb: ovRgb });
    }
  }

  if (style === "ledGrid") {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cx = o + c * D;
        const cy = o + r * D;
        const rgb = onSet.has(`${r},${c}`) ? onRgb : offRgb;
        dotsToRender.push({ cx, cy, rgb });
      }
    }
  } else {
    for (const [r, c] of cells) {
      const cx = o + c * D;
      const cy = o + r * D;
      dotsToRender.push({ cx, cy, rgb: onRgb });
    }
  }

  const isInRoundedRect = (px, py) => {
    // rounded-square background test, matching the SVG rx/ry used elsewhere
    const rx = Math.min(Math.max(px, bgRadiusPx), CANVAS - bgRadiusPx);
    const ry = Math.min(Math.max(py, bgRadiusPx), CANVAS - bgRadiusPx);
    if (px >= bgRadiusPx && px <= CANVAS - bgRadiusPx) return true;
    if (py >= bgRadiusPx && py <= CANVAS - bgRadiusPx) return true;
    const dx = px - rx;
    const dy = py - ry;
    return (dx * dx + dy * dy) <= (bgRadiusPx * bgRadiusPx);
  };

  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const idx = (CANVAS * y + x) << 2;

      if (!isInRoundedRect(x + 0.5, y + 0.5)) {
        png.data[idx] = 0;
        png.data[idx + 1] = 0;
        png.data[idx + 2] = 0;
        png.data[idx + 3] = 0;
        continue;
      }

      // background: solid black
      let r = 0, g = 0, b = 0;

      for (const dot of dotsToRender) {
        const dx = x + 0.5 - dot.cx;
        const dy = y + 0.5 - dot.cy;
        if (dx * dx + dy * dy <= radius * radius) {
          r = dot.rgb[0];
          g = dot.rgb[1];
          b = dot.rgb[2];
          break;
        }
      }

      png.data[idx] = Math.round(r);
      png.data[idx + 1] = Math.round(g);
      png.data[idx + 2] = Math.round(b);
      png.data[idx + 3] = 255;
    }
  }

  const buffer = PNG.sync.write(png);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
