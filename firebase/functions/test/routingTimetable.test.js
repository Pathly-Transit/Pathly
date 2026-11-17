const assert = require('node:assert/strict');
const test = require('node:test');

const { NO_DROP_OFF, NO_PICKUP, decodeRoutingTimetable, encodeRoutingTimetable, serviceRunsOn } = require('../lib/routingTimetable');
const { pathAlongShape } = require('../lib/routingTimetableBuild');
const { STOPS, buildTimetable, busFeed, clock, subwayFeed } = require('./helpers/routingFeeds');

const patternOf = (timetable, routeId) => timetable.patterns.findIndex((pattern) => timetable.routes[pattern.route].id === routeId);
const patternStart = (timetable, pattern) => timetable.patterns.slice(0, pattern).reduce((sum, p) => sum + p.stopCount, 0);
const tripStart = (timetable, pattern) => timetable.patterns.slice(0, pattern).reduce((sum, p) => sum + p.tripCount, 0);

test('trips that call at the same stops share a pattern, and trips with the same running times a profile', async () => {
  const timetable = await buildTimetable('subway', subwayFeed());
  const local = timetable.patterns[patternOf(timetable, 'A')];
  assert.equal(local.stopCount, 4);
  assert.equal(local.tripCount, 12);
  assert.equal(local.profileCount, 1, 'every local trip runs 4 minutes between stops');
  const first = tripStart(timetable, patternOf(timetable, 'A'));
  assert.deepEqual([...timetable.tripStart.slice(first, first + 3)], [8 * 3600, 8 * 3600 + 600, 8 * 3600 + 1200], 'sorted by departure');
  assert.equal(timetable.tripIds[first], 'A-08:00:00');
  assert.equal(timetable.headsigns[local.headsign], 'Fourth Av');
  const route = timetable.routes[local.route];
  assert.deepEqual({ type: route.type, color: route.color, textColor: route.textColor, shortName: route.shortName, longName: route.longName }, { type: 1, color: 'FF0000', textColor: 'FFFFFF', shortName: 'A', longName: 'Avenue Local' });
  assert.equal(timetable.agencies[route.agency].name, 'MTA New York City Transit');
});

test("pickup and drop-off rules are kept per stop, and nobody boards at a trip's last stop", async () => {
  const timetable = await buildTimetable('subway', subwayFeed());
  const express = patternOf(timetable, 'X');
  const start = patternStart(timetable, express);
  assert.equal(timetable.patternFlags[start] & NO_DROP_OFF, NO_DROP_OFF, 'board only at A1');
  assert.equal(timetable.patternFlags[start] & NO_PICKUP, 0);
  assert.equal(timetable.patternFlags[start + 1] & NO_PICKUP, NO_PICKUP, 'off only at A4');
  const local = patternStart(timetable, patternOf(timetable, 'A'));
  assert.equal(timetable.patternFlags[local + 3], NO_PICKUP, "the local's last stop");
  assert.equal(timetable.patternFlags[local + 1], 0);
});

test('a trip running past midnight keeps its GTFS time past 24:00', async () => {
  const timetable = await buildTimetable('subway', subwayFeed());
  const night = tripStart(timetable, patternOf(timetable, 'N'));
  assert.equal(timetable.tripStart[night], 24 * 3600 + 30 * 60);
});

test('a trip that would overtake another goes in a pattern of its own', async () => {
  const feed = busFeed();
  // Leaves after the 08:00 bus but reaches East St first.
  feed['trips.txt'] += 'B,WK,B-fast,EAST ST,0\n';
  feed['stop_times.txt'] += 'B-fast,08:01:00,08:01:00,B1,1\nB-fast,08:03:00,08:03:00,B2,2\nB-fast,08:05:00,08:05:00,B3,3\n';
  const timetable = await buildTimetable('nice', feed);
  assert.equal(timetable.patterns.length, 2);
  assert.deepEqual(timetable.patterns.map((pattern) => pattern.tripCount).sort((a, b) => a - b), [1, 8]);
  // Within each pattern, every stop's departures only ever get later.
  let trip = 0;
  let profiles = 0;
  for (const pattern of timetable.patterns) {
    for (let index = 1; index < pattern.tripCount; index += 1) {
      for (let stop = 0; stop < pattern.stopCount; stop += 1) {
        const departure = (t) => timetable.tripStart[t] + timetable.profileDep[(profiles + timetable.tripProfile[t]) * pattern.stopCount + stop];
        assert.ok(departure(trip + index) >= departure(trip + index - 1));
      }
    }
    trip += pattern.tripCount;
    profiles += pattern.profileCount;
  }
});

