const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { strToU8, unzipSync, zipSync, strFromU8 } = require('fflate');
const { transit_realtime } = require('gtfs-realtime-bindings');

const { collectBackendStatus } = require('../lib/backendStatus');
const { AGENCY_CONFIGS } = require('../lib/gtfsAgencies');
const { findNearbyTransit, LINE_INDEX_FORMAT, listLines, searchRoutes } = require('../lib/gtfsDiscovery');
const { getStopPredictions } = require('../lib/gtfsSchedule');
const { getRouteStatus } = require('../lib/gtfsStatus');
const { collapsePlatformsToStations, transformSourceArchive } = require('../lib/gtfsTransforms');
const { pathLineCode } = require('../lib/pathLines');
const { displayRouteColor } = require('../lib/routeColors');
const { isInServiceArea } = require('../lib/serviceArea');
const { searchStops } = require('../lib/stopSearch');
const { agencyIdsForStep, modeForAgency } = require('../lib/tripAgencies');
const { modeForRoute } = require('../lib/transitNetwork');

const HOBOKEN = { lat: 40.7359, lng: -74.0292 };
const originalFetch = global.fetch;

test.afterEach(() => {
  global.fetch = originalFetch;
});

const zip = (files) => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const unzipText = (archive) => Object.fromEntries(Object.entries(unzipSync(archive)).map(([name, data]) => [name, strFromU8(data)]));

// ---------------------------------------------------------------------------------------------
// The agency and the service area

test('PATH is a configured agency with a public live feed', () => {
  assert.equal(AGENCY_CONFIGS.path.id, 'path');
  assert.equal(AGENCY_CONFIGS.path.liveFeedSecret, undefined);
  // A new agency's lines reach the saved line list only with a new format.
  assert.ok(LINE_INDEX_FORMAT >= 3);
});

test('a deploy needs no NJ Transit secrets', () => {
  const index = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
  assert.doesNotMatch(index, /NJT_/);
  for (const config of Object.values(AGENCY_CONFIGS)) assert.ok(!String(config.liveFeedSecret ?? '').startsWith('NJT_'), config.id);
});

test('the service area takes in New Jersey, from Cape May and Philadelphia to Port Jervis', () => {
  assert.ok(isInServiceArea(HOBOKEN.lat, HOBOKEN.lng), 'Hoboken');
  assert.ok(isInServiceArea(40.7347, -74.1644), 'Newark Penn');
  assert.ok(isInServiceArea(38.9351, -74.906), 'Cape May');
  assert.ok(isInServiceArea(41.3751, -74.6941), 'Port Jervis');
  assert.ok(!isInServiceArea(39.29, -76.61), 'Baltimore is still outside');
});

// ---------------------------------------------------------------------------------------------
// Feed changes before publishing

test('PATH platforms become their stations, in stop times and stops, keeping entrances', () => {
  const archive = zip({
    'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n26733,Newark,40.73,-74.16,1,\n781718,Newark,40.73,-74.16,0,26733\n4249031,Entrance,40.73,-74.16,2,26733\n26734,World Trade Center,40.71,-74.01,1,\n781760,World Trade Center,40.71,-74.01,0,26734\n',
    'stop_times.txt': 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT1,07:20:00,07:20:00,781718,1\nT1,07:42:00,07:42:00,781760,2\n',
    'trips.txt': 'route_id,service_id,trip_id\n862,WK,T1\n',
  });
  const files = unzipText(collapsePlatformsToStations(archive));
  assert.match(files['stop_times.txt'], /T1,07:20:00,07:20:00,26733,1/);
  assert.match(files['stop_times.txt'], /T1,07:42:00,07:42:00,26734,2/);
  // Platforms go; stations and their entrances stay.
  assert.deepEqual(files['stops.txt'].trim().split('\n').slice(1).map((line) => line.split(',')[0]), ['26733', '4249031', '26734']);
  assert.equal(files['trips.txt'], 'route_id,service_id,trip_id\n862,WK,T1\n');

  const transformed = unzipText(transformSourceArchive(AGENCY_CONFIGS.path, Buffer.from(archive)));
  assert.match(transformed['stop_times.txt'], /,26733,/);
  // An agency without changes gets its archive back as it came.
  const untouched = Buffer.from(archive);
  assert.equal(transformSourceArchive(AGENCY_CONFIGS.lirr, untouched), untouched);
});

