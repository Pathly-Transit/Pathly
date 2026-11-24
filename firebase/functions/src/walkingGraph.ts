import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { gunzipSync, gzipSync } from 'zlib';

/**
 * A pedestrian street graph of the service area, built from OpenStreetMap's pedestrian network (or,
 * without its extracts, from public streets and paths: Census
 * TIGER/Line, New York City's path and sidewalk data, USGS trails) by
 * scripts/build-walking-tiles.js and bundled with the deploy under static_data/walking/, so
 * "which stop is closest on foot" needs no paid API and no network call.
 *
 * The graph is cut into square tiles of TILE_DEGREES. Each node lives in exactly one tile (its
 * "home" tile, by its own coordinates), and that tile stores every edge leaving it, including
 * edges to nodes in other tiles. A node's global id encodes its home tile and its index there,
 * so the search can follow an edge into a tile it hasn't loaded yet and load it then.
 *
 * Tile file (gzipped): "PWK2", u32 nodeCount, u32 edgeCount, then i32 lat[n] and i32 lon[n]
 * (microdegrees), u32 edgeStart[n + 1] (CSR offsets), f64 edgeTarget[e] (global ids),
 * u16 edgeMeters[e], u16 edgeCost[e]. All little-endian. manifest.json lists every tile that has nodes.
 *
 * An edge's cost is what the search minimizes: its meters, weighted the way people choose a walk
 * (the sidewalk over the middle of the street beside it, a crossing at a traffic light over an
 * unmarked one). Walk lengths and times are still the real meters along the chosen walk.
 */

export const WALKING_TILE_DEGREES = 0.02;
export const WALKING_FORMAT_VERSION = 2;
const MAGIC = 'PWK2';
const LOCAL_SPAN = 2 ** 20;
const LAT_TILES = Math.round(180 / WALKING_TILE_DEGREES);

export type WalkingTile = {
  lat: Int32Array;
  lon: Int32Array;
  edgeStart: Uint32Array;
  edgeTarget: Float64Array;
  edgeMeters: Uint16Array;
  edgeCost: Uint16Array;
};

/** `credits`: what the graph's sources ask to be credited wherever its walks show (deploys check the app's map shows them). */
export type WalkingManifest = { version: number; tileDegrees: number; tiles: string[]; source?: string; credits?: string[]; builtAt?: string };

export function tileXY(lat: number, lon: number): [number, number] {
  return [Math.floor((lon + 180) / WALKING_TILE_DEGREES), Math.floor((lat + 90) / WALKING_TILE_DEGREES)];
}

export function tileKey(x: number, y: number): string {
  return `${x}_${y}`;
}

export function globalNodeId(x: number, y: number, localIndex: number): number {
  return (x * LAT_TILES + y) * LOCAL_SPAN + localIndex;
}

function splitNodeId(id: number): { x: number; y: number; localIndex: number } {
  const tile = Math.floor(id / LOCAL_SPAN);
  return { x: Math.floor(tile / LAT_TILES), y: tile % LAT_TILES, localIndex: id % LOCAL_SPAN };
}

export function encodeWalkingTile(tile: WalkingTile): Buffer {
  const nodeCount = tile.lat.length;
  const edgeCount = tile.edgeTarget.length;
  if (nodeCount >= LOCAL_SPAN) throw new Error(`walking tile has too many nodes (${nodeCount})`);
  const buffer = Buffer.alloc(12 + nodeCount * 8 + (nodeCount + 1) * 4 + edgeCount * 12);
  buffer.write(MAGIC, 0, 'ascii');
  buffer.writeUInt32LE(nodeCount, 4);
  buffer.writeUInt32LE(edgeCount, 8);
  let offset = 12;
  for (const value of tile.lat) offset = buffer.writeInt32LE(value, offset);
  for (const value of tile.lon) offset = buffer.writeInt32LE(value, offset);
  for (const value of tile.edgeStart) offset = buffer.writeUInt32LE(value, offset);
  for (const value of tile.edgeTarget) offset = buffer.writeDoubleLE(value, offset);
  for (const value of tile.edgeMeters) offset = buffer.writeUInt16LE(value, offset);
  for (const value of tile.edgeCost) offset = buffer.writeUInt16LE(value, offset);
  return gzipSync(buffer);
}