test('blank times between timed stops are spread evenly', async () => {
  const feed = busFeed();
  feed['stop_times.txt'] = feed['stop_times.txt']
    .replace('B-08:00:00,08:05:00,08:05:00,B2,2', 'B-08:00:00,,,B2,2')
    .replace('B-08:00:00,08:10:00,08:10:00,B3,3', 'B-08:00:00,08:12:00,08:12:00,B3,3');
  const timetable = await buildTimetable('nice', feed);
  assert.equal(timetable.patterns.length, 1);
  assert.equal(timetable.patterns[0].profileCount, 2, 'the trip with the blank time runs slower than the rest');
  const profile = timetable.tripProfile[timetable.tripIds.indexOf('B-08:00:00')];
  assert.deepEqual([...timetable.profileArr.slice(profile * 3, profile * 3 + 3)], [0, 6 * 60, 12 * 60]);
});

test('the line is drawn along its shape, with each stop at its place on it', async () => {
  const timetable = await buildTimetable('subway', subwayFeed());
  const local = patternOf(timetable, 'A');
  const start = patternStart(timetable, local);
  const pathStart = timetable.patterns.slice(0, local).reduce((sum, p) => sum + p.pathPoints, 0);
  const indexes = [...timetable.patternPathIndex.slice(start, start + 4)];
  assert.deepEqual(indexes, [0, 2, 4, 6], 'the bends sit between the stations');
  const point = (index) => [timetable.pathLat[pathStart + index] / 1e6, timetable.pathLon[pathStart + index] / 1e6];
  assert.deepEqual(point(2), STOPS.A2);
  assert.deepEqual(point(1), [40.705, -73.899]);
});

test('pathAlongShape takes a looping line\'s stops in order and refuses a shape that misses them', () => {
  const loop = [
    { lat: 40.70, lon: -73.90 }, { lat: 40.71, lon: -73.90 }, { lat: 40.71, lon: -73.89 }, { lat: 40.70, lon: -73.89 }, { lat: 40.70, lon: -73.8999 },
  ];
  // The first and last stops are a few meters apart; the last must land at the end of the loop.
  const path = pathAlongShape([{ lat: 40.70, lon: -73.90 }, { lat: 40.71, lon: -73.895 }, { lat: 40.70, lon: -73.8999 }], loop);
  assert.ok(path);
  assert.deepEqual(path.stopIndex.map((index) => index > 0), [false, true, true]);
  assert.ok(path.stopIndex[2] > path.stopIndex[1]);
  assert.ok(Math.abs(path.points.at(-1).lon - -73.8999) < 1e-9, 'the last stop is at the end of the loop, not its start');
  assert.equal(pathAlongShape([{ lat: 40.80, lon: -73.90 }, { lat: 40.81, lon: -73.90 }], loop), null);
});

test('station transfers reach each platform, and timed transfers name their trips', async () => {
  const feed = subwayFeed();
  feed['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nS1,First Av,40.70,-73.90,1,\n'
    + feed['stops.txt'].split('\n').slice(1).filter(Boolean).map((line) => (line.startsWith('A1,') ? `${line},0,S1` : `${line},0,`)).join('\n') + '\n';
  feed['transfers.txt'] = 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\nS1,S1,,,2,180\nA4,A4,A-08:00:00,A-08:10:00,1,\nA2,A3,,,3,\n';
  const timetable = await buildTimetable('subway', feed);
  const id = (stopId) => timetable.stopIds.indexOf(stopId);
  assert.deepEqual(timetable.stopTransfers.find(([from, to]) => from === id('A1') && to === id('A1')), [id('A1'), id('A1'), 180]);
  assert.deepEqual(timetable.stopTransfers.find(([from, to]) => from === id('A2') && to === id('A3')), [id('A2'), id('A3'), -1]);
  assert.equal(timetable.stopParent[id('A1')], id('S1'));
  assert.equal(timetable.stopNames[id('S1')], 'First Av');
  const trip = (tripId) => timetable.tripIds.indexOf(tripId);
  assert.deepEqual(timetable.tripTransfers, [[trip('A-08:00:00'), trip('A-08:10:00'), id('A4')]]);
});

test('the file round-trips, and services run on their days and exceptions', async () => {
  const timetable = await buildTimetable('nice', busFeed());
  const again = decodeRoutingTimetable(encodeRoutingTimetable(timetable));
  assert.deepEqual({ ...again, arrays: [] }, { ...timetable, arrays: [] });
  assert.throws(() => decodeRoutingTimetable(require('node:zlib').gzipSync(Buffer.from('nope'))), /not a routing timetable/);
  const service = { id: 'WK', days: 0b0111110, start: 20260101, end: 20271231, added: [20261122], removed: [20261126] };
  assert.equal(serviceRunsOn(service, 20261118, 3), true, 'a Wednesday');
  assert.equal(serviceRunsOn(service, 20261121, 6), false, 'a Saturday');
  assert.equal(serviceRunsOn(service, 20261122, 0), true, 'added on a Sunday');
  assert.equal(serviceRunsOn(service, 20261126, 4), false, 'Thanksgiving removed');
  assert.equal(serviceRunsOn(service, 20280105, 3), false, 'after the calendar ends');
  assert.equal(clock(8 * 60 + 5), '08:05:00');
});
