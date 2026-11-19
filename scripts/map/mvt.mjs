// Writes vector tiles in the Mapbox Vector Tile format (version 2), the protocol-buffer tile format
// MapLibre reads on the web, iOS, and Android. See https://github.com/mapbox/vector-tile-spec.

/** A growable protocol-buffer writer (just the wire types tiles use). */
export class Writer {
  constructor(size = 4096) {
    this.buffer = Buffer.allocUnsafe(size);
    this.length = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }

  varint(value) {
    this.ensure(10);
    let v = value;
    while (v >= 0x80) {
      this.buffer[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buffer[this.length++] = v;
  }

  tag(field, wireType) {
    this.varint(field * 8 + wireType);
  }

  bytes(field, bytes) {
    this.tag(field, 2);
    this.varint(bytes.length);
    this.ensure(bytes.length);
    if (Buffer.isBuffer(bytes)) bytes.copy(this.buffer, this.length);
    else this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  string(field, text) {
    this.bytes(field, Buffer.from(text, 'utf8'));
  }

  varintField(field, value) {
    this.tag(field, 0);
    this.varint(value);
  }

  doubleField(field, value) {
    this.tag(field, 1);
    this.ensure(8);
    this.buffer.writeDoubleLE(value, this.length);
    this.length += 8;
  }

  packed(field, values, count = values.length) {
    if (count === 0) return;
    const inner = new Writer(count * 2 + 8);
    for (let i = 0; i < count; i += 1) inner.varint(values[i]);
    this.bytes(field, inner.finish());
  }

  finish() {
    return this.buffer.subarray(0, this.length);
  }
}

export const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

function writeValue(value) {
  const w = new Writer(16);
  if (typeof value === 'string') w.string(1, value);
  else if (typeof value === 'boolean') w.varintField(7, value ? 1 : 0);
  else if (Number.isInteger(value) && value >= 0) w.varintField(5, value);
  else if (Number.isInteger(value)) w.varintField(6, zigzag(value));
  else w.doubleField(3, value);
  return w.finish();
}

export const GEOM_POINT = 1;
export const GEOM_LINE = 2;
export const GEOM_POLYGON = 3;

const command = (id, count) => (id & 0x7) | (count << 3);
const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

/**
 * Geometry commands for a feature from integer tile coordinates: points as one flat [x, y, ...]
 * list; lines and polygon rings as a list of flat lists (rings open, already wound for the spec:
 * outer rings positive area in tile coordinates, holes negative).
 */
export function geometryCommands(type, parts) {
  const out = [];
  let cx = 0;
  let cy = 0;
  if (type === GEOM_POINT) {
    const points = parts;
    out.push(command(MOVE_TO, points.length / 2));
    for (let i = 0; i < points.length; i += 2) {
      out.push(zigzag(points[i] - cx), zigzag(points[i + 1] - cy));
      cx = points[i];
      cy = points[i + 1];
    }
    return out;
  }
  for (const part of parts) {
    const n = part.length / 2;
    out.push(command(MOVE_TO, 1), zigzag(part[0] - cx), zigzag(part[1] - cy));
    cx = part[0];
    cy = part[1];
    out.push(command(LINE_TO, n - 1));
    for (let i = 1; i < n; i += 1) {
      out.push(zigzag(part[2 * i] - cx), zigzag(part[2 * i + 1] - cy));
      cx = part[2 * i];
      cy = part[2 * i + 1];
    }
    if (type === GEOM_POLYGON) out.push(command(CLOSE_PATH, 1));
  }
  return out;
}

/**
 * A tile's bytes. `layers` is [{ name, features: [{ type, geometry (commands), props }] }];
 * empty layers are left out (and a tile with none is zero bytes, which renderers read as empty).
 */
export function encodeTile(layers, extent = 4096) {
  const tile = new Writer();
  for (const layer of layers) {
    if (layer.features.length === 0) continue;
    const w = new Writer();
    w.varintField(15, 2);
    w.string(1, layer.name);
    const keys = new Map();
    const values = new Map();
    for (const feature of layer.features) {
      const tags = [];
      for (const key in feature.props) {
        const value = feature.props[key];
        if (value === undefined || value === null) continue;
        let k = keys.get(key);
        if (k === undefined) {
          k = keys.size;
          keys.set(key, k);
        }
        const valueKey = `${typeof value}:${value}`;
        let entry = values.get(valueKey);
        if (!entry) {
          entry = { index: values.size, value };
          values.set(valueKey, entry);
        }
        tags.push(k, entry.index);
      }
      const f = new Writer(feature.geometry.length * 2 + tags.length * 2 + 8);
      f.packed(2, tags);
      f.varintField(3, feature.type);
      f.packed(4, feature.geometry);
      w.bytes(2, f.finish());
    }
    for (const key of keys.keys()) w.string(3, key);
    for (const { value } of values.values()) w.bytes(4, writeValue(value));
    w.varintField(5, extent);
    tile.bytes(3, w.finish());
  }
  return tile.finish();
}
