// Every feature the map shows, held in a few big typed arrays (millions of buildings and streets
// as JavaScript objects wouldn't fit in memory). Coordinates are degrees × 1e7 as integers.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LAYERS } from './schema.mjs';

export const SCALE = 1e7;
export const POINT = 1;
export const LINE = 2;
export const POLYGON = 3;

/** A typed array that grows as values are pushed. */
export class Grow {
  constructor(Type, capacity = 1024) {
    this.Type = Type;
    this.array = new Type(capacity);
    this.length = 0;
  }

  reserve(extra) {
    const needed = this.length + extra;
    if (needed <= this.array.length) return;
    let capacity = this.array.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new this.Type(capacity);
    next.set(this.array.subarray(0, this.length));
    this.array = next;
  }

  push(value) {
    if (this.length === this.array.length) this.reserve(1);
    this.array[this.length++] = value;
  }

  view() {
    return this.array.subarray(0, this.length);
  }
}

const LAYER_INDEX = Object.fromEntries(LAYERS.map((name, index) => [name, index]));

export class FeatureStore {
  constructor() {
    this.layer = new Grow(Uint8Array);
    this.type = new Grow(Uint8Array);
    this.minzoom = new Grow(Uint8Array);
    this.deleted = new Grow(Uint8Array);
    this.firstPart = new Grow(Uint32Array);
    this.partCount = new Grow(Uint32Array);
    // west, south, east, north per feature
    this.bounds = new Grow(Int32Array);
    this.propsIndex = new Grow(Uint32Array);
    // Per part: where its points start, and whether it starts a polygon (an outer ring).
    this.partStart = new Grow(Uint32Array);
    this.partOuter = new Grow(Uint8Array);
    this.coords = new Grow(Int32Array, 1 << 20);
    // Identical property sets are stored once (most buildings, for instance, share one).
    this.props = [];
    this.propsKeys = new Map();
  }

  get count() {
    return this.layer.length;
  }

  internProps(props) {
    const key = JSON.stringify(props);
    let index = this.propsKeys.get(key);
    if (index === undefined) {
      index = this.props.length;
      this.props.push(Object.freeze(props));
      this.propsKeys.set(key, index);
    }
    return index;
  }

  /**
   * Adds a feature. `parts` are flat degree arrays: one per point or line, or for polygons, each
   * polygon's outer ring followed by its holes (`outer[i]` true where a polygon starts).
   */
  add(layerName, type, minzoom, props, parts, outer) {
    const layer = LAYER_INDEX[layerName];
    if (layer === undefined) throw new Error(`Unknown layer ${layerName}`);
    const index = this.count;
    this.layer.push(layer);
    this.type.push(type);
    this.minzoom.push(minzoom);
    this.deleted.push(0);
    this.firstPart.push(this.partStart.length);
    this.partCount.push(parts.length);
    this.propsIndex.push(this.internProps(props));
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (let p = 0; p < parts.length; p += 1) {
      const part = parts[p];
      this.partStart.push(this.coords.length / 2);
      this.partOuter.push(outer ? (outer[p] ? 1 : 0) : 1);
      this.coords.reserve(part.length);
      for (let i = 0; i < part.length; i += 2) {
        const x = Math.round(part[i] * SCALE);
        const y = Math.round(part[i + 1] * SCALE);
        this.coords.array[this.coords.length++] = x;
        this.coords.array[this.coords.length++] = y;
        if (x < west) west = x;
        if (x > east) east = x;
        if (y < south) south = y;
        if (y > north) north = y;
      }
    }
    this.bounds.push(west);
    this.bounds.push(south);
    this.bounds.push(east);
    this.bounds.push(north);
    return index;
  }

  delete(index) {
    this.deleted.array[index] = 1;
  }

  layerName(index) {
    return LAYERS[this.layer.array[index]];
  }

  propsOf(index) {
    return this.props[this.propsIndex.array[index]];
  }

  /** A feature's bounds in degrees. */
  boundsOf(index) {
    const b = this.bounds.array;
    return { west: b[4 * index] / SCALE, south: b[4 * index + 1] / SCALE, east: b[4 * index + 2] / SCALE, north: b[4 * index + 3] / SCALE };
  }

  pointCount(index) {
    const first = this.firstPart.array[index];
    const end = first + this.partCount.array[index];
    const stop = end < this.partStart.length ? this.partStart.array[end] : this.coords.length / 2;
    return stop - this.partStart.array[first];
  }

  /** A feature's parts as flat degree arrays, with whether each starts a polygon. */
  partsOf(index) {
    const first = this.firstPart.array[index];
    const count = this.partCount.array[index];
    const coords = this.coords.array;
    const parts = [];
    const outer = [];
    for (let p = first; p < first + count; p += 1) {
      const start = this.partStart.array[p];
      const stop = p + 1 < this.partStart.length ? this.partStart.array[p + 1] : this.coords.length / 2;
      const part = new Array((stop - start) * 2);
      for (let i = start, j = 0; i < stop; i += 1, j += 2) {
        part[j] = coords[2 * i] / SCALE;
        part[j + 1] = coords[2 * i + 1] / SCALE;
      }
      parts.push(part);
      outer.push(this.partOuter.array[p] === 1);
    }
    return { parts, outer };
  }

  /** A feature's polygons, each [outer, ...holes]. */
  polygonsOf(index) {
    const { parts, outer } = this.partsOf(index);
    const polygons = [];
    for (let i = 0; i < parts.length; i += 1) {
      if (outer[i] || polygons.length === 0) polygons.push([parts[i]]);
      else polygons[polygons.length - 1].push(parts[i]);
    }
    return polygons;
  }

  save(dir) {
    mkdirSync(dir, { recursive: true });
    const arrays = ['layer', 'type', 'minzoom', 'deleted', 'firstPart', 'partCount', 'bounds', 'propsIndex', 'partStart', 'partOuter', 'coords'];
    for (const name of arrays) writeFileSync(join(dir, `${name}.bin`), this[name].view());
    writeFileSync(join(dir, 'props.json'), JSON.stringify(this.props));
  }

  static load(dir) {
    const store = new FeatureStore();
    const arrays = { layer: Uint8Array, type: Uint8Array, minzoom: Uint8Array, deleted: Uint8Array, firstPart: Uint32Array, partCount: Uint32Array, bounds: Int32Array, propsIndex: Uint32Array, partStart: Uint32Array, partOuter: Uint8Array, coords: Int32Array };
    for (const [name, Type] of Object.entries(arrays)) {
      const buffer = readFileSync(join(dir, `${name}.bin`));
      const array = new Type(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
      store[name].array = array;
      store[name].length = array.length;
    }
    store.props = JSON.parse(readFileSync(join(dir, 'props.json'), 'utf8')).map((props) => Object.freeze(props));
    store.props.forEach((props, index) => store.propsKeys.set(JSON.stringify(props), index));
    return store;
  }
}
