const assert = require('node:assert/strict');
const test = require('node:test');
const staticData = require('../lib/gtfsStaticData');
const { decodeRoutingTimetable, encodeRoutingTimetable } = require('../lib/routingTimetable');
const { resolveSelectedRun, resetRunSchedulesForTests, scheduledRun, scheduleVersionForTimetable } = require('../lib/tripRunSchedule');
const { planTransitTrip, resetTripPlannerForTests, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { TransitNetwork } = require('../lib/transitNetwork');
const { buildTestNetwork, buildTimetable, busFeed, wednesdayAt } = require('./helpers/routingFeeds');

let timetable;
let network;
test.before(async () => {
  const feed = busFeed();
  const rows = feed['stop_times.txt'].trim().split('\n');
  feed['stop_times.txt'] = rows.map((line, index) => {
    if (!index) return line;
    const row = line.split(','); row[4] = Number(row[4]) * 10; return row.join(',');
  }).join('\n') + '\n';
  timetable = await buildTimetable('nice', feed);
  network = await buildTestNetwork();
});
test.afterEach(() => { resetRunSchedulesForTests(); resetTripPlannerForTests(); });
const ref = (overrides = {}, table = timetable) => ({
  version: 1, agencyId: 'nice', routeId: 'B', tripId: 'B-08:00:00', serviceDate: '20261118',
  scheduleVersion: scheduleVersionForTimetable(table), startTime: '08:00:00',
  boardStopId: 'B1', alightStopId: 'B3', boardOccurrence: 0, alightOccurrence: 0, directionId: 0,
  ...overrides,
});

test('new compatible routing artifacts retain original nonconsecutive sequences, not pattern positions', () => {
  const roundtrip = decodeRoutingTimetable(encodeRoutingTimetable(timetable));
  const run = scheduledRun(roundtrip, ref({}, roundtrip));
  assert.deepEqual(run.stops.map((stop) => stop.stopSequence), [10, 20, 30]);
  assert.equal(run.departs, new Date(wednesdayAt(8)).toISOString());
  assert.equal(run.arrives, new Date(wednesdayAt(8, 10)).toISOString());
  assert.equal(scheduledRun(roundtrip, ref({ boardStopSequence: 1 }, roundtrip)), null);
});

test('selected-run resolution derives authoritative times without route-file I/O when sequences exist', async (t) => {
  t.mock.method(staticData, 'agencySnapshotVersion', () => 'snapshot-a');
  t.mock.method(staticData, 'readRoutingTimetableFile', async () => encodeRoutingTimetable(timetable));
  const routeRead = t.mock.method(staticData, 'loadRouteStopTimes', async () => { throw new Error('unexpected route file'); });
  const run = await resolveSelectedRun(ref());
  assert.equal(run.runRef.boardStopSequence, 10);
  assert.equal(run.runRef.alightStopSequence, 30);
  assert.equal(routeRead.mock.callCount(), 0);
});

test('legacy v4 routing.bin stays readable and gains real sequences from its authoritative route file', async (t) => {
  const { tripSequenceStart: _starts, tripStopSequence: _sequences, ...legacy } = timetable;
  const file = encodeRoutingTimetable(legacy);
  const decoded = decodeRoutingTimetable(file);
  assert.equal(decoded.tripSequenceStart, undefined);
  t.mock.method(staticData, 'agencySnapshotVersion', () => 'snapshot-a');
  t.mock.method(staticData, 'readRoutingTimetableFile', async () => file);
  t.mock.method(staticData, 'loadRouteStopTimes', async () => ({ byTrip: new Map([['B-08:00:00', [
    { stopId: 'B3', stopSequence: 30 }, { stopId: 'B1', stopSequence: 10 }, { stopId: 'B2', stopSequence: 20 },
  ]]]) }));
  const run = await resolveSelectedRun(ref({}, decoded));
  assert.deepEqual(run.stops.map((stop) => stop.stopSequence), [10, 20, 30]);
  assert.equal(run.runRef.alightStopSequence, 30);
});

test('run identity rejects wrong dates, calendar service, versions, routes, start times and stop visits', () => {
  for (const change of [{ serviceDate: '20261122' }, { serviceDate: '20260230' }, { scheduleVersion: 'old' }, { routeId: 'other' }, { startTime: '08:01:00' }, { boardOccurrence: 1 }, { alightStopId: 'B1' }]) {
    assert.equal(scheduledRun(timetable, ref(change)), null, JSON.stringify(change));
  }
  const tomorrow = scheduledRun(timetable, ref({ serviceDate: '20261119' }));
  assert.equal(Date.parse(tomorrow.departs) - Date.parse(scheduledRun(timetable, ref()).departs), 86400_000);
});

test('repeated visits to the same stop retain distinct occurrence and raw sequence identities', async () => {
  const feed = busFeed();
  feed['stop_times.txt'] = feed['stop_times.txt'].trim().split('\n').filter((row) => !row.startsWith('B-08:00:00,')).join('\n')
    + '\nB-08:00:00,08:00:00,08:00:00,B1,10\nB-08:00:00,08:04:00,08:04:00,B2,25\nB-08:00:00,08:07:00,08:07:00,B1,40\nB-08:00:00,08:10:00,08:10:00,B3,90\n';
  const table = await buildTimetable('nice', feed);
  const run = scheduledRun(table, ref({ boardOccurrence: 1, boardStopSequence: 40, alightStopSequence: 90 }, table));
  assert.equal(run.departs, new Date(wednesdayAt(8, 7)).toISOString());
  assert.deepEqual(run.stops.map((stop) => [stop.stopId, stop.occurrence]), [['B1', 0], ['B2', 0], ['B1', 1], ['B3', 0]]);
});

test('a late schedule load cannot publish data under a changed snapshot version', async (t) => {
  let version = 'old';
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  t.mock.method(staticData, 'agencySnapshotVersion', () => version);
  t.mock.method(staticData, 'readRoutingTimetableFile', () => pending);
  const resolving = resolveSelectedRun(ref());
  version = 'new'; finish(encodeRoutingTimetable(timetable));
  assert.equal(await resolving, null);
});

test('planner emits run refs on the selected leg and every alternative without repeating transfer buffers', async () => {
  setTransitNetworkForTests(network);
  const origin = { lat: 40.6995, lng: -73.9 };
  const destination = { lat: 40.72, lng: -73.8795 };
  const itineraries = await planTransitTrip({ request: { origin: { ...origin, label: 'Home' }, destination: { ...destination, label: 'Work' }, time: { mode: 'now' }, preference: 'fastest', modes: ['bus', 'subway'], ferry: false }, origin, destination, nowMs: wednesdayAt(7, 59) });
  const legs = itineraries[0].steps.filter((step) => step.kind === 'transit');
  assert.ok(legs.length >= 2);
  for (const leg of legs) {
    assert.equal(leg.runRef.tripId, leg.tripId);
    assert.equal(leg.runRef.serviceDate, '20261118');
    assert.ok(leg.runRef.boardStopSequence >= 1);
    assert.ok(leg.departures.every((departure) => departure.runRef && departure.runRef.tripId));
    assert.equal(leg.minimumTransferSeconds, 0, 'intervening emitted walk already includes its transfer slack');
  }
  assert.ok(new Set(legs[0].departures.map((departure) => departure.runRef.tripId)).size > 1);
});

for (const [held, required] of [[false, 180], [true, 0]]) {
  test(`planner exposes the canonical same-stop rail transfer margin (held=${held})`, async () => {
    const feed = busFeed();
    feed['routes.txt'] = 'route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nA,LIBUS,A,First train,2,112233,FFFFFF\nC,LIBUS,C,Second train,2,112233,FFFFFF\n';
    feed['trips.txt'] = 'route_id,service_id,trip_id,trip_headsign,direction_id\nA,WK,A,Change,0\nC,WK,C,Work,0\n';
    feed['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon\nB1,Origin,40.70,-73.9\nB2,Change,40.72,-73.9\nB3,Work,40.74,-73.9\n';
    feed['stop_times.txt'] = `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nA,08:00:00,08:00:00,B1,10\nA,08:05:00,08:05:00,B2,30\nC,08:${held ? '06' : '08'}:00,08:${held ? '06' : '08'}:00,B2,50\nC,08:10:00,08:10:00,B3,80\n`;
    if (held) feed['transfers.txt'] = 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type\nB2,B2,A,C,1\n';
    const table = await buildTimetable('metronorth', feed);
    setTransitNetworkForTests(new TransitNetwork([{ agencyId: 'metronorth', version: 'test', timetable: table }]));
    const origin = { lat: 40.70, lng: -73.9 };
    const destination = { lat: 40.74, lng: -73.9 };
    const itineraries = await planTransitTrip({ request: { origin: { ...origin, label: 'Home' }, destination: { ...destination, label: 'Work' }, time: { mode: 'now' }, preference: 'fastest', modes: ['rail'], ferry: false }, origin, destination, nowMs: wednesdayAt(7, 59) });
    const legs = itineraries[0].steps.filter((step) => step.kind === 'transit');
    assert.equal(legs.length, 2);
    assert.equal(legs[1].minimumTransferSeconds, required);
  });
}