test('the committed PATH copy names stations, matching PATH\'s live feed', () => {
  const stops = fs.readFileSync(path.join(__dirname, '../static_data/path/stops.txt'), 'utf8');
  assert.ok(!/^781718,/m.test(stops), 'platform stops were replaced by their stations');
  const stopTimes = fs.readFileSync(path.join(__dirname, '../static_data/path/stop_times.txt'), 'utf8').slice(0, 20_000);
  assert.match(stopTimes, /,26733,/);
});

// ---------------------------------------------------------------------------------------------
// Search, nearby and line lists

test('searching Hoboken finds the PATH station', async () => {
  const results = await searchStops('hoboken', HOBOKEN);
  const station = results.find((stop) => stop.id === 'path:26730');
  assert.ok(station, 'PATH Hoboken');
  assert.equal(station.agencyLabel, 'PATH');
  assert.equal(station.mode, 'subway');
});

test('"PATH" finds its lines, and nearby at Hoboken lists PATH first', async () => {
  const pathLines = await searchRoutes('PATH', HOBOKEN.lat, HOBOKEN.lng);
  assert.ok(pathLines.length >= 4 && pathLines.every((route) => route.agencyId === 'path'));
  const routes = await findNearbyTransit(HOBOKEN.lat, HOBOKEN.lng);
  assert.equal(routes[0].agencyId, 'path');
});

test('PATH\'s lines are named by their codes, from route_long_name', () => {
  assert.equal(pathLineCode('Newark - World Trade Center'), 'NWK-WTC');
  assert.equal(pathLineCode('Hoboken - 33rd Street'), 'HOB-33');
  assert.equal(pathLineCode('Journal Square - 33rd Street'), 'JSQ-33');
  assert.equal(pathLineCode('Hoboken - World Trade Center'), 'HOB-WTC');
  assert.equal(pathLineCode('Journal Square - 33rd Street (via Hoboken)'), 'JSQ-HOB-33');
  assert.equal(pathLineCode('Newark - Harrison Shuttle Train'), 'NWK-HAR');
  assert.equal(pathLineCode('World Trade Center - 33rd Street'), 'WTC-33');
  assert.equal(pathLineCode('Somewhere - Elsewhere'), null);
  // A new format so a saved list naming every line "PATH" isn't served.
  assert.ok(LINE_INDEX_FORMAT >= 4);
});

test('the line list, search and stops name PATH\'s lines by code', async () => {
  const pathLines = listLines().filter((line) => line.agencyId === 'path');
  assert.deepEqual(new Set(pathLines.map((line) => line.shortName)), new Set(['HOB-33', 'HOB-WTC', 'NWK-WTC', 'JSQ-33', 'JSQ-HOB-33', 'NWK-HAR', 'WTC-33']));
  assert.equal(pathLines.find((line) => line.routeId === '862').routeName, 'Newark - World Trade Center');
  const found = await searchRoutes('JSQ-33', HOBOKEN.lat, HOBOKEN.lng);
  assert.equal(found[0].routeId, '861');
  const stops = await searchStops('hoboken', HOBOKEN);
  const hoboken = stops.find((stop) => stop.id === 'path:26730');
  assert.ok(hoboken.routes.every((route) => route.shortName !== 'PATH'), 'no line is just "PATH"');
  assert.ok(hoboken.routes.some((route) => route.shortName === 'HOB-33'));
});

test('the line list has PATH\'s lines in their own colors', () => {
  const lines = listLines();
  assert.ok(lines.filter((line) => line.agencyId === 'path').length >= 4);
  assert.equal(displayRouteColor('path', { routeId: '862', color: 'd93a30' }), '#D93A30');
});