export function decodeWalkingTile(gzipped: Buffer): WalkingTile {
  const buffer = gunzipSync(gzipped);
  if (buffer.toString('ascii', 0, 4) !== MAGIC) throw new Error('not a walking tile');
  const nodeCount = buffer.readUInt32LE(4);
  const edgeCount = buffer.readUInt32LE(8);
  // Copied out of the buffer so every typed array is aligned.
  const take = <T>(Type: { new (source: ArrayBuffer): T; BYTES_PER_ELEMENT: number }, start: number, count: number): T => (
    new Type(buffer.buffer.slice(buffer.byteOffset + start, buffer.byteOffset + start + count * Type.BYTES_PER_ELEMENT) as ArrayBuffer)
  );
  let offset = 12;
  const lat = take(Int32Array, offset, nodeCount); offset += nodeCount * 4;
  const lon = take(Int32Array, offset, nodeCount); offset += nodeCount * 4;
  const edgeStart = take(Uint32Array, offset, nodeCount + 1); offset += (nodeCount + 1) * 4;
  const edgeTarget = take(Float64Array, offset, edgeCount); offset += edgeCount * 8;
  const edgeMeters = take(Uint16Array, offset, edgeCount); offset += edgeCount * 2;
  const edgeCost = take(Uint16Array, offset, edgeCount);
  return { lat, lon, edgeStart, edgeTarget, edgeMeters, edgeCost };
}

let dataRoot = join(__dirname, '../static_data/walking');
let manifest: { tiles: Set<string> } | null | undefined;
const EMPTY_TILE: WalkingTile = { lat: new Int32Array(0), lon: new Int32Array(0), edgeStart: new Uint32Array(1), edgeTarget: new Float64Array(0), edgeMeters: new Uint16Array(0), edgeCost: new Uint16Array(0) };
// Bounded so an instance serving riders all over the area doesn't keep the whole region in memory.
const MAX_CACHED_TILES = 96;
const tileCache = new Map<string, WalkingTile>();

function loadManifest(): { tiles: Set<string> } | null {
  if (manifest !== undefined) return manifest;
  const path = join(dataRoot, 'manifest.json');
  try {
    const parsed = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as WalkingManifest) : null;
    manifest = parsed && parsed.version === WALKING_FORMAT_VERSION && parsed.tileDegrees === WALKING_TILE_DEGREES ? { tiles: new Set(parsed.tiles) } : null;
  } catch {
    manifest = null;
  }
  return manifest;
}

/** Whether walking data is bundled on this instance at all; without it, callers fall back to straight-line distance. */
export function hasWalkingData(): boolean {
  return loadManifest() !== null;
}

function loadTile(x: number, y: number): WalkingTile {
  const key = tileKey(x, y);
  const cached = tileCache.get(key);
  if (cached) {
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }
  // A tile the manifest doesn't list has no walkable nodes (open water, mostly).
  const tile = loadManifest()?.tiles.has(key) ? decodeWalkingTile(readFileSync(join(dataRoot, `${key}.bin.gz`))) : EMPTY_TILE;
  tileCache.set(key, tile);
  // Cached snaps and searches may point into an evicted tile; it simply reloads when reached.
  if (tileCache.size > MAX_CACHED_TILES) tileCache.delete(tileCache.keys().next().value!);
  return tile;
}

// A point joins the graph on the nearest stretch of street or path (an edge, drawn straight
// between its two nodes), at the spot along it closest to the point, and walks on from either end.
// Never at a node merely nearby: one around a corner, or at the dead end of the next street over,
// is reached in a straight line through yards and buildings.
const SNAP_MAX_METERS = 250;
/**
 * How far (beyond SNAP_MAX_METERS) a node may be and still have an edge passing within reach. An
 * edge is stored at both its ends, so one end in the tiles searched is enough.
 */
const SNAP_EDGE_REACH_METERS = 300;

