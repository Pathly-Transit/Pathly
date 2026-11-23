const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { haversineMeters } = require('../lib/geo');
const { TransitNetwork } = require('../lib/transitNetwork');
const { TransitRouter } = require('../lib/transitRouter');
const { planTransitTrip, resetTripPlannerForTests, serviceDaysAround, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { scheduleVersionForTimetable } = require('../lib/tripRunSchedule');
const walking = require('../lib/walkingGraph');
const { writeWalkingTiles } = require('../lib/walkingTilesBuild');
const { buildTimetable, stopIndex } = require('./helpers/routingFeeds');

const PENN = { lat: 40.75058844, lng: -73.99358408 };
const PATH_33 = { lat: 40.74912, lng: -73.98827 };
const BROADWAY = { lat: 40.76165318, lng: -73.80176612 };
const NEWPORT = { lat: 40.72699, lng: -74.03383 };
const mondayAt = (hour, minute = 0, second = 0) => Date.UTC(2026, 10, 23, hour + 5, minute, second);
const CALENDAR = 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261123,20261123\n';
const ALL_MODES = new Set(['rail', 'subway', 'bus']);
const rides = (itinerary) => itinerary.steps.filter((step) => step.kind === 'transit');
const twoRides = (itineraries) => itineraries.find((itinerary) => rides(itinerary).length === 2);
const eastOf = (point, meters) => ({ lat: point.lat, lng: point.lng + meters / (6_371_000 * Math.cos(point.lat * Math.PI / 180)) * 180 / Math.PI });
const close = (a, b) => Math.abs(a - b) < 0.000002;
let noWalkingData;
test.before(() => {
  noWalkingData = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-transfer-no-walking-'));
  walking.setWalkingDataForTests(noWalkingData);
});
test.afterEach(() => {
  resetTripPlannerForTests();
  walking.setWalkingDataForTests(noWalkingData);
});
test.after(() => {
  walking.setWalkingDataForTests(null);
  fs.rmSync(noWalkingData, { recursive: true, force: true });
});

const csv = (header, rows) => [header, ...rows.map((row) => row.join(',')), ''].join('\n');
async function fixture({ leftId = 'A', rightId = 'B', firstAgency = 'metronorth', secondAgency = 'nice', leftPoint = PENN, rightPoint = PATH_33,
  leftServed = true, rightServed = true, sameAgency = false, sameStop = false, throughRide = false, held = false, transfers, nextDeparture = '08:35:00', laterDeparture, branches = 1 } = {}) {
  if (sameAgency) secondAgency = firstAgency;
  if (sameStop) { rightId = leftId; rightPoint = leftPoint; }
  const servedLeft = leftServed ? leftId : 'left-platform';
  const servedRight = rightServed ? rightId : 'right-platform';
  const feed = (agency, routeRows, stops, trips, times) => ({
    'agency.txt': `agency_id,agency_name,agency_url\n${agency},${agency},https://example.com\n`,
    'routes.txt': csv('route_id,agency_id,route_short_name,route_long_name,route_type', routeRows.map(([id, type]) => [id, agency, id, id, type])),
    'stops.txt': csv('stop_id,stop_name,stop_lat,stop_lon,parent_station', stops.map(([id, name, point, parent = '']) => [id, name, point.lat, point.lng, parent])),
    'trips.txt': csv('route_id,service_id,trip_id,direction_id', trips.map(([route, id, direction]) => [route, 'WK', id, direction])),
    'stop_times.txt': csv('trip_id,arrival_time,departure_time,stop_id,stop_sequence', times.map(([trip, at, stop, sequence]) => [trip, at, at, stop, sequence])),
    'calendar.txt': CALENDAR,
  });
  const first = feed(firstAgency, [['L', 2]], [['OUT1', 'Broadway', BROADWAY], [leftId, 'Transfer A', leftPoint], ...(!leftServed ? [[servedLeft, 'Platform A', leftPoint, leftId]] : [])],
    [['L', 'first-in', 0], ['L', 'first-out', 1]], [
      ['first-in', '08:00:00', 'OUT1', 10], ['first-in', '08:20:00', servedLeft, 20],
      ...(throughRide ? [['first-in', '08:45:00', 'OUT2', 30]] : []),
      ['first-out', '09:30:00', servedLeft, 10], ['first-out', '09:50:00', 'OUT1', 20],
    ]);
  const routeRows = [], stops = [[rightId, 'Transfer B', rightPoint], ['OUT2', 'Newport', NEWPORT], ...(!rightServed ? [[servedRight, 'Platform B', rightPoint, rightId]] : [])], trips = [], times = [];
  for (let branch = 0; branch < branches; branch += 1) {
    const route = branch === 0 ? 'P' : `P${branch}`;
    const board = branch === 0 ? servedRight : `${servedRight}${branch}`;
    if (branch > 0) stops.push([board, `Transfer B${branch}`, eastOf(rightPoint, branch / 10)]);
    routeRows.push([route, 1]);
    trips.push([route, `second-out-${branch}`, 0], [route, `second-in-${branch}`, 1]);
    times.push([`second-out-${branch}`, nextDeparture, board, 10], [`second-out-${branch}`, '08:50:00', 'OUT2', 20],
      [`second-in-${branch}`, '09:00:00', 'OUT2', 10], [`second-in-${branch}`, '09:15:00', board, 20]);
  }
  if (laterDeparture) {
    trips.push(['P', 'second-later', 0]);
    times.push(['second-later', laterDeparture, servedRight, 10], ['second-later', '08:55:00', 'OUT2', 20]);
  }
  const second = feed(secondAgency, routeRows, stops, trips, times);
  let parts;
  if (sameAgency) {
    for (const filename of ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt']) first[filename] += second[filename].split('\n').slice(1).join('\n');
    const stopRows = first['stops.txt'].trimEnd().split('\n');
    const stopIds = new Set();
    first['stops.txt'] = [stopRows[0], ...stopRows.slice(1).filter((row) => { const id = row.split(',')[0]; if (stopIds.has(id)) return false; stopIds.add(id); return true; }), ''].join('\n');
    if (transfers || held) first['transfers.txt'] = held
      ? `from_stop_id,to_stop_id,transfer_type,min_transfer_time,from_trip_id,to_trip_id\n${(transfers ?? '').trimEnd().split('\n').filter(Boolean).map((row) => row + ',,').join('\n')}\n${servedLeft},${servedRight},1,,first-in,second-out-0\n`
      : `from_stop_id,to_stop_id,transfer_type,min_transfer_time\n${transfers}`;
    parts = [{ agencyId: firstAgency, version: 'walking-test', timetable: await buildTimetable(firstAgency, first) }];
  } else {
    const tables = await Promise.all([buildTimetable(firstAgency, first), buildTimetable(secondAgency, second)]);
    parts = [{ agencyId: firstAgency, version: 'walking-test', timetable: tables[0] }, { agencyId: secondAgency, version: 'walking-test', timetable: tables[1] }];
  }
  const network = new TransitNetwork(parts);
  setTransitNetworkForTests(network); // Install once: successive plans must reuse the physical cache.
  const incomingRun = { version: 1, agencyId: firstAgency, routeId: 'L', tripId: 'first-in', serviceDate: '20261123',
    scheduleVersion: scheduleVersionForTimetable(parts[0].timetable), startTime: '08:00:00', boardStopId: 'OUT1', alightStopId: servedLeft,
    boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 10, alightStopSequence: 20, directionId: 0 };
  const plan = ({ reverse = false, arriveBy = false, lessWalking = false, incoming = false, recovery = false, startAtTransfer = false, at } = {}) => {
    const origin = incoming || startAtTransfer ? leftPoint : reverse ? NEWPORT : BROADWAY;
    const destination = reverse ? BROADWAY : NEWPORT;
    const now = at ?? (incoming ? mondayAt(8, 20) : arriveBy ? mondayAt(reverse ? 10 : 9) : mondayAt(reverse ? 8 : 7, 55));
    return planTransitTrip({ request: { origin: { ...origin, label: 'Origin' }, destination: { ...destination, label: 'Destination' },
      time: { mode: arriveBy ? 'arrive' : 'depart', at: new Date(now).toISOString() }, preference: 'fastest', modes: ['rail', 'subway', 'bus'], ferry: false, lessWalking,
      ...((incoming || recovery) ? { recovery: { excludedRuns: [], ...(incoming ? { incomingRun } : {}) } } : {}) },
    origin, destination, nowMs: now, recoveryFeedLookup: async () => [] });
  };
  return { network, plan, leftPoint, rightPoint, leftId, rightId };
}

function measuredGraph(t, f, meters, { disconnected = false } = {}) {
  const measured = [];
  t.mock.method(walking, 'hasWalkingData', () => true);
  t.mock.method(walking, 'walkingMeters', (a, b, c, d, limit) => {
    const distance = haversineMeters(a, b, c, d);
    return distance <= limit ? distance : null;
  });
  const transferPair = (a, b, c, d) => (close(a, f.leftPoint.lat) && close(b, f.leftPoint.lng) && close(c, f.rightPoint.lat) && close(d, f.rightPoint.lng))
    || (close(c, f.leftPoint.lat) && close(d, f.leftPoint.lng) && close(a, f.rightPoint.lat) && close(b, f.rightPoint.lng));
  t.mock.method(walking, 'walkingPath', (a, b, c, d, limit) => {
    const pair = transferPair(a, b, c, d);
    if (pair) measured.push({ limit });
    const distance = pair ? meters : haversineMeters(a, b, c, d);
    if ((pair && disconnected) || distance > limit) return null;
    return { meters: distance, path: [{ lat: a, lon: b }, { lat: c, lon: d }] };
  });
  return measured;
}

for (const [firstAgency, secondAgency] of [['metronorth', 'nice'], ['subway', 'busco'], ['lirr', 'path']]) {
  test(`ordinary 476m transfer needs no named station or agency exception: ${firstAgency}→${secondAgency}`, async () => {
    const f = await fixture({ firstAgency, secondAgency });
    const straight = haversineMeters(PENN.lat, PENN.lng, PATH_33.lat, PATH_33.lng);
    assert.ok(straight > 450 && straight < 500);
    assert.ok(twoRides(await f.plan()), 'arbitrary A/B IDs must connect within the normal walking budget');
  });
}

test('the Broadway–Penn–33rd Street–Newport example still works with its actual station IDs', async () => {
  const f = await fixture({ leftId: '237', rightId: '26724', firstAgency: 'lirr', secondAgency: 'path' });
  assert.deepEqual(rides(twoRides(await f.plan())).map((step) => step.liveRoute.agencyId), ['lirr', 'path']);
});

for (const reverse of [false, true]) for (const arriveBy of [false, true]) test(`generic transfer ${reverse ? 'reverse' : 'forward'}, ${arriveBy ? 'arrive by' : 'depart at'}`, async () => {
  const f = await fixture();
  assert.ok(twoRides(await f.plan({ reverse, arriveBy })));
});

for (const [lessWalking, meters, accepted] of [[false, 780, true], [false, 781, false], [true, 390, true], [true, 391, false]]) {
  test(`${lessWalking ? 'less' : 'normal'} walking accepts its exact physical distance boundary and rejects over it: ${meters}m`, async (t) => {
    const f = await fixture({ rightPoint: eastOf(PENN, 300) });
    measuredGraph(t, f, meters);
    const result = await f.plan({ lessWalking });
    assert.equal(Boolean(twoRides(result)), accepted);
    if (accepted) assert.ok(twoRides(result).steps.some((step) => step.kind === 'walk' && step.distanceMeters === meters));
  });
}

test('a measured walk crossing the less-walking limit by less than 45 seconds is still rejected', async (t) => {
  const f = await fixture({ rightPoint: eastOf(PENN, 389) });
  measuredGraph(t, f, 391);
  assert.deepEqual(await f.plan({ lessWalking: true }), []);
});

test('the lower bound keeps a tight connection that the conservative detour estimate would miss', async (t) => {
  const f = await fixture({ nextDeparture: '08:29:10' });
  measuredGraph(t, f, 583);
  const itinerary = twoRides(await f.plan());
  assert.ok(itinerary);
  assert.equal(rides(itinerary)[1].tripId, 'second-out-0');
  const walk = itinerary.steps.find((step) => step.kind === 'walk' && step.distanceMeters === 583);
  assert.ok(walk && walk.durationSeconds <= 550);
});

test('measuring a longer street walk misses the early connection and selects the later departure', async (t) => {
  const f = await fixture({ nextDeparture: '08:30:00', laterDeparture: '08:40:00' });
  measuredGraph(t, f, 700);
  const itinerary = twoRides(await f.plan());
  assert.ok(itinerary);
  assert.equal(rides(itinerary)[1].tripId, 'second-later');
  assert.ok(itinerary.steps.some((step) => step.kind === 'walk' && step.distanceMeters === 700));
  assert.deepEqual(await f.plan({ arriveBy: true, at: mondayAt(8, 53) }), []);
});

for (const order of [[false, true, false], [true, false, true], [true, false, false, true]]) test(`walking preferences do not poison a shared physical cache: ${order.join('→')}`, async (t) => {
  const f = await fixture({ rightPoint: eastOf(PENN, 300) });
  measuredGraph(t, f, 500);
  for (const lessWalking of order) assert.equal(Boolean(twoRides(await f.plan({ lessWalking }))), !lessWalking);
});

test('simultaneous mixed preferences retain independent results on the shared network', async (t) => {
  const f = await fixture({ rightPoint: eastOf(PENN, 300) });
  measuredGraph(t, f, 500);
  const preferences = [false, true, false, true];
  const results = await Promise.all(preferences.map((lessWalking) => f.plan({ lessWalking })));
  assert.deepEqual(results.map((plans) => Boolean(twoRides(plans))), preferences.map((less) => !less));
});

test('normal and incoming recovery obey the same physical transfer budget', async (t) => {
  const f = await fixture({ rightPoint: eastOf(PENN, 300) });
  measuredGraph(t, f, 500);
  assert.ok(twoRides(await f.plan({ recovery: true })));
  assert.deepEqual(await f.plan({ recovery: true, lessWalking: true }), []);
  const incoming = await f.plan({ incoming: true });
  assert.ok(incoming.some((itinerary) => rides(itinerary).length === 1));
  assert.deepEqual(await f.plan({ incoming: true, lessWalking: true }), []);
});

for (const arriveBy of [false, true]) test(`directed published prohibition wins in ${arriveBy ? 'backward' : 'forward'} search`, async () => {
  const f = await fixture({ sameAgency: true, transfers: 'A,B,3,\nB,A,2,900\n' });
  assert.deepEqual(await f.plan({ arriveBy }), []);
  const reverse = twoRides(await f.plan({ reverse: true, arriveBy }));
  assert.ok(reverse, 'the permitted reverse direction remains available');
  const transfer = reverse.steps.find((step) => step.kind === 'walk' && step.toName === 'Transfer A');
  assert.ok(transfer && transfer.durationSeconds >= 900, 'the published 900 second minimum is not reduced to geometric walking');
});

test('missing or unserved station IDs do not become magic transfer endpoints', async () => {
  const f = await fixture({ leftServed: false, rightServed: false });
  for (const id of ['A', 'B']) {
    const stop = stopIndex(f.network, id);
    assert.equal(f.network.stopPatternStart[stop], f.network.stopPatternStart[stop + 1]);
  }
  // Their actually served platforms remain ordinary valid endpoints; the parent IDs alone
  // must not be required for the transfer to work.
  assert.ok(twoRides(await f.plan()));
});

test('stops beyond 780 meters cannot enter a normal walking-transfer candidate set', async () => {
  const f = await fixture({ rightPoint: eastOf(PENN, 800) });
  assert.deepEqual(await f.plan(), []);
});

test('without a street graph the detour estimate remains conservative and budgeted', async () => {
  const f = await fixture({ rightPoint: eastOf(PENN, 650) });
  assert.deepEqual(await f.plan(), [], '650m straight becomes 845m estimated walking, beyond 780m');
});

test('an existing street graph that cannot connect the stops rejects the transfer', async () => {
  const f = await fixture();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-transfer-disconnected-'));
  try {
    writeWalkingTiles(dir, [BROADWAY, PENN, PATH_33, NEWPORT].map((point) => ({ lat: point.lat, lon: point.lng })), []);
    walking.setWalkingDataForTests(dir);
    assert.deepEqual(await f.plan(), []);
  } finally {
    walking.setWalkingDataForTests(noWalkingData);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const arriveBy of [false, true]) test(`raw router uses generic budgeted transfers in ${arriveBy ? 'backward' : 'forward'} search`, async () => {
  const f = await fixture();
  const at = arriveBy ? mondayAt(9) : mondayAt(7, 55);
  const { baseStartMs, days } = serviceDaysAround(at);
  const router = new TransitRouter(f.network, 3);
  const journeys = router[arriveBy ? 'backward' : 'forward'](Math.round((at - baseStartMs) / 1000),
    [{ stop: stopIndex(f.network, 'OUT1'), seconds: 0 }], [{ stop: stopIndex(f.network, 'OUT2'), seconds: 0 }],
    { days, maxRounds: 3, modes: ALL_MODES, horizonSeconds: 3 * 3600 }, f.network.activeServices(days));
  assert.ok(journeys.some((journey) => journey.rides === 2));
});

test('the first incoming-recovery search validates its uncached walking seed before accepting it', async (t) => {
  const f = await fixture({ rightPoint: eastOf(PENN, 300) });
  const measured = measuredGraph(t, f, 500);
  assert.deepEqual(await f.plan({ incoming: true, lessWalking: true }), []);
  assert.ok(measured.length > 0, 'the initially plausible 300m seed must be measured');
  assert.ok((await f.plan({ incoming: true })).some((itinerary) => rides(itinerary).length === 1), 'the less-walking rejection must not poison the normal request');
});

test('exhausting bounded street validation never emits an unchecked alternative', async (t) => {
  const f = await fixture({ branches: 160 });
  let checks = 0;
  t.mock.method(walking, 'hasWalkingData', () => true);
  t.mock.method(walking, 'walkingMeters', (a, b, c, d, limit) => {
    const meters = haversineMeters(a, b, c, d);
    return meters <= limit ? meters : null;
  });
  t.mock.method(walking, 'walkingPath', (a, b, c, d, limit) => {
    const left = close(a, PENN.lat) && close(b, PENN.lng);
    const right = haversineMeters(c, d, PATH_33.lat, PATH_33.lng) < 30;
    if (left && right) { checks += 1; return null; }
    const meters = haversineMeters(a, b, c, d);
    return meters <= limit ? { meters, path: [{ lat: a, lon: b }, { lat: c, lon: d }] } : null;
  });
  assert.deepEqual(await f.plan(), [], 'all potential transfers are physically disconnected, including alternatives beyond the validation work limit');
  assert.ok(checks > 0 && checks <= 128, `physical checks stay bounded: ${checks}`);
});

for (const arriveBy of [false, true]) test(`a same-stop published prohibition blocks changing vehicles ${arriveBy ? 'arrive by' : 'depart at'}`, async () => {
  const f = await fixture({ sameAgency: true, sameStop: true, transfers: 'A,A,3,\n' });
  assert.deepEqual(await f.plan({ arriveBy }), []);
});

test('a same-stop transfer prohibition does not prevent initial boarding from the street', async () => {
  const f = await fixture({ sameAgency: true, sameStop: true, transfers: 'A,A,3,\n' });
  const plans = await f.plan({ startAtTransfer: true, at: mondayAt(8, 25) });
  assert.ok(plans.some((itinerary) => rides(itinerary).length === 1 && rides(itinerary)[0].tripId === 'second-out-0'));
});

test('a same-stop transfer prohibition does not make an already boarded rider change vehicles', async () => {
  const f = await fixture({ sameAgency: true, sameStop: true, throughRide: true, transfers: 'A,A,3,\n' });
  const plans = await f.plan();
  assert.ok(plans.some((itinerary) => rides(itinerary).length === 1 && rides(itinerary)[0].tripId === 'first-in'));
});

test('a trip-specific guaranteed forward connection still overrides the general same-stop restriction', async () => {
  const f = await fixture({ sameAgency: true, sameStop: true, held: true, transfers: 'A,A,3,\n' });
  assert.ok(twoRides(await f.plan()));
});
