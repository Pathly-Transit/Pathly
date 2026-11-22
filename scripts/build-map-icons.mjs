// Draws the base map's transit icons as PNGs from the app's own mode icons (Material Community
// Icons' bus, train, subway-variant, and ferry, as Icon.tsx shows them), in gray with a halo so
// they read on the map, for both apps and both themes:
//   mobile/assets/map-icons/<name>.png with @2x and @3x copies (the phone picks its scale), and
//   mobile/assets/map-icons/web/<name>.png at 3x (the web map is told its pixel ratio).
// <name> is transit-<mode> on the light map and transit-<mode>-dark on the dark one.
//
//   node scripts/build-map-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { ROOT } from './map/bounds.mjs';
import { readFont } from './map/truetype.mjs';

const OUT = join(ROOT, 'mobile/assets/map-icons');
const require = createRequire(import.meta.url);
const iconsDir = join(require.resolve('@expo/vector-icons/package.json', { paths: [join(ROOT, 'mobile'), ROOT] }), '..', 'build/vendor/react-native-vector-icons');
const font = readFont(readFileSync(join(iconsDir, 'Fonts/MaterialCommunityIcons.ttf')));
const glyphMap = JSON.parse(readFileSync(join(iconsDir, 'glyphmaps/MaterialCommunityIcons.json'), 'utf8'));

/** Each icon: its glyph (Icon.tsx's), and its size in points. Bus stops are smaller than stations. */
const ICONS = {
  'transit-subway': { glyph: 'subway-variant', points: 16 },
  'transit-rail': { glyph: 'train', points: 16 },
  'transit-ferry': { glyph: 'ferry', points: 16 },
  'transit-bus': { glyph: 'bus', points: 11 },
  // One-way arrows along bus ramps and lanes: a light arrow, no halo.
  'oneway-arrow': { glyph: 'arrow-right-thin', points: 12, arrow: true },
};

/** Gray glyphs with a halo in the map's land color, per theme (mapStyle.ts's road label grays). */
const THEMES = {
  '': { ink: [0x5f, 0x63, 0x68], halo: [0xff, 0xff, 0xff], arrow: [0x9a, 0xa0, 0xa6] },
  '-dark': { ink: [0xa8, 0xad, 0xb4], halo: [0x16, 0x17, 0x1a], arrow: [0x6b, 0x70, 0x78] },
};

/** The halo's width, as a share of the icon's size. */
const HALO = 0.09;
/** Subsamples per pixel, each way, for smooth edges. */
const SAMPLES = 4;

/** The glyph's contours as edges, in a unit square (y down), centered. */
function glyphEdges(name) {
  const code = glyphMap[name];
  const index = font.characters.get(code);
  if (index === undefined) throw new Error(`No glyph for ${name}`);
  const contours = font.contours(index);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (let i = 0; i < c.length; i += 2) {
    minX = Math.min(minX, c[i]); maxX = Math.max(maxX, c[i]);
    minY = Math.min(minY, c[i + 1]); maxY = Math.max(maxY, c[i + 1]);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  const ox = (span - (maxX - minX)) / 2;
  const oy = (span - (maxY - minY)) / 2;
  const edges = [];
  for (const c of contours) {
    const n = c.length / 2;
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n;
      edges.push([
        (c[2 * i] - minX + ox) / span, 1 - (c[2 * i + 1] - minY + oy) / span,
        (c[2 * j] - minX + ox) / span, 1 - (c[2 * j + 1] - minY + oy) / span,
      ]);
    }
  }
  return edges;
}

/** Inside by the nonzero rule (TrueType's). */
function inside(edges, x, y) {
  let winding = 0;
  for (const [ax, ay, bx, by] of edges) {
    if (ay <= y) {
      if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding += 1;
    } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) winding -= 1;
  }
  return winding !== 0;
}

function distanceToEdges(edges, x, y) {
  let best = Infinity;
  for (const [ax, ay, bx, by] of edges) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, ay + dy * t - y));
  }
  return best;
}

function draw(edges, points, scale, { ink, halo }, haloed = true) {
  const size = Math.round(points * scale);
  const png = new PNG({ width: size, height: size });
  // The glyph sits inside the halo's margin.
  const margin = haloed ? HALO : 0.02;
  const toGlyph = (v) => (v - margin) / (1 - 2 * margin);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = toGlyph((px + (sx + 0.5) / SAMPLES) / size);
          const y = toGlyph((py + (sy + 0.5) / SAMPLES) / size);
          let rgb = null;
          if (inside(edges, x, y)) rgb = ink;
          else if (haloed && distanceToEdges(edges, x, y) <= margin / (1 - 2 * margin)) rgb = halo;
          if (!rgb) continue;
          r += rgb[0]; g += rgb[1]; b += rgb[2]; a += 1;
        }
      }
      const at = (py * size + px) * 4;
      png.data[at] = a ? Math.round(r / a) : 0;
      png.data[at + 1] = a ? Math.round(g / a) : 0;
      png.data[at + 2] = a ? Math.round(b / a) : 0;
      png.data[at + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return PNG.sync.write(png);
}

mkdirSync(join(OUT, 'web'), { recursive: true });
let count = 0;
for (const [name, { glyph, points, arrow = false }] of Object.entries(ICONS)) {
  const edges = glyphEdges(glyph);
  for (const [suffix, theme] of Object.entries(THEMES)) {
    const file = `${name}${suffix}`;
    const colors = arrow ? { ink: theme.arrow, halo: theme.halo } : theme;
    for (const [out, scale] of [[`${file}.png`, 1], [`${file}@2x.png`, 2], [`${file}@3x.png`, 3], [join('web', `${file}.png`), 3]]) {
      writeFileSync(join(OUT, out), draw(edges, points, scale, colors, !arrow));
    }
    count += 1;
  }
}
console.log(`Wrote ${count} icons to ${OUT}`);
