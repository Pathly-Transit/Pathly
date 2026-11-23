const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { haversineMeters } = require('../lib/geo');
const { TransitNetwork, TRANSFER_DETOUR, WALK_METERS_PER_SECOND, WALK_TRANSFER_SLACK_SECONDS } = require('../lib/transitNetwork');
const { createWalkingTransfers, TRANSFER_WALK_METERS, LESS_WALKING_TRANSFER_METERS, MAX_TRANSFER_WALK_CACHE_ENTRIES } = require('../lib/walkingTransfers');
const { setWalkingDataForTests } = require('../lib/walkingGraph');
const { writeWalkingTiles } = require('../lib/walkingTilesBuild');
const { buildTimetable, stopIndex } = require('./helpers/routingFeeds');

const A = { id: 'unnamed-west', lat: 40.7, lng: -73.9 };
const B = { id: 'unnamed-east', lat: 40.7, lng: -73.8965 };
const C = { id: 'unnamed-north', lat: 40.705, lng: -73.9 };
const MID = { lat: 40.702, lng: -73.89825 };
let root;
let graphNumber = 0;

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-transfer-resolver-'));
});
test.beforeEach(() => setWalkingDataForTests(path.join(root, 'no-graph')));
test.after(() => {
  setWalkingDataForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

async function networkFor(stops = [A, B, C], { transfers, parents = [] } = {}) {
  const clock = (index) => `08:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}`;
  const timetable = await buildTimetable('nice', {
    'agency.txt': 'agency_id,agency_name,agency_url\nN,N,https://example.com\n',
    'routes.txt': 'route_id,agency_id,route_short_name,route_long_name,route_type\nR,N,R,Route,3\n',
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,parent_station,location_type\n'
      + [...stops, ...parents].map((stop) => `${stop.id},${stop.id},${stop.lat},${stop.lng},${stop.parent ?? ''},${parents.includes(stop) ? 1 : 0}`).join('\n') + '\n',
    'trips.txt': 'route_id,service_id,trip_id,direction_id\nR,WK,R1,0\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
      + stops.map((stop, index) => `R1,${clock(index)},${clock(index)},${stop.id},${index + 1}`).join('\n') + '\n',
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,1,1,20260101,20271231\n',
    ...(transfers ? { 'transfers.txt': transfers } : {}),
  });
  return new TransitNetwork([{ agencyId: 'nice', version: 'generic-walk-test', timetable }]);
}

function graph(points, edges) {
  const dir = path.join(root, `graph-${graphNumber++}`);
  writeWalkingTiles(dir, points.map((point) => ({ lat: point.lat, lon: point.lng })), edges.map(([a, b, meters]) => ({ a, b, meters })));
  setWalkingDataForTests(dir);
}

const index = (network, point) => stopIndex(network, point.id);
const edge = (resolver, from, to, direction = 'forward') => resolver.resolve(from, direction).find((entry) => entry.stop === to);
const journey = (from, to, seconds) => ({ legs: [{ kind: 'walk', from, to, seconds }], departs: 0, arrives: seconds, rides: 0 });
const secondsFor = (meters) => Math.round(meters / WALK_METERS_PER_SECOND) + WALK_TRANSFER_SLACK_SECONDS;

test('unnamed served stops beyond the old radius are discovered under the request walking policy', async () => {
  const network = await networkFor();
  const a = index(network, A), c = index(network, C);
  const straight = haversineMeters(A.lat, A.lng, C.lat, C.lng);
  assert.ok(straight > 450 && straight * 1.3 < TRANSFER_WALK_METERS);
  assert.equal(network.publishedTransferSeconds(a, c), undefined);
  const normal = createWalkingTransfers(network, new Map());
  const forward = edge(normal, a, c);
  assert.ok(forward);
  assert.equal(forward.seconds, secondsFor(straight * TRANSFER_DETOUR));
  assert.deepEqual(edge(normal, c, a, 'backward'), { ...forward, stop: a });
  assert.equal(normal.isValidated(journey(a, c, forward.seconds)), true, 'no-graph fallback uses its conservative cost');
  assert.equal(edge(createWalkingTransfers(network, new Map(), true), a, c), undefined);
});

test('street candidates start optimistic, then exact measured costs invalidate undercounted journeys', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  const walks = new Map();
  const resolver = createWalkingTransfers(network, walks);
  const optimistic = edge(resolver, a, b);
  assert.equal(optimistic.seconds, secondsFor(haversineMeters(A.lat, A.lng, B.lat, B.lng)));
  const before = journey(a, b, optimistic.seconds);
  assert.equal(resolver.isValidated(before), false);
  assert.deepEqual(resolver.validate([before]), { changed: true, checks: 1 });
  const measured = walks.get(`${a}>${b}`);
  assert.equal(measured.kind, 'measured');
  assert.equal(measured.meters, 600);
  assert.deepEqual(measured.path[0], { lat: A.lat, lng: A.lng });
  assert.deepEqual(walks.get(`${b}>${a}`).path, [...measured.path].reverse());
  assert.equal(edge(resolver, a, b).seconds, secondsFor(600));
  assert.equal(resolver.isValidated(before), false, 'a previously selected tight transfer must be searched again');
  assert.equal(resolver.isValidated(journey(a, b, secondsFor(600))), true);
  assert.deepEqual(resolver.validate([before]), { changed: false, checks: 0 });
});

test('lessWalking measurements cannot poison a later normal request or vice versa', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  for (const strictFirst of [true, false]) {
    const walks = new Map();
    const first = createWalkingTransfers(network, walks, strictFirst);
    const initial = edge(first, a, b);
    assert.ok(initial, 'the straight lower bound initially fits either policy');
    assert.deepEqual(first.validate([journey(a, b, initial.seconds)]), { changed: true, checks: 1 });
    assert.equal(walks.get(`${a}>${b}`).meters, 600, 'even the strict request measures the normal ceiling');
    const normal = createWalkingTransfers(network, walks);
    const strict = createWalkingTransfers(network, walks, true);
    assert.ok(edge(normal, a, b));
    assert.equal(edge(strict, a, b), undefined);
    assert.equal(edge(strict, b, a, 'backward'), undefined);
    assert.equal(strict.isValidated(journey(a, b, secondsFor(600))), false);
    assert.ok(LESS_WALKING_TRANSFER_METERS < 600 && TRANSFER_WALK_METERS > 600);
  }
});

