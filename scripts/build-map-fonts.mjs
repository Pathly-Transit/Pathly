#!/usr/bin/env node
// Builds the base map's label fonts from Nunito, the app's own typeface (SIL Open Font License):
// every character as a signed-distance glyph (how far each pixel is from the letter's edge, which
// lets the map draw crisp text at any size), packed 256 characters to a file in the glyph format
// MapLibre reads on the web, iOS, and Android. Writes maptiles/fonts/{stack}/{start}-{end}.pbf.
//
//   node scripts/build-map-fonts.mjs
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { ROOT } from './map/bounds.mjs';
import { Writer, zigzag } from './map/mvt.mjs';
import { readFont } from './map/truetype.mjs';

/** The font stacks the style names (mapStyle.ts), each from one Nunito weight. */
export const FONT_STACKS = {
  'Nunito-Regular': '400Regular/Nunito_400Regular.ttf',
  'Nunito-SemiBold': '600SemiBold/Nunito_600SemiBold.ttf',
  'Nunito-Bold': '700Bold/Nunito_700Bold.ttf',
  'Nunito-Italic': '400Regular_Italic/Nunito_400Regular_Italic.ttf',
};

// The glyph format's conventions (as the map renderers expect them): glyphs drawn at 24 px with 3
// px of padding, distances spread over 8 px, the letter's edge at 3/4 of the value range.
const SIZE = 24;
const BUFFER = 3;
const RADIUS = 8;
const CUTOFF = 0.25;
/** Baseline to the glyph format's origin, in pixels (calibrated to the renderers' own fonts). */
const TOP_ADJUST = 27;

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = lengthSquared ? ((px - ax) * dx + (py - ay) * dy) / lengthSquared : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + dx * t - px;
  const y = ay + dy * t - py;
  return x * x + y * y;
}

/** A glyph's signed-distance bitmap and metrics, from its contours in font units. */
function renderGlyph(contours, advance, scale) {
  const metrics = { width: 0, height: 0, left: 0, top: 0, advance: Math.round(advance * scale), bitmap: null };
  if (contours.length === 0) return metrics;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const scaled = contours.map((contour) => {
    const out = new Float64Array(contour.length);
    for (let i = 0; i < contour.length; i += 2) {
      out[i] = contour[i] * scale;
      out[i + 1] = contour[i + 1] * scale;
      if (out[i] < minX) minX = out[i];
      if (out[i] > maxX) maxX = out[i];
      if (out[i + 1] < minY) minY = out[i + 1];
      if (out[i + 1] > maxY) maxY = out[i + 1];
    }
    return out;
  });
  const left = Math.floor(minX);
  const top = Math.ceil(maxY);
  const width = Math.ceil(maxX) - left;
  const height = top - Math.floor(minY);
  if (width <= 0 || height <= 0) return metrics;
  const w = width + 2 * BUFFER;
  const h = height + 2 * BUFFER;
  const bitmap = Buffer.alloc(w * h);
  for (let row = 0; row < h; row += 1) {
    const y = top + BUFFER - row - 0.5;
    for (let col = 0; col < w; col += 1) {
      const x = left - BUFFER + col + 0.5;
      let nearest = Infinity;
      let winding = 0;
      for (const contour of scaled) {
        const n = contour.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const ax = contour[2 * j];
          const ay = contour[2 * j + 1];
          const bx = contour[2 * i];
          const by = contour[2 * i + 1];
          const d = distanceToSegment(x, y, ax, ay, bx, by);
          if (d < nearest) nearest = d;
          // Nonzero winding (TrueType's fill rule).
          if (ay <= y) {
            if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding += 1;
          } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) winding -= 1;
        }
      }
      const distance = Math.sqrt(nearest) * (winding !== 0 ? -1 : 1);
      bitmap[row * w + col] = Math.max(0, Math.min(255, Math.round(255 - 255 * (distance / RADIUS + CUTOFF))));
    }
  }
  return { width, height, left, top: top - TOP_ADJUST, advance: metrics.advance, bitmap };
}

function encodeRange(stack, start, glyphs) {
  const fontstack = new Writer();
  fontstack.string(1, stack);
  fontstack.string(2, `${start}-${start + 255}`);
  for (const [id, glyph] of glyphs) {
    const g = new Writer(64 + (glyph.bitmap?.length ?? 0));
    g.varintField(1, id);
    if (glyph.bitmap) g.bytes(2, glyph.bitmap);
    g.varintField(3, glyph.width);
    g.varintField(4, glyph.height);
    g.varintField(5, zigzag(glyph.left));
    g.varintField(6, zigzag(glyph.top));
    g.varintField(7, glyph.advance);
    fontstack.bytes(3, g.finish());
  }
  const out = new Writer();
  out.bytes(1, fontstack.finish());
  return out.finish();
}

const require = createRequire(import.meta.url);
const fontsDir = dirname(require.resolve('@expo-google-fonts/nunito/package.json', { paths: [join(ROOT, 'mobile'), ROOT] }));
const outDir = join(ROOT, 'maptiles', 'fonts');
rmSync(outDir, { recursive: true, force: true });
for (const [stack, file] of Object.entries(FONT_STACKS)) {
  const font = readFont(readFileSync(join(fontsDir, file)));
  const scale = SIZE / font.unitsPerEm;
  const dir = join(outDir, stack);
  mkdirSync(dir, { recursive: true });
  let count = 0;
  // Every range gets a file (empty where Nunito has no characters), so no request goes unanswered.
  for (let start = 0; start < 65536; start += 256) {
    const glyphs = [];
    for (let code = start; code < start + 256; code += 1) {
      const glyph = font.characters.get(code);
      if (glyph === undefined) continue;
      glyphs.push([code, renderGlyph(font.contours(glyph), font.advanceOf(glyph), scale)]);
    }
    count += glyphs.length;
    writeFileSync(join(dir, `${start}-${start + 255}.pbf`), encodeRange(stack, start, glyphs));
  }
  console.log(`${stack}: ${count} characters`);
}
console.log(`Fonts ready in ${outDir}.`);
