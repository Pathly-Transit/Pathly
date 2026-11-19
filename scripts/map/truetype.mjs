// Reads TrueType fonts (glyf outlines): which characters a font has, and each glyph's outline as
// closed contours of points (curves flattened), in font units with y up.

export function readFont(buffer) {
  const tables = new Map();
  const numTables = buffer.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + 16 * i;
    tables.set(buffer.toString('latin1', at, at + 4), { offset: buffer.readUInt32BE(at + 8), length: buffer.readUInt32BE(at + 12) });
  }
  const table = (tag) => {
    const t = tables.get(tag);
    if (!t) throw new Error(`Font has no ${tag} table`);
    return t.offset;
  };
  const head = table('head');
  const unitsPerEm = buffer.readUInt16BE(head + 18);
  const longLoca = buffer.readInt16BE(head + 50) === 1;
  const numGlyphs = buffer.readUInt16BE(table('maxp') + 4);
  const hhea = table('hhea');
  const numberOfHMetrics = buffer.readUInt16BE(hhea + 34);
  const hmtx = table('hmtx');
  const loca = table('loca');
  const glyf = table('glyf');

  const glyphOffset = (index) => (longLoca ? buffer.readUInt32BE(loca + 4 * index) : buffer.readUInt16BE(loca + 2 * index) * 2);
  const advanceOf = (index) => buffer.readUInt16BE(hmtx + 4 * Math.min(index, numberOfHMetrics - 1));

  /** Character code → glyph index, from the Unicode cmap (format 12 or 4). */
  const characters = new Map();
  const cmap = table('cmap');
  const subtables = [];
  for (let i = 0; i < buffer.readUInt16BE(cmap + 2); i += 1) {
    const at = cmap + 4 + 8 * i;
    subtables.push({ platform: buffer.readUInt16BE(at), encoding: buffer.readUInt16BE(at + 2), offset: cmap + buffer.readUInt32BE(at + 4) });
  }
  const pick = subtables.find((s) => s.platform === 3 && s.encoding === 10) ?? subtables.find((s) => s.platform === 0 && buffer.readUInt16BE(s.offset) === 12)
    ?? subtables.find((s) => s.platform === 3 && s.encoding === 1) ?? subtables.find((s) => s.platform === 0);
  if (!pick) throw new Error('Font has no Unicode character map');
  const format = buffer.readUInt16BE(pick.offset);
  if (format === 12) {
    const groups = buffer.readUInt32BE(pick.offset + 12);
    for (let g = 0; g < groups; g += 1) {
      const at = pick.offset + 16 + 12 * g;
      const start = buffer.readUInt32BE(at);
      const end = buffer.readUInt32BE(at + 4);
      const glyph = buffer.readUInt32BE(at + 8);
      for (let c = start; c <= end && c <= 0xffff; c += 1) characters.set(c, glyph + (c - start));
    }
  } else if (format === 4) {
    const segments = buffer.readUInt16BE(pick.offset + 6) / 2;
    const ends = pick.offset + 14;
    const starts = ends + 2 * segments + 2;
    const deltas = starts + 2 * segments;
    const ranges = deltas + 2 * segments;
    for (let s = 0; s < segments; s += 1) {
      const end = buffer.readUInt16BE(ends + 2 * s);
      const start = buffer.readUInt16BE(starts + 2 * s);
      const delta = buffer.readInt16BE(deltas + 2 * s);
      const rangeOffset = buffer.readUInt16BE(ranges + 2 * s);
      for (let c = start; c <= end && c !== 0xffff; c += 1) {
        let glyph;
        if (rangeOffset === 0) glyph = (c + delta) & 0xffff;
        else {
          const at = ranges + 2 * s + rangeOffset + 2 * (c - start);
          glyph = buffer.readUInt16BE(at);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph !== 0) characters.set(c, glyph);
      }
    }
  } else {
    throw new Error(`Unsupported cmap format ${format}`);
  }

  /** A glyph's contours as flat [x, y, ...] point lists (font units), curves split into short lines. */
  function contours(index, depth = 0) {
    if (index >= numGlyphs || depth > 8) return [];
    const start = glyf + glyphOffset(index);
    const end = glyf + glyphOffset(index + 1);
    if (end <= start) return [];
    const count = buffer.readInt16BE(start);
    if (count < 0) return compound(start + 10, depth);
    const endPoints = [];
    for (let i = 0; i < count; i += 1) endPoints.push(buffer.readUInt16BE(start + 10 + 2 * i));
    const pointCount = count ? endPoints[count - 1] + 1 : 0;
    let at = start + 10 + 2 * count;
    at += 2 + buffer.readUInt16BE(at); // instructions
    const flags = [];
    while (flags.length < pointCount) {
      const flag = buffer[at++];
      flags.push(flag);
      if (flag & 8) {
        const repeat = buffer[at++];
        for (let r = 0; r < repeat; r += 1) flags.push(flag);
      }
    }
    const xs = new Array(pointCount);
    const ys = new Array(pointCount);
    let value = 0;
    for (let i = 0; i < pointCount; i += 1) {
      const f = flags[i];
      if (f & 2) {
        value += f & 16 ? buffer[at] : -buffer[at];
        at += 1;
      } else if (!(f & 16)) {
        value += buffer.readInt16BE(at);
        at += 2;
      }
      xs[i] = value;
    }
    value = 0;
    for (let i = 0; i < pointCount; i += 1) {
      const f = flags[i];
      if (f & 4) {
        value += f & 32 ? buffer[at] : -buffer[at];
        at += 1;
      } else if (!(f & 32)) {
        value += buffer.readInt16BE(at);
        at += 2;
      }
      ys[i] = value;
    }
    const out = [];
    let first = 0;
    for (const last of endPoints) {
      out.push(flatten(xs.slice(first, last + 1), ys.slice(first, last + 1), flags.slice(first, last + 1).map((f) => (f & 1) === 1)));
      first = last + 1;
    }
    return out.filter((contour) => contour.length >= 6);
  }

  function compound(at, depth) {
    const out = [];
    for (;;) {
      const flags = buffer.readUInt16BE(at);
      const glyph = buffer.readUInt16BE(at + 2);
      at += 4;
      let dx;
      let dy;
      if (flags & 1) {
        dx = buffer.readInt16BE(at);
        dy = buffer.readInt16BE(at + 2);
        at += 4;
      } else {
        dx = buffer.readInt8(at);
        dy = buffer.readInt8(at + 1);
        at += 2;
      }
      let [a, b, c, d] = [1, 0, 0, 1];
      const f2dot14 = (o) => buffer.readInt16BE(o) / 16384;
      if (flags & 8) {
        a = d = f2dot14(at);
        at += 2;
      } else if (flags & 0x40) {
        a = f2dot14(at);
        d = f2dot14(at + 2);
        at += 4;
      } else if (flags & 0x80) {
        a = f2dot14(at);
        b = f2dot14(at + 2);
        c = f2dot14(at + 4);
        d = f2dot14(at + 6);
        at += 8;
      }
      // Components are placed by offset (point-matching placement isn't used by these fonts).
      if (!(flags & 2)) dx = dy = 0;
      for (const contour of contours(glyph, depth + 1)) {
        const placed = new Array(contour.length);
        for (let i = 0; i < contour.length; i += 2) {
          placed[i] = a * contour[i] + c * contour[i + 1] + dx;
          placed[i + 1] = b * contour[i] + d * contour[i + 1] + dy;
        }
        out.push(placed);
      }
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  return { unitsPerEm, characters, advanceOf, contours };
}

/** A TrueType contour (quadratic curves; off-curve points between on-curve ones) as straight segments. */
function flatten(xs, ys, onCurve) {
  const n = xs.length;
  // Expanded so on- and off-curve points alternate: implied on-curve midpoints added.
  const points = [];
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    points.push({ x: xs[i], y: ys[i], on: onCurve[i] });
    if (!onCurve[i] && !onCurve[j]) points.push({ x: (xs[i] + xs[j]) / 2, y: (ys[i] + ys[j]) / 2, on: true });
  }
  let startIndex = points.findIndex((p) => p.on);
  if (startIndex < 0) {
    points.unshift({ x: (xs[0] + xs[n - 1]) / 2, y: (ys[0] + ys[n - 1]) / 2, on: true });
    startIndex = 0;
  }
  const m = points.length;
  const out = [];
  const startPoint = points[startIndex];
  out.push(startPoint.x, startPoint.y);
  let previous = startPoint;
  for (let k = 1; k <= m; k += 1) {
    const p = points[(startIndex + k) % m];
    if (p.on) {
      out.push(p.x, p.y);
      previous = p;
    } else {
      const next = points[(startIndex + k + 1) % m];
      const steps = 8;
      for (let s = 1; s <= steps; s += 1) {
        const t = s / steps;
        const u = 1 - t;
        out.push(u * u * previous.x + 2 * u * t * p.x + t * t * next.x, u * u * previous.y + 2 * u * t * p.y + t * t * next.y);
      }
      previous = next;
      k += 1;
    }
  }
  return out;
}