/** Where a point joins the graph: the closest spot on the nearest edge, the meters off it, and the edge's two ends (meters and cost along it from the spot). */
type Snap = {
  lat: number;
  lon: number;
  offMeters: number;
  edge: string;
  ends: { id: number; meters: number; cost: number }[];
};

// Stops are snapped again on every request, so their snaps are kept (cleared with the tiles).
const MAX_CACHED_SNAPS = 20_000;
const snapCache = new Map<string, Snap | null>();

function snap(lat: number, lon: number): Snap | null {
  const key = `${lat},${lon}`;
  if (snapCache.has(key)) return snapCache.get(key)!;
  const result = snapUncached(lat, lon);
  snapCache.set(key, result);
  if (snapCache.size > MAX_CACHED_SNAPS) snapCache.delete(snapCache.keys().next().value!);
  return result;
}

function snapUncached(lat: number, lon: number): Snap | null {
  const [cx, cy] = tileXY(lat, lon);
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110_574;
  const reach = SNAP_MAX_METERS + SNAP_EDGE_REACH_METERS;
  let best: { meters: number; t: number; from: number; to: number; ax: number; ay: number; bx: number; by: number; length: number; edgeMeters: number; edgeCost: number } | null = null;
  for (let x = cx - 1; x <= cx + 1; x += 1) {
    for (let y = cy - 1; y <= cy + 1; y += 1) {
      const tile = loadTile(x, y);
      for (let index = 0; index < tile.lat.length; index += 1) {
        const ay = (tile.lat[index]! / 1e6 - lat) * ky;
        if (Math.abs(ay) > reach) continue;
        const ax = (tile.lon[index]! / 1e6 - lon) * kx;
        if (Math.abs(ax) > reach) continue;
        const from = globalNodeId(x, y, index);
        for (let edge = tile.edgeStart[index]!; edge < tile.edgeStart[index + 1]!; edge += 1) {
          const to = tile.edgeTarget[edge]!;
          const target = nodeLatLon(to);
          const bx = (target.lon - lon) * kx;
          const by = (target.lat - lat) * ky;
          if (Math.min(ax, bx) > SNAP_MAX_METERS || Math.max(ax, bx) < -SNAP_MAX_METERS || Math.min(ay, by) > SNAP_MAX_METERS || Math.max(ay, by) < -SNAP_MAX_METERS) continue;
          const [dx, dy] = [bx - ax, by - ay];
          const length2 = dx * dx + dy * dy;
          const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
          const meters = Math.hypot(ax + t * dx, ay + t * dy);
          if (meters <= SNAP_MAX_METERS && (!best || meters < best.meters)) {
            best = { meters, t, from, to, ax, ay, bx, by, length: Math.sqrt(length2), edgeMeters: tile.edgeMeters[edge]!, edgeCost: tile.edgeCost[edge]! };
          }
        }
      }
    }
  }
  if (!best) return null;
  // The edge's own meters (along its street, which may bend) shared out by where the spot falls.
  const costPerMeter = best.edgeCost / best.edgeMeters;
  const along = (share: number) => ({ meters: best!.edgeMeters * share, cost: best!.edgeMeters * share * costPerMeter });
  return {
    lat: lat + (best.ay + best.t * (best.by - best.ay)) / ky,
    lon: lon + (best.ax + best.t * (best.bx - best.ax)) / kx,
    offMeters: best.meters,
    edge: `${best.from}:${best.to}`,
    ends: [{ id: best.from, ...along(best.t) }, { id: best.to, ...along(1 - best.t) }],
  };
}

/** A walk found: its meters, the last graph node on it (-1 when it runs along a single edge), and the spot it leaves the graph. */
type Walk = { meters: number; endId: number; endSpot: { lat: number; lon: number } };

/** How far past a walk's meters its cost may run before the search gives up on it. */
const COST_REACH = 1.5;