// ---------------------------------------------------------------------------------------------
// PATH live arrivals

function pathFeed(arrivals) {
  return transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp: Math.floor(Date.now() / 1000) },
    entity: arrivals.map(({ id, routeId, directionId, stopId, inSeconds }) => ({
      id,
      tripUpdate: { trip: { tripId: id, routeId, directionId }, stopTimeUpdate: [{ stopId, arrival: { time: Math.floor(Date.now() / 1000) + inSeconds } }] },
    })),
  }).finish();
}

test('PATH\'s live arrivals land on the station a rider looks at', async () => {
  global.fetch = async (url) => {
    assert.equal(String(url), 'https://path.transitdata.nyc/gtfsrt');
    return new Response(pathFeed([
      { id: 'a1', routeId: '862', directionId: 1, stopId: '26733', inSeconds: 240 },
      { id: 'a2', routeId: '862', directionId: 0, stopId: '26733', inSeconds: 600 },
      { id: 'other-line', routeId: '859', directionId: 1, stopId: '26730', inSeconds: 120 },
      { id: 'to-hob', routeId: '860', directionId: 0, stopId: '26734', inSeconds: 180 },
    ]));
  };
  const status = await getRouteStatus('path', '862');
  assert.deepEqual(status.trips.map((trip) => trip.tripId), ['a1', 'a2']);
  // Newark: the station's stop_id serves both directions, told apart by direction_id.
  const predictions = await getStopPredictions('path', '862', '26733', '26733', status.trips);
  assert.equal(predictions.towardDirection1[0].live, true);
  assert.equal(predictions.towardDirection1[0].minutes, 4);
  assert.equal(predictions.towardDirection0[0].live, true);
  assert.equal(predictions.towardDirection0[0].minutes, 10);

  // PATH's feed lists each train at one station only, so at World Trade Center a Hoboken-bound
  // train's last listed stop is World Trade Center: that isn't where it's going.
  const hobWtc = await getRouteStatus('path', '860');
  const atWtc = await getStopPredictions('path', '860', '26734', '26734', hobWtc.trips);
  assert.equal(atWtc.towardDirection0[0].live, true);
  assert.equal(atWtc.towardDirection0[0].headsign, null);
});

test('PATH\'s public live feed is probed by the backend status', async () => {
  const published = async () => ({ state: 'published', version: 'abc', publishedAt: '2026-10-14T00:00:00Z', serviceEndDate: '20261231', hasDerived: true });
  const agencies = await collectBackendStatus({ readSnapshot: published, readLastRefresh: async () => null, fetch: async () => new Response('feed'), nowMs: Date.now() });
  const live = agencies.find((agency) => agency.agencyId === 'path').live;
  assert.equal(live.configured, true);
  assert.equal(live.ok, true);
});

// ---------------------------------------------------------------------------------------------
// Trip planning

test('Google\'s PATH legs map to PATH and ride with the subway', () => {
  const step = (agency, mode, line) => ({ agency: { name: agency }, mode, line: { name: line } });
  assert.deepEqual(agencyIdsForStep(step('PATH', 'subway', 'NWK-WTC')), ['path']);
  assert.deepEqual(agencyIdsForStep(step('Port Authority Trans-Hudson', 'rail', 'HOB-33')), ['path']);
  // NJ Transit isn't a Pathly agency: its legs keep Google's details.
  assert.deepEqual(agencyIdsForStep(step('NJ Transit', 'rail', 'Northeast Corridor')), []);
  assert.equal(modeForAgency(step('PATH', 'rail', 'HOB-WTC')), 'subway');
  assert.equal(modeForAgency(step('Long Island Rail Road', 'rail', 'Babylon Branch')), 'rail');
});

test('a planned New Jersey trip files PATH as subway', () => {
  // PATH's feed calls its lines rail (route_type 2); Pathly's planner rides them as the subway.
  assert.equal(modeForRoute('path', 2), 'subway');
  assert.equal(modeForRoute('lirr', 2), 'rail');
  assert.equal(modeForRoute('subway', 1), 'subway');
});
