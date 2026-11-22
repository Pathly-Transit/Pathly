const assert = require('node:assert/strict');
const test = require('node:test');
const staticData = require('../lib/gtfsStaticData');
const { encodeRoutingTimetable } = require('../lib/routingTimetable');
const { resolveRideGuideSelection, resetRunSchedulesForTests, scheduleVersionForTimetable } = require('../lib/tripRunSchedule');
const { parseResolveRideGuideRunRequest, resolveRideGuideRun } = require('../lib/rideGuideRun');
const { buildTimetable, busFeed, wednesdayAt } = require('./helpers/routingFeeds');

let timetable;
test.before(async () => {
  const feed = busFeed();
  feed['stop_times.txt'] = feed['stop_times.txt'].trim().split('\n').map((line, index) => {
    if (!index) return line;
    const row = line.split(','); row[4] = Number(row[4]) * 10; return row.join(',');
  }).join('\n') + '\n';
  timetable = await buildTimetable('nice', feed);
});
test.afterEach(() => resetRunSchedulesForTests());
const request = (extra = {}) => ({ version: 1, agencyId: 'nice', routeId: 'B', tripId: 'B-08:00:00', serviceDate: '20261118', boardStopId: 'B1', alightStopId: 'B3', directionId: 0, ...extra });
function prepared(t, table = timetable) {
  t.mock.method(staticData, 'agencySnapshotVersion', () => 'prepared-a');
  t.mock.method(staticData, 'readRoutingTimetableFile', async () => encodeRoutingTimetable(table));
}
function metadata(table = timetable) {
  return { stopsById: new Map(table.stopIds.map((id, index) => [id, { name: id + ' station', lat: table.stopLat[index] / 1e6, lon: table.stopLon[index] / 1e6 }])) };
}

test('a chosen static departure gains only its own canonical run, real stop sequence and timetable baseline', async (t) => {
  prepared(t);
  const run = await resolveRideGuideSelection(request());
  assert.equal(run.runRef.tripId, 'B-08:00:00');
  assert.equal(run.runRef.serviceDate, '20261118');
  assert.equal(run.runRef.scheduleVersion, scheduleVersionForTimetable(timetable));
  assert.equal(run.runRef.startTime, '08:00:00');
  assert.equal(run.runRef.boardStopSequence, 10);
  assert.equal(run.runRef.alightStopSequence, 30);
  assert.equal(run.departs, new Date(wednesdayAt(8)).toISOString());
  const response = await resolveRideGuideRun(request(), { staticData: () => metadata() });
  assert.equal(response.status, 'resolved');
  assert.deepEqual(response.stops.map((stop) => stop.stopId), ['B1', 'B2', 'B3']);
  assert.deepEqual(response.stops.map((stop) => stop.stopSequence), [10, 20, 30]);
  assert.equal(response.stops[0].name, 'B1 station');
});

test('run/date/route/direction/start/stop mismatches never select a nearby service', async (t) => {
  prepared(t);
  for (const change of [{ tripId: 'unknown-but-near-08:00' }, { serviceDate: '20261122' }, { routeId: 'another-line' }, { directionId: 1 },
    { startTime: '08:01:00' }, { boardStopId: 'unknown' }, { alightStopId: 'B2', alightOccurrence: 1 },
    { boardStopId: 'B3', alightStopId: 'B1' }, { boardStopSequence: 1 }]) {
    assert.equal(await resolveRideGuideSelection(request(change)), null, JSON.stringify(change));
  }
});

test('repeated stop visits require an explicit occurrence or actual sequence', async (t) => {
  const feed = busFeed();
  feed['stop_times.txt'] = feed['stop_times.txt'].trim().split('\n').filter((line) => !line.startsWith('B-08:00:00,')).join('\n')
    + '\nB-08:00:00,08:00:00,08:00:00,B1,10\nB-08:00:00,08:04:00,08:04:00,B2,25\nB-08:00:00,08:07:00,08:07:00,B1,40\nB-08:00:00,08:10:00,08:10:00,B3,90\n';
  const table = await buildTimetable('nice', feed);
  prepared(t, table);
  assert.equal(await resolveRideGuideSelection(request()), null);
  const second = await resolveRideGuideSelection(request({ boardStopSequence: 40 }));
  assert.equal(second.runRef.boardOccurrence, 1);
  assert.equal(second.departs, new Date(wednesdayAt(8, 7)).toISOString());
  assert.equal(await resolveRideGuideSelection(request({ boardOccurrence: 0, boardStopSequence: 40 })), null);
});