/** A binary min-heap of (node, meters), allowing stale duplicates (skipped when popped). */
class NodeHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number { return this.ids.length; }
  peekKey(): number { return this.keys[0] ?? Infinity; }
  push(id: number, key: number): void {
    let index = this.ids.length;
    this.ids.push(id);
    this.keys.push(key);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.keys[parent]! <= key) break;
      this.ids[index] = this.ids[parent]!;
      this.keys[index] = this.keys[parent]!;
      index = parent;
    }
    this.ids[index] = id;
    this.keys[index] = key;
  }
  pop(): { id: number; key: number } {
    const top = { id: this.ids[0]!, key: this.keys[0]! };
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length > 0) {
      let index = 0;
      const length = this.ids.length;
      for (;;) {
        const left = index * 2 + 1;
        if (left >= length) break;
        const right = left + 1;
        const child = right < length && this.keys[right]! < this.keys[left]! ? right : left;
        if (this.keys[child]! >= lastKey) break;
        this.ids[index] = this.ids[child]!;
        this.keys[index] = this.keys[child]!;
        index = child;
      }
      this.ids[index] = lastId;
      this.keys[index] = lastKey;
    }
    return top;
  }
}

/**
 * Dijkstra from one origin that pauses as soon as it has settled what was asked, and resumes from
 * there for the next question, so every route in one Nearby or live-status request (all from the
 * same rider location) shares one search.
 */
class WalkingSearch {
  // Settled and tentative nodes' costs (what the search minimizes), and the real meters of each one's walk.
  private readonly settled = new Map<number, number>();
  private readonly best = new Map<number, number>();
  private readonly meters = new Map<number, number>();
  // Each reached node's previous node on its shortest walk (-1 for where the walk starts), for paths.
  private readonly previous = new Map<number, number>();
  private readonly heap = new NodeHeap();

  /** Where the walk joins the graph (null when the origin is off it). */
  readonly start: Snap | null;

  constructor(lat: number, lon: number) {
    this.start = snap(lat, lon);
    for (const end of this.start?.ends ?? []) this.relax(end.id, this.start!.offMeters + end.cost, this.start!.offMeters + end.meters, -1);
  }

  private relax(id: number, cost: number, meters: number, from: number): void {
    if (this.settled.has(id) || cost >= (this.best.get(id) ?? Infinity)) return;
    this.best.set(id, cost);
    this.meters.set(id, meters);
    this.previous.set(id, from);
    this.heap.push(id, cost);
  }

  /** Expands until every node costing less than `cost` is settled. */
  private expandTo(cost: number): void {
    while (this.heap.size > 0 && this.heap.peekKey() <= cost) {
      const { id, key } = this.heap.pop();
      if (this.settled.has(id)) continue;
      this.settled.set(id, key);
      const { x, y, localIndex } = splitNodeId(id);
      const tile = loadTile(x, y);
      const meters = this.meters.get(id)!;
      for (let edge = tile.edgeStart[localIndex]!; edge < tile.edgeStart[localIndex + 1]!; edge += 1) {
        this.relax(tile.edgeTarget[edge]!, key + tile.edgeCost[edge]!, meters + tile.edgeMeters[edge]!, id);
      }
    }
  }

  private readonly answers = new Map<string, Walk | null>();

  /** The walk to a point (its length, and the graph node and spot it reaches the point from), or null when it isn't reachable on foot within `limitMeters`. */
  walkTo(lat: number, lon: number, limitMeters: number): Walk | null {
    const key = `${lat},${lon},${limitMeters}`;
    if (this.answers.has(key)) return this.answers.get(key)!;
    const answer = this.search(lat, lon, limitMeters);
    this.answers.set(key, answer);
    return answer;
  }

  /** The graph nodes of a settled node's shortest walk, from where it starts to `endId` (none for -1: a walk along one edge). */
  nodesTo(endId: number): number[] {
    const nodes: number[] = [];
    for (let id = endId; id !== -1; id = this.previous.get(id) ?? -1) nodes.push(id);
    return nodes.reverse();
  }