test('resolved edge lists are reused until another shared-cache resolver measures the walk', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  const walks = new Map();
  const normal = createWalkingTransfers(network, walks);
  const strict = createWalkingTransfers(network, walks, true);
  const writer = createWalkingTransfers(network, walks);
  const before = normal.resolve(a, 'forward');
  const reverseBefore = normal.resolve(b, 'backward');
  const strictBefore = strict.resolve(a, 'forward');
  assert.strictEqual(normal.resolve(a, 'forward'), before, 'repeated searches reuse the resolved list');
  assert.strictEqual(normal.resolve(b, 'backward'), reverseBefore);
  assert.ok(strictBefore.some((entry) => entry.stop === b));
  const selected = journey(a, b, before.find((entry) => entry.stop === b).seconds);
  assert.deepEqual(writer.validate([selected]), { changed: true, checks: 1 });
  const after = normal.resolve(a, 'forward');
  assert.notStrictEqual(after, before, 'another resolver invalidates the cached optimistic time');
  assert.equal(after.find((entry) => entry.stop === b).seconds, secondsFor(600));
  assert.equal(normal.resolve(b, 'backward').find((entry) => entry.stop === a).seconds, secondsFor(600));
  assert.equal(strict.resolve(a, 'forward').find((entry) => entry.stop === b), undefined, 'each cached list retains its own policy');
  assert.strictEqual(normal.resolve(a, 'forward'), after, 'the new generation is cached too');
});

test('a bounded failure is retried at a wider limit without changing published constraints', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  assert.equal(network.publishedTransferSeconds(a, b), undefined);
  assert.equal(network.publishedTransferSeconds(b, a), undefined);
  const walks = new Map([[`${a}>${b}`, { kind: 'notWithin', checkedMeters: 390 }]]);
  assert.equal(edge(createWalkingTransfers(network, walks, true), a, b), undefined);
  const normal = createWalkingTransfers(network, walks);
  const selected = journey(a, b, edge(normal, a, b).seconds);
  assert.deepEqual(normal.validate([selected]), { changed: true, checks: 1 });
  assert.equal(walks.get(`${a}>${b}`).kind, 'measured');
  assert.equal(network.publishedTransferSeconds(a, b), undefined);
  assert.equal(network.publishedTransferSeconds(b, a), undefined);
});

test('disconnected street components are rejected with a bounded cache entry in both directions', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, B], []);
  const walks = new Map();
  const resolver = createWalkingTransfers(network, walks);
  const selected = journey(a, b, edge(resolver, a, b).seconds);
  assert.deepEqual(resolver.validate([selected]), { changed: true, checks: 1 });
  assert.deepEqual(walks.get(`${a}>${b}`), { kind: 'notWithin', checkedMeters: 780 });
  assert.deepEqual(walks.get(`${b}>${a}`), { kind: 'notWithin', checkedMeters: 780 });
  assert.equal(edge(resolver, a, b), undefined);
  assert.equal(edge(resolver, b, a, 'backward'), undefined);
  assert.equal(resolver.isValidated(selected), false);
  assert.equal(network.publishedTransferSeconds(a, b), undefined);
});

