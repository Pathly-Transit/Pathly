const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parse } = require('csv-parse/sync');
const { strToU8, strFromU8, unzipSync, zipSync } = require('fflate');

const { AGENCY_CONFIGS } = require('../lib/gtfsAgencies');
const { normalizePathStaticArchive } = require('../lib/pathStatic');
const { transformSourceArchive } = require('../lib/gtfsTransforms');
const { assertGtfsServiceIsCurrent, extractGtfsArchive, validateAgencySnapshotContract } = require('../lib/gtfsSnapshots');
const { readAgencyStaticData } = require('../lib/gtfsFeed');

// IDs/positions and the ten direction patterns observed in the operator's 2026-11-19 feed.
const stations = [
  ['26725', '9th Street', 40.73424, -73.9991, ['781735', '781734', 'place_09S']],
  ['26722', '14th Street', 40.73735, -73.99684, ['781737', '781736', 'place_14S']],
  ['26723', '23rd Street', 40.7429, -73.99278, ['781739', '781738', 'place_23S']],
  ['26724', '33rd Street', 40.74912, -73.98827, ['781740', '781742', 'place_33S']],
  ['26726', 'Christopher Street', 40.73295, -74.00707, ['781733', '781732', 'place_CHR']],
  ['26727', 'Exchange Place', 40.71676, -74.03238, ['781731', '781730', 'place_EXP']],
  ['26728', 'Grove Street', 40.71966, -74.04245, ['781727', '781726', 'place_GRV']],
  ['26729', 'Harrison', 40.73942, -74.15587, ['781721', '781720', 'place_HAR']],
  ['26730', 'Hoboken', 40.73586, -74.02922, ['781743', '781744', 'place_HOB']],
  ['26731', 'Journal Square', 40.73301, -74.06289, ['781722', '781723', '781724', '781725', 'place_JSQ']],
  ['26732', 'Newport', 40.72699, -74.03383, ['781728', '781729', 'place_NEW']],
  ['26733', 'Newark', 40.73454, -74.16375, ['781719', '781718', 'place_NWK']],
  ['26734', 'World Trade Center', 40.71271, -74.01193, ['781747', '781750', 'place_WTC']],
];
const patterns = [
  ['RED', '862', 'Newark - World Trade Center', ['781718', '781720', '781722', '781726', '781730', '781750']],
  ['YEL', '861', 'Journal Square - 33rd Street', ['781723', '781726', '781728', '781732', '781734', '781736', '781738', '781740']],
  ['ATW', '1024', 'Journal Square - 33rd Street via Hoboken', ['781723', '781726', '781728', '781743', '781732', '781734', '781736', '781738', '781740']],
  ['BLU', '859', 'Hoboken - 33rd Street', ['781743', '781732', '781734', '781736', '781738', '781742']],
  ['GRE', '860', 'Hoboken - World Trade Center', ['781744', '781729', '781730', '781747']],
];
const csv = (header, rows) => [header, ...rows.map((row) => row.join(',')), ''].join('\n');
function fixture() {
  const trips = [];
  const times = [];
  for (const [code, , name, sequence] of patterns) for (const direction of [0, 1]) {
    const id = `${code}-${direction}`;
    trips.push([code, 'DAILY', id, name, direction, 'same-block', '']);
    for (const [index, stop] of (direction === 0 ? sequence : [...sequence].reverse()).entries()) {
      const time = `25:${String(index * 3).padStart(2, '0')}:00`;
      times.push([id, time, time, stop, 10 + index * 10, '0', index === 0 ? '1' : '0', '1']);
    }
  }
  return {
    'routes.txt': csv('route_id,route_short_name,route_long_name,route_type,route_color', patterns.map(([code, , name]) => [code, code, name, '1', 'FF9900'])),
    'stops.txt': csv('stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station', stations.flatMap(([, name, lat, lon, aliases]) => aliases.map((alias) => [alias, name, lat, lon, '', '']))),
    'trips.txt': csv('route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id', trips),
    'stop_times.txt': csv('trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint', times),
    'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nDAILY,1,1,1,1,1,1,1,20261119,20270101\n',
    'calendar_dates.txt': 'service_id,date,exception_type\nDAILY,20261225,2\n',
  };
}
const archive = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))));
const filesOf = (bytes) => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name, bytes]) => [name, strFromU8(bytes)]));
const rows = (files, name) => parse(files[name], { columns: true, skip_empty_lines: true });
const normalized = (files = fixture()) => filesOf(transformSourceArchive(AGENCY_CONFIGS.path, archive(files)));