test('legacy routing artifacts use real route rows for sequence disambiguation', async (t) => {
  const { tripSequenceStart, tripStopSequence, ...legacy } = timetable;
  prepared(t, legacy);
  const routeRead = t.mock.method(staticData, 'loadRouteStopTimes', async () => ({ byTrip: new Map([['B-08:00:00', [
    { stopId: 'B3', stopSequence: 30 }, { stopId: 'B1', stopSequence: 10 }, { stopId: 'B2', stopSequence: 20 },
  ]]]) }));
  const run = await resolveRideGuideSelection(request({ boardStopSequence: 20, boardStopId: 'B2' }));
  assert.equal(run.runRef.boardStopSequence, 20);
  assert.equal(run.runRef.boardOccurrence, 0);
  assert.equal(routeRead.mock.callCount(), 1);
});

test('only documented subway aliases can identify a chosen canonical scheduled trip', async (t) => {
  const feed = busFeed();
  const canonical = 'PREFIX_000600_B..S03R';
  for (const name of ['trips.txt', 'stop_times.txt']) feed[name] = feed[name].replaceAll('B-08:00:00', canonical);
  const table = await buildTimetable('subway', feed);
  prepared(t, table);
  const run = await resolveRideGuideSelection(request({ agencyId: 'subway', tripId: '000600_B..S' }));
  assert.equal(run.runRef.tripId, canonical);
  assert.equal(await resolveRideGuideSelection(request({ agencyId: 'subway', tripId: '000600_B..N' })), null);
});

test('a shortened descriptor matching multiple service instances stays unknown without its start time', async (t) => {
  const ids = [...timetable.tripIds];
  ids[0] = 'FIRST_000600_B..S03R';
  ids[1] = 'SECOND_000600_B..S10R';
  const table = { ...timetable, agencyId: 'subway', tripIds: ids };
  prepared(t, table);
  assert.equal(await resolveRideGuideSelection(request({ agencyId: 'subway', tripId: '000600_B..S' })), null);
  const explicit = await resolveRideGuideSelection(request({ agencyId: 'subway', tripId: '000600_B..S', startTime: '08:15:00' }));
  assert.equal(explicit.runRef.tripId, 'SECOND_000600_B..S10R');
  assert.equal(explicit.runRef.startTime, '08:15:00');
});

test('malformed or unbounded identity requests fail before static-data work', () => {
  for (const invalid of [null, {}, request({ version: 2 }), request({ agencyId: '__proto__' }), request({ serviceDate: '20260230' }),
    request({ tripId: 'x'.repeat(513) }), request({ startTime: '168:00:00' }), request({ boardOccurrence: -1 }), request({ alightStopSequence: Infinity })]) {
    assert.throws(() => parseResolveRideGuideRunRequest(invalid), { code: 'invalid-argument' });
  }
  const parsed = parseResolveRideGuideRunRequest({ ...request(), departureTime: '2099-01-01T00:00:00Z', scheduleVersion: 'client-supplied' });
  assert.equal(parsed.departureTime, undefined);
  assert.equal(parsed.scheduleVersion, undefined);
});

test('a slow or missing exact run returns unknown without substituting a different service', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const timedOut = await resolveRideGuideRun(request(), { resolve: () => pending, budgetMs: 5 });
  assert.deepEqual(timedOut, { version: 1, status: 'unknown', reason: 'unavailable' });
  release(null);
  await new Promise((done) => setImmediate(done));
  assert.equal(timedOut.status, 'unknown');
  assert.deepEqual(await resolveRideGuideRun(request(), { resolve: async () => null }), { version: 1, status: 'unknown', reason: 'not-found' });
});

test('resolved payload bounds stop count and refuses unknown coordinates', async (t) => {
  prepared(t);
  const run = await resolveRideGuideSelection(request());
  const long = { ...run, stops: [run.stops[0], ...Array.from({ length: 511 }, (_, index) => ({ ...run.stops[1], stopId: 'X' + index })), run.stops.at(-1)] };
  const unused = t.mock.fn(() => { throw new Error('must not load metadata for oversized run'); });
  assert.deepEqual(await resolveRideGuideRun(request(), { resolve: async () => long, staticData: unused }), { version: 1, status: 'unknown', reason: 'unsupported-run' });
  assert.equal(unused.mock.callCount(), 0);
  assert.deepEqual(await resolveRideGuideRun(request(), { resolve: async () => run, staticData: () => ({ stopsById: new Map() }) }), { version: 1, status: 'unknown', reason: 'unsupported-run' });
  const hugeName = metadata();
  hugeName.stopsById.get('B1').name = 'x'.repeat(501);
  assert.deepEqual(await resolveRideGuideRun(request(), { resolve: async () => run, staticData: () => hugeName }), { version: 1, status: 'unknown', reason: 'unsupported-run' });
});