test('published forbids and minima remain directed for forward and arrive-by searches', async () => {
  const network = await networkFor([A, B, C], {
    transfers: `from_stop_id,to_stop_id,transfer_type,min_transfer_time\n${A.id},${B.id},3,\n${B.id},${A.id},2,900\n`,
  });
  const a = index(network, A), b = index(network, B);
  assert.equal(network.publishedTransferSeconds(a, b), -1);
  assert.equal(network.publishedTransferSeconds(b, a), 900);
  assert.deepEqual(network.publishedTransfers(b, 'backward'), [{ stop: a, seconds: -1 }]);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  const resolver = createWalkingTransfers(network, new Map());
  assert.equal(edge(resolver, a, b), undefined);
  assert.equal(edge(resolver, b, a, 'backward'), undefined);
  assert.deepEqual(edge(resolver, b, a), { stop: a, seconds: 900 });
  assert.deepEqual(edge(resolver, a, b, 'backward'), { stop: b, seconds: 900 });
  assert.deepEqual(resolver.validate([journey(b, a, 900)]), { changed: true, checks: 1 });
  assert.equal(network.publishedTransferSeconds(a, b), -1, 'street measurements cannot change the provider prohibition');
  assert.equal(network.publishedTransferSeconds(b, a), 900, 'street measurements cannot reduce the provider minimum');
  assert.equal(edge(resolver, a, b), undefined);
  assert.deepEqual(edge(resolver, b, a), { stop: a, seconds: 900 });
  assert.equal(resolver.isValidated(journey(b, a, 899)), false);
  assert.equal(resolver.isValidated(journey(b, a, 900)), true);
});

test('validation respects its work cap, deduplicates reverse walks, and never validates unmeasured leftovers', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B), c = index(network, C);
  graph([A, MID, B, C], [[0, 1, 300], [1, 2, 300], [0, 3, 560]]);
  const resolver = createWalkingTransfers(network, new Map());
  const ab = journey(a, b, edge(resolver, a, b).seconds);
  const ba = journey(b, a, edge(resolver, b, a).seconds);
  const ac = journey(a, c, edge(resolver, a, c).seconds);
  assert.deepEqual(resolver.validate([ab, ba, ac], 0), { changed: false, checks: 0 });
  assert.deepEqual(resolver.validate([ab, ba, ac], 1), { changed: true, checks: 1 });
  assert.equal(resolver.isValidated(ac), false);
  assert.deepEqual(resolver.validate([ac], 1), { changed: true, checks: 1 });
  assert.equal(resolver.isValidated(journey(a, c, edge(resolver, a, c).seconds)), true);
});

test('same-parent platform passages retain their GTFS minimum without requiring outdoor graph coverage', async () => {
  const parent = { id: 'station', lat: A.lat, lng: A.lng };
  const network = await networkFor([{ ...A, parent: parent.id }, { ...B, parent: parent.id }], {
    parents: [parent],
    transfers: `from_stop_id,to_stop_id,transfer_type,min_transfer_time\n${A.id},${B.id},2,600\n`,
  });
  graph([C], []);
  const a = index(network, A), b = index(network, B);
  const resolver = createWalkingTransfers(network, new Map());
  const selected = journey(a, b, edge(resolver, a, b).seconds);
  assert.equal(selected.legs[0].seconds, 600);
  assert.equal(resolver.isValidated(selected), true);
  assert.deepEqual(resolver.validate([selected]), { changed: false, checks: 0 });
  assert.deepEqual(resolver.resolve(index(network, parent), 'forward'), [], 'an unserved parent does not become a boarding stop');
});

test('lazy geographic candidates are not truncated to a fixed neighbor count', async () => {
  const stops = [A, ...Array.from({ length: 130 }, (_, i) => ({
    id: `generic-${i}`, lat: A.lat + 0.002 * Math.sin(i), lng: A.lng + 0.002 * Math.cos(i),
  }))];
  const network = await networkFor(stops);
  const resolver = createWalkingTransfers(network, new Map());
  assert.equal(resolver.resolve(index(network, A), 'forward').length, 130);
});

test('the warm physical cache is bounded and evicts both directions of the oldest pair', async () => {
  const network = await networkFor();
  const a = index(network, A), b = index(network, B);
  graph([A, MID, B], [[0, 1, 300], [1, 2, 300]]);
  const walks = new Map();
  for (let i = 0; i < MAX_TRANSFER_WALK_CACHE_ENTRIES / 2; i += 1) {
    const from = 10000 + i * 2, to = from + 1;
    walks.set(`${from}>${to}`, { kind: 'notWithin', checkedMeters: 780 });
    walks.set(`${to}>${from}`, { kind: 'notWithin', checkedMeters: 780 });
  }
  const resolver = createWalkingTransfers(network, walks);
  assert.deepEqual(resolver.validate([journey(a, b, edge(resolver, a, b).seconds)]), { changed: true, checks: 1 });
  assert.equal(walks.size, MAX_TRANSFER_WALK_CACHE_ENTRIES);
  assert.equal(walks.has('10000>10001'), false);
  assert.equal(walks.has('10001>10000'), false);
  assert.equal(walks.get(`${a}>${b}`).kind, 'measured');
  assert.equal(walks.get(`${b}>${a}`).kind, 'measured');
  for (const key of walks.keys()) assert.ok(walks.has(key.split('>').reverse().join('>')));
});