test('PATH refresh uses the operator feed while preserving its required legacy fallback identity', () => {
  assert.equal(AGENCY_CONFIGS.path.staticFeedUrl, 'https://www.panynj.gov/content/dam/path/gtfs/PATH_GTFS.zip');
  assert.deepEqual(AGENCY_CONFIGS.path.requiredStaticFallbacks, [{ routeId: '862', stopIds: ['26733'] }]);
});

test('all 41 operator stop aliases become the 13 established live station IDs', () => {
  const output = normalized();
  const stops = rows(output, 'stops.txt').filter((row) => row.location_type !== '2');
  assert.equal(stops.length, 13);
  assert.deepEqual(new Set(stops.map((row) => row.stop_id)), new Set(stations.map(([id]) => id)));
  for (const [id, name, lat, lon] of stations) {
    const stop = stops.find((row) => row.stop_id === id);
    assert.equal(stop.stop_name, name);
    assert.equal(Number(stop.stop_lat), lat);
    assert.equal(Number(stop.stop_lon), lon);
    assert.equal(stop.location_type, '1');
    assert.equal(stop.parent_station, '');
  }
});

test('omitted station entrances retain their spatial metadata without becoming boarding stops', () => {
  const output = normalized();
  const entrances = rows(output, 'stops.txt').filter((row) => row.location_type === '2');
  assert.equal(entrances.length, 22);
  assert.equal(entrances.filter((row) => row.parent_station === '26733').length, 2);
  assert.equal(entrances.filter((row) => row.parent_station === '26730').length, 2);
  assert.deepEqual(entrances.find((row) => row.stop_id === '782490'), { stop_id: '782490', stop_name: 'Newark', stop_lat: '40.7344', stop_lon: '-74.1635', location_type: '2', parent_station: '26733' });
  const entranceIds = new Set(entrances.map((row) => row.stop_id));
  assert.ok(rows(output, 'stop_times.txt').every((row) => !entranceIds.has(row.stop_id)));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-path-entrances-'));
  try {
    for (const [name, contents] of Object.entries(output)) fs.writeFileSync(path.join(directory, name), contents);
    const data = readAgencyStaticData(directory);
    assert.equal(data.stopsById.size, 13);
    assert.equal(data.stopsById.has('782490'), false);
    assert.equal(data.entrancesByStation.get('26733').length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const parent of ['place_NWK', '781718', '26733']) test(`provider entrances supersede only their own station's fallback with parent ${parent}`, () => {
  const input = fixture();
  input['stops.txt'] += `provider-west,West entrance,40.7342,-74.1644,2,${parent}\n`;
  const entrances = rows(normalized(input), 'stops.txt').filter((row) => row.location_type === '2');
  const newark = entrances.filter((row) => row.parent_station === '26733');
  assert.equal(newark.length, 1);
  assert.equal(newark[0].stop_id, 'provider-west');
  assert.equal(newark[0].stop_name, 'West entrance');
  assert.equal(newark[0].stop_lat, '40.7342');
  assert.equal(entrances.some((row) => row.stop_id === '782490' || row.stop_id === '782491'), false);
  assert.equal(entrances.filter((row) => row.parent_station === '26730').length, 2, 'Hoboken still retains both known entrances');
});

test('unknown entrance parents and malformed entrance coordinates reject the update', () => {
  const unknown = fixture();
  unknown['stops.txt'] += 'provider-west,West entrance,40.7342,-74.1644,2,not-a-station\n';
  assert.throws(() => normalized(unknown), /unknown parent_station/);
  for (const latitude of ['', 'NaN', '91']) {
    const input = fixture();
    input['stops.txt'] += `provider-west,West entrance,${latitude},-74.1644,2,place_NWK\n`;
    assert.throws(() => normalized(input), /entrance has invalid coordinates/);
  }
});

test('entrances cannot be referenced as stops in the timetable', () => {
  const provider = fixture();
  provider['stops.txt'] += 'provider-west,West entrance,40.7342,-74.1644,2,place_NWK\n';
  provider['stop_times.txt'] = provider['stop_times.txt'].replace('781718', 'provider-west');
  assert.throws(() => normalized(provider), /stop time references an unknown stop_id/);
  const fallback = fixture();
  fallback['stop_times.txt'] = fallback['stop_times.txt'].replace('781718', '782490');
  assert.throws(() => normalized(fallback), /stop time references an unknown stop_id/);
});

test('each line keeps saved/live route IDs and both directions match the legacy endpoint contract', () => {
  const input = fixture();
  const output = normalized(input);
  const routes = rows(output, 'routes.txt');
  const trips = rows(output, 'trips.txt');
  const times = rows(output, 'stop_times.txt');
  const lookup = new Map(stations.flatMap(([id, name, , , aliases]) => aliases.map((alias) => [alias, { id, name }])));
  for (const [sourceId, expectedId, , sequence] of patterns) {
    const route = routes.find((row) => row.route_id === expectedId);
    assert.equal(route.route_short_name, 'PATH');
    if (sourceId === 'ATW') assert.equal(route.route_long_name, 'Journal Square - 33rd Street (via Hoboken)');
    for (const direction of [0, 1]) {
      const trip = trips.find((row) => row.trip_id === `${sourceId}-${direction}`);
      assert.equal(trip.route_id, expectedId);
      assert.equal(trip.direction_id, String(1 - direction));
      const selected = direction === 0 ? sequence : [...sequence].reverse();
      assert.equal(trip.trip_headsign, lookup.get(selected.at(-1)).name + (sourceId === 'ATW' ? ' via Hoboken' : ''));
      assert.deepEqual(times.filter((row) => row.trip_id === trip.trip_id).map((row) => row.stop_id), selected.map((id) => lookup.get(id).id));
    }
  }
  // Timetable identity/clock/sequence and service calendar are never fabricated or retimed.
  const originalTimes = rows(input, 'stop_times.txt');
  for (const [index, time] of times.entries()) {
    const { stop_id: _oldStop, ...original } = originalTimes[index];
    const { stop_id: _newStop, ...rewritten } = time;
    assert.deepEqual(rewritten, original);
  }
  assert.equal(output['calendar.txt'], input['calendar.txt']);
  assert.equal(output['calendar_dates.txt'], input['calendar_dates.txt']);
});

test('the current official schema passes the same freshness and legacy contract checks as the publisher', () => {
  const source = archive(fixture());
  const unnormalized = extractGtfsArchive(source);
  assert.throws(() => validateAgencySnapshotContract('path', unnormalized, new Date('2026-11-23T15:00:00Z')), /missing required route_id 862/);
  const bytes = transformSourceArchive(AGENCY_CONFIGS.path, source);
  const extracted = extractGtfsArchive(bytes);
  assert.ok(assertGtfsServiceIsCurrent(extracted, new Date('2026-11-23T15:00:00Z')) > 0);
  assert.doesNotThrow(() => validateAgencySnapshotContract('path', extracted, new Date('2026-11-23T15:00:00Z')));
});

test('normalization is deterministic and idempotent; legacy feeds and other agencies are unchanged', () => {
  const source = archive(fixture());
  const once = normalizePathStaticArchive(source);
  assert.deepEqual(normalizePathStaticArchive(source), once);
  assert.equal(normalizePathStaticArchive(once), once);
  const old = archive({ 'routes.txt': 'route_id,route_short_name,route_long_name\n862,PATH,Newark - World Trade Center\n' });
  assert.equal(normalizePathStaticArchive(old), old);
  assert.equal(transformSourceArchive(AGENCY_CONFIGS.lirr, source), source);
});

test('transfers retain station/run specificity after route and station aliasing', () => {
  const input = fixture();
  input['transfers.txt'] = 'from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time\n781727,781726,RED,YEL,RED-1,YEL-0,2,180\n';
  assert.deepEqual(rows(normalized(input), 'transfers.txt'), [{ from_stop_id: '26728', to_stop_id: '26728', from_route_id: '862', to_route_id: '861', from_trip_id: 'RED-1', to_trip_id: 'YEL-0', transfer_type: '2', min_transfer_time: '180' }]);
});

test('the ten exact station/direction patterns retain their verified curved track shapes', () => {
  const output = normalized();
  const shapes = rows(output, 'shapes.txt');
  const trips = rows(output, 'trips.txt');
  assert.equal(new Set(trips.map((trip) => trip.shape_id)).size, 10);
  for (const trip of trips) {
    assert.match(trip.shape_id, /^pathly-track-v1-p_\d+$/);
    const points = shapes.filter((point) => point.shape_id === trip.shape_id);
    assert.ok(points.length > 40, 'the retained line has its actual curves, not only its stations');
    assert.equal(points[0].shape_pt_sequence, '1');
    assert.equal(points.at(-1).shape_pt_sequence, String(points.length));
  }
});

test('a new short-turn/stop pattern does not borrow a whole-line shape', () => {
  const input = fixture();
  input['stop_times.txt'] = csv(Object.keys(rows(input, 'stop_times.txt')[0]).join(','), rows(input, 'stop_times.txt')
    .filter((row) => row.trip_id !== 'RED-0' || row.stop_id !== '781720').map((row) => Object.values(row)));
  const output = normalized(input);
  assert.equal(rows(output, 'trips.txt').find((trip) => trip.trip_id === 'RED-0').shape_id, '');
  assert.match(rows(output, 'trips.txt').find((trip) => trip.trip_id === 'RED-1').shape_id, /^pathly-track-v1-/);
});

test('operator-supplied shapes take precedence without rewriting their points or shape IDs', () => {
  const input = fixture();
  input['shapes.txt'] = 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nprovider-main,40.73454,-74.16375,1\nprovider-main,40.71271,-74.01193,2\n';
  input['trips.txt'] = input['trips.txt'].replace('0,same-block,\n', '0,same-block,provider-main\n');
  const output = normalized(input);
  assert.equal(output['shapes.txt'], input['shapes.txt']);
  assert.equal(rows(output, 'trips.txt').find((trip) => trip.trip_id === 'RED-0').shape_id, 'provider-main');
  assert.ok(rows(output, 'trips.txt').every((trip) => !trip.shape_id.startsWith('pathly-track-')));
});

test('unrecognized or mixed route IDs cannot silently select a different live line', () => {
  const input = fixture();
  input['routes.txt'] += 'constructor,X,Unknown,1,FF0000\n';
  assert.throws(() => normalized(input), /unrecognized or mixed route_id/);
});

test('unknown stop aliases, changed station identities, and reversed source direction contracts are rejected', () => {
  const unknown = fixture();
  unknown['stop_times.txt'] = unknown['stop_times.txt'].replace('781718', 'unknown');
  assert.throws(() => normalized(unknown), /unknown stop_id/);
  const moved = fixture();
  moved['stops.txt'] = moved['stops.txt'].replace('40.73424', '41.73424');
  assert.throws(() => normalized(moved), /no longer identifies/);
  const wrongDirection = fixture();
  wrongDirection['trips.txt'] = wrongDirection['trips.txt'].replace('Newark - World Trade Center,0,', 'Newark - World Trade Center,1,');
  assert.throws(() => normalized(wrongDirection), /station order disagrees/);
});