  private search(lat: number, lon: number, limitMeters: number): Walk | null {
    const arrival = snap(lat, lon);
    if (!arrival || !this.start) return null;
    const ends = arrival.ends;
    const endSpot = { lat: arrival.lat, lon: arrival.lon };
    let best: { cost: number; meters: number; endId: number } | null = null;
    // On the same stretch as the start: straight along it, through neither end.
    if (arrival.edge === this.start.edge) {
      const meters = this.start.offMeters + Math.abs(this.start.ends[0]!.meters - ends[0]!.meters) + arrival.offMeters;
      const cost = this.start.offMeters + Math.abs(this.start.ends[0]!.cost - ends[0]!.cost) + arrival.offMeters;
      best = { cost, meters, endId: -1 };
    }
    // A walk costs more than its meters (along busy streets, across them), so the search reaches a
    // little past the limit in cost; the limit itself holds the chosen walk's real meters.
    const limitCost = limitMeters * COST_REACH;
    // Settle outward in steps, stopping once nothing cheaper can still turn up.
    for (let reach = 0; reach <= limitCost; ) {
      reach = Math.min(limitCost, reach + 400);
      this.expandTo(reach);
      for (const end of ends) {
        const cost = this.settled.get(end.id);
        if (cost !== undefined && (!best || cost + end.cost + arrival.offMeters < best.cost)) {
          best = { cost: cost + end.cost + arrival.offMeters, meters: this.meters.get(end.id)! + end.meters + arrival.offMeters, endId: end.id };
        }
      }
      if ((best && best.cost <= reach) || reach >= limitCost) break;
    }
    return best && best.meters <= limitMeters ? { meters: Math.round(best.meters), endId: best.endId, endSpot } : null;
  }
}

function nodeLatLon(id: number): { lat: number; lon: number } {
  const { x, y, localIndex } = splitNodeId(id);
  const tile = loadTile(x, y);
  return { lat: tile.lat[localIndex]! / 1e6, lon: tile.lon[localIndex]! / 1e6 };
}

// Searches by origin rounded to about 10 m: a rider standing still (and every route in one
// request) reuses one search; a few recent origins stay around for the next refresh.
const MAX_CACHED_SEARCHES = 8;
const searchCache = new Map<string, WalkingSearch>();

function searchFrom(lat: number, lon: number): WalkingSearch {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  let search = searchCache.get(key);
  if (search) searchCache.delete(key);
  else search = new WalkingSearch(Number(lat.toFixed(4)), Number(lon.toFixed(4)));
  searchCache.set(key, search);
  if (searchCache.size > MAX_CACHED_SEARCHES) searchCache.delete(searchCache.keys().next().value!);
  return search;
}

/**
 * Walking meters from a point to another, along the street graph. Null when there's no walking
 * data on this instance, either point is off the graph, or the walk is longer than `limitMeters`.
 */
export function walkingMeters(fromLat: number, fromLon: number, toLat: number, toLon: number, limitMeters: number): number | null {
  if (!hasWalkingData()) return null;
  try {
    return searchFrom(fromLat, fromLon).walkTo(toLat, toLon, limitMeters)?.meters ?? null;
  } catch {
    // A missing or corrupt tile mustn't break Nearby: the caller falls back to straight line.
    return null;
  }
}

/**
 * The walk itself, as points from (fromLat, fromLon) along the streets to (toLat, toLon) — the
 * same walk walkingMeters measures — for drawing. Null whenever walkingMeters would be.
 */
export function walkingPath(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  limitMeters: number,
): { meters: number; path: { lat: number; lon: number }[] } | null {
  if (!hasWalkingData()) return null;
  try {
    const search = searchFrom(fromLat, fromLon);
    const walk = search.walkTo(toLat, toLon, limitMeters);
    if (!walk) return null;
    // From the rider onto the street, along it, and off it to the destination.
    const startSpot = search.start ? [{ lat: search.start.lat, lon: search.start.lon }] : [];
    const path = [{ lat: fromLat, lon: fromLon }, ...startSpot, ...search.nodesTo(walk.endId).map(nodeLatLon), walk.endSpot, { lat: toLat, lon: toLon }];
    return { meters: walk.meters, path };
  } catch {
    return null;
  }
}

/** Unit tests only: read tiles from `root` (null restores the bundled data) and drop every cache. */
export function setWalkingDataForTests(root: string | null): void {
  dataRoot = root ?? join(__dirname, '../static_data/walking');
  manifest = undefined;
  tileCache.clear();
  snapCache.clear();
  searchCache.clear();
}
