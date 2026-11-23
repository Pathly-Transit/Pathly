const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { haversineMeters } = require('../lib/geo');
const { TransitNetwork, MAX_TRANSFER_METERS } = require('../lib/transitNetwork');
const { TransitRouter } = require('../lib/transitRouter');
const { planTransitTrip, resetTripPlannerForTests, serviceDaysAround, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { setWalkingDataForTests } = require('../lib/walkingGraph');
const { writeWalkingTiles } = require('../lib/walkingTilesBuild');
const { buildTimetable, stopIndex } = require('./helpers/routingFeeds');

const PENN = { lat: 40.75058844, lng: -73.99358408 };
const PATH_33 = { lat: 40.74912, lng: -73.98827 };
const BROADWAY = { lat: 40.76165318, lng: -73.80176612 };
const NEWPORT = { lat: 40.72699, lng: -74.03383 };
const mondayAt = (hour, minute = 0) => Date.UTC(2026, 10, 23, hour + 5, minute);
const CALENDAR = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261123,20261123\n';
const ALL_MODES = new Set(['rail', 'subway']);

let noWalkingData;
test.before(() => {
  noWalkingData = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-penn-path-no-walking-'));
  setWalkingDataForTests(noWalkingData);
});
test.afterEach(() => {
  resetTripPlannerForTests();
  setWalkingDataForTests(noWalkingData);
});
test.after(() => {
  setWalkingDataForTests(null);
  fs.rmSync(noWalkingData, { recursive: true, force: true });
});

async function fixture({ pennId = '237', pathId = '26724', pennServed = true, pathServed = true, pathPoint = PATH_33, pathAgency = 'path' } = {}) {
  const stationRows = (stops) => 'stop_id,stop_name,stop_lat,stop_lon,parent_station\n' + stops.map(([id, name, point, parent = '']) => `${id},${name},${point.lat},${point.lng},${parent}`).join('\n') + '\n';
  const lirrTerminal = pennServed ? pennId : 'unrelated-lirr-terminal';
  const pathTerminal = pathServed ? pathId : 'unrelated-path-terminal';
  const feed = (agency, routeId, type, stops, trips, stopTimes, transfers) => ({
    'agency.txt': `agency_id,agency_name,agency_url\n${agency},${agency},https://example.com\n`,
    'routes.txt': `route_id,agency_id,route_short_name,route_long_name,route_type\n${routeId},${agency},${routeId},${routeId},${type}\n`,
    'stops.txt': stationRows(stops),
    'trips.txt': `route_id,service_id,trip_id,direction_id\n${trips.map(([id, direction]) => `${routeId},WK,${id},${direction}`).join('\n')}\n`,
    'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence\n${stopTimes.map(([trip, at, stop, sequence]) => `${trip},${at},${at},${stop},${sequence}`).join('\n')}\n`,
    'calendar.txt': CALENDAR,
    ...(transfers ? { 'transfers.txt': transfers } : {}),
  });
  // A parent station remains loaded for its served platform's name, but no pattern calls at
  // the parent itself. This exercises the served-stop guard separately from missing IDs.
  const lirrStops = [['BDY', 'Broadway', BROADWAY], [pennId, 'Penn Station', PENN], ...(!pennServed ? [[lirrTerminal, 'Penn platform', PENN, pennId]] : [])];
  const pathStops = [[pathId, '33rd Street', pathPoint], ['NEW', 'Newport', NEWPORT], ...(!pathServed ? [[pathTerminal, 'PATH platform', pathPoint, pathId]] : [])];
  const [lirr, pathTable] = await Promise.all([
    buildTimetable('lirr', feed('lirr', 'L', 2, lirrStops, [['lirr-in', 0], ['lirr-out', 1]], [
      ['lirr-in', '08:00:00', 'BDY', 10], ['lirr-in', '08:20:00', lirrTerminal, 20],
      ['lirr-out', '09:30:00', lirrTerminal, 10], ['lirr-out', '09:50:00', 'BDY', 20],
    ], `from_stop_id,to_stop_id,transfer_type\n${lirrTerminal},BDY,3\n`)),
    buildTimetable(pathAgency, feed(pathAgency, 'P', 1, pathStops, [['path-out', 0], ['path-in', 1]], [
      ['path-out', '08:35:00', pathTerminal, 10], ['path-out', '08:50:00', 'NEW', 20],
      ['path-in', '09:00:00', 'NEW', 10], ['path-in', '09:15:00', pathTerminal, 20],
    ])),
  ]);
  return new TransitNetwork([{ agencyId: 'lirr', version: 'penn-path-test', timetable: lirr }, { agencyId: pathAgency, version: 'penn-path-test', timetable: pathTable }]);
}

function transfer(network, fromId, toId) {
  const from = network.parts.flatMap((part) => part.timetable.stopIds.flatMap((id, local) => id === fromId ? [part.stopOffset + local] : []))[0];
  const to = network.parts.flatMap((part) => part.timetable.stopIds.flatMap((id, local) => id === toId ? [part.stopOffset + local] : []))[0];
  if (from === undefined || to === undefined) return undefined;
  for (let slot = network.transferStart[from]; slot < network.transferStart[from + 1]; slot += 1) if (network.transferTo[slot] === to) return network.transferSeconds[slot];
  return undefined;
}

function route(network, reverse = false) {
  const at = mondayAt(reverse ? 8 : 7, 55);
  const { baseStartMs, days } = serviceDaysAround(at);
  return new TransitRouter(network, 3).forward(Math.round((at - baseStartMs) / 1000),
    [{ stop: stopIndex(network, reverse ? 'NEW' : 'BDY'), seconds: 0 }],
    [{ stop: stopIndex(network, reverse ? 'BDY' : 'NEW'), seconds: 0 }],
    { days, maxRounds: 3, modes: ALL_MODES, horizonSeconds: 3 * 3600 }, network.activeServices(days));
}

async function plan(network, reverse = false) {
  setTransitNetworkForTests(network);
  const origin = reverse ? NEWPORT : BROADWAY;
  const destination = reverse ? BROADWAY : NEWPORT;
  const at = mondayAt(reverse ? 8 : 7, 55);
  return planTransitTrip({ request: { origin: { ...origin, label: 'Origin' }, destination: { ...destination, label: 'Destination' }, time: { mode: 'depart', at: new Date(at).toISOString() }, preference: 'fastest', modes: ['rail', 'subway'], ferry: false }, origin, destination, nowMs: at });
}

for (const reverse of [false, true]) test(`Penn–33rd Street connects two real-builder rides ${reverse ? 'PATH to LIRR' : 'LIRR to PATH'}`, async () => {
  const network = await fixture();
  const from = stopIndex(network, '237'), to = stopIndex(network, '26724');
  const meters = haversineMeters(network.stopLat[from], network.stopLon[from], network.stopLat[to], network.stopLon[to]);
  assert.equal(MAX_TRANSFER_METERS, 450, 'the general transfer radius stays bounded');
  assert.ok(meters > MAX_TRANSFER_METERS && meters < 600);
  assert.equal(transfer(network, '237', '26724'), network.estimatedWalkSeconds(from, to, meters));
  assert.equal(transfer(network, '26724', '237'), network.estimatedWalkSeconds(to, from, meters));
  assert.equal(transfer(network, '237', 'BDY'), -1, 'an explicit forbidden transfer stays forbidden');
  const journeys = route(network, reverse);
  assert.ok(journeys.some((journey) => journey.rides === 2), 'the real router reaches the second agency');
  const itineraries = await plan(network, reverse);
  const itinerary = itineraries.find((entry) => entry.steps.filter((step) => step.kind === 'transit').length === 2);
  assert.ok(itinerary, 'the real planner emits both transit legs');
  assert.deepEqual(itinerary.steps.filter((step) => step.kind === 'transit').map((step) => step.liveRoute.agencyId), reverse ? ['path', 'lirr'] : ['lirr', 'path']);
});

for (const [name, options] of [
  ['unnamed pair at the same distance', { pennId: 'other-penn', pathId: 'other-33' }],
  ['missing Penn ID', { pennId: 'other-penn' }],
  ['missing PATH ID', { pathId: 'other-33' }],
  ['unserved Penn ID', { pennServed: false }],
  ['unserved PATH ID', { pathServed: false }],
  ['PATH ID belonging to another agency', { pathAgency: 'nice' }],
  ['moved station more than 600 meters away', { pathPoint: { lat: 40.76, lng: -73.98827 } }],
]) test(`no special connector for ${name}`, async () => {
  const network = await fixture(options);
  for (const [id, served] of [['237', options.pennServed], ['26724', options.pathServed]]) {
    if (served !== false) continue;
    const stop = stopIndex(network, id);
    assert.equal(network.stopPatternStart[stop], network.stopPatternStart[stop + 1], 'the named stop is loaded but has no calling pattern');
  }
  if (options.pennId && options.pathId) {
    const from = stopIndex(network, options.pennId), to = stopIndex(network, options.pathId);
    const meters = haversineMeters(network.stopLat[from], network.stopLon[from], network.stopLat[to], network.stopLon[to]);
    assert.ok(meters > 450 && meters < 600, 'the unnamed pair has the same otherwise qualifying distance');
  }
  if (options.pathPoint) assert.ok(haversineMeters(PENN.lat, PENN.lng, options.pathPoint.lat, options.pathPoint.lng) > 600);
  assert.equal(transfer(network, '237', '26724'), undefined);
  assert.equal(transfer(network, '26724', '237'), undefined);
  assert.deepEqual(route(network), []);
});

test('the planner still rejects the connector when the street graph is disconnected', async () => {
  const network = await fixture();
  assert.ok(transfer(network, '237', '26724') > 0, 'a candidate connector must exist before street validation');
  assert.ok(route(network).some((journey) => journey.rides === 2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-penn-path-disconnected-'));
  try {
    const nodes = [BROADWAY, PENN, PATH_33, NEWPORT].map((point) => ({ lat: point.lat, lon: point.lng }));
    writeWalkingTiles(dir, nodes, []);
    setWalkingDataForTests(dir);
    assert.deepEqual(await plan(network), []);
    assert.equal(transfer(network, '237', '26724'), -1, 'checkWalks forbids the impossible walking transfer');
    assert.equal(transfer(network, '26724', '237'), -1);
  } finally {
    setWalkingDataForTests(noWalkingData);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
