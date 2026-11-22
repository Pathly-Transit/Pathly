const assert = require('node:assert/strict');
const test = require('node:test');
const { recoveryNetwork } = require('../lib/tripRecoveryNetwork');
const { TransitNetwork } = require('../lib/transitNetwork');
const { TransitRouter } = require('../lib/transitRouter');
const { planTransitTrip, recoveryCoverageFor, resetTripPlannerForTests, serviceDaysAround, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { scheduleVersionForTimetable } = require('../lib/tripRunSchedule');
const { buildTestNetwork, buildTimetable, busFeed, stopIndex, wednesdayAt } = require('./helpers/routingFeeds');

let table;
let base;
const now = wednesdayAt(8, 5);
const days = serviceDaysAround(now);
const route = { agencyId: 'nice', routeId: 'B' };
test.before(async () => { table = await buildTimetable('nice', busFeed()); base = new TransitNetwork([{ agencyId: 'nice', version: 'test', timetable: table }]); });
test.afterEach(() => resetTripPlannerForTests());
const update = (id, times, extra = {}) => ({ tripUpdate: {
  trip: { tripId: `B-${id}:00`, routeId: 'B', startDate: '20261118', startTime: `${id}:00`, directionId: 0 },
  timestamp: now / 1000,
  stopTimeUpdate: times.map((minute, index) => ({ stopId: `B${index + 1}`, stopSequence: index + 1, arrival: { time: wednesdayAt(8, minute) / 1000 }, departure: { time: wednesdayAt(8, minute) / 1000 } })),
  ...extra,
} });
const feed = (entities, at = now) => ({ entities, fetchedAt: now, observedAt: at, differential: false });
async function recoveryFixture(trips) {
  const files = busFeed();
  files['routes.txt'] = 'route_id,agency_id,route_short_name,route_long_name,route_type\nA,LIBUS,A,Preferred,3\nB,LIBUS,B,Connection,3\nX,LIBUS,X,Alternative,3\n';
  files['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon\nO,Origin,40.70,-73.90\nP,Transfer west,40.74,-73.90\nQ,Transfer east,40.74,-73.899\nD,Destination,40.78,-73.90\n';
  files['trips.txt'] = 'route_id,service_id,trip_id,direction_id\n' + trips.map(([routeId, id]) => `${routeId},WK,${id},0`).join('\n') + '\n';
  files['stop_times.txt'] = 'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n' + trips.flatMap(([_route, id, from, to, departs, arrives]) => [`${id},${departs},${departs},${from},1`, `${id},${arrives},${arrives},${to},2`]).join('\n') + '\n';
  const timetable = await buildTimetable('nice', files);
  const network = new TransitNetwork([{ agencyId: 'nice', version: 'recovery-fixture', timetable }]);
  setTransitNetworkForTests(network);
  const origin = { lat: 40.70, lng: -73.90 }, destination = { lat: 40.78, lng: -73.90 };
  const plan = (entities = []) => planTransitTrip({ request: { origin: { ...origin, label: 'Home' }, destination: { ...destination, label: 'Work' }, time: { mode: 'now' }, modes: ['bus'], ferry: false, preference: 'fastest', recovery: { excludedRuns: [], preferredRoute: { agencyId: 'nice', routeId: 'A' } } }, origin, destination, nowMs: now, recoveryFeedLookup: async () => [feed(entities)] });
  return { plan };
}
const ref = (date = '20261118') => ({ version: 1, ...route, tripId: 'B-08:00:00', serviceDate: date, scheduleVersion: scheduleVersionForTimetable(table), startTime: '08:00:00', boardStopId: 'B1', alightStopId: 'B3', boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 1, alightStopSequence: 3, directionId: 0 });
const search = (result, at = now, horizon = 18 * 3600) => new TransitRouter(result.network, 6).forward((at - days.baseStartMs) / 1000,
  [{ stop: stopIndex(result.network, 'B1'), seconds: 0 }], [{ stop: stopIndex(result.network, 'B3'), seconds: 0 }],
  { days: days.days, maxRounds: 3, modes: new Set(['bus']), horizonSeconds: horizon, bannedRuns: result.bannedRuns }, result.network.activeServices(days.days));

test('recovery includes a past-scheduled run still predicted ahead instead of dropping it at lower_bound(now)', async () => {
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([update('08:00', [12, 17, 22])])]);
  const journey = search(result)[0];
  const ride = journey.legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:00:00');
  assert.equal(days.baseStartMs + journey.arrives * 1000, wednesdayAt(8, 22));
  assert.equal(result.coverage.updatedRuns, 1);
});

test('independent live patterns preserve a later departure that overtakes an earlier delayed bus', async () => {
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([update('08:00', [12, 30, 40]), update('08:15', [17, 22, 27])])]);
  const journey = search(result)[0];
  const ride = journey.legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:15:00');
  assert.equal(days.baseStartMs + journey.arrives * 1000, wednesdayAt(8, 27));
});

test('a fresh cancellation cannot reappear as its ordinary static departure', async () => {
  const cancelled = update('08:15', [], { trip: { tripId: 'B-08:15:00', routeId: 'B', startDate: '20261118', startTime: '08:15:00', scheduleRelationship: 3 } });
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([cancelled])]);
  const ride = search(result)[0].legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:30:00');
});

test('NO_DATA at boarding is not turned into a predicted departure', async () => {
  const entity = update('08:00', [12, 17, 22]);
  entity.tripUpdate.stopTimeUpdate[0] = { stopId: 'B1', stopSequence: 1, scheduleRelationship: 2 };
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([entity])]);
  const ride = search(result)[0].legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:15:00');
  assert.equal(result.coverage.state, 'partial');
});

test('an arrival-only boarding observation is not used as an observed future departure', async () => {
  const entity = update('08:00', [12, 17, 22]);
  delete entity.tripUpdate.stopTimeUpdate[0].departure;
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([entity])]);
  const ride = search(result)[0].legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:15:00');
  assert.equal(result.coverage.state, 'partial');
});

test('stale or undated updates produce explicit partial coverage without live alternatives', async () => {
  const old = update('08:00', [12, 17, 22]); old.tripUpdate.timestamp = (now - 300_000) / 1000;
  const stale = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now, async () => [feed([old], now - 300_000)]);
  assert.equal(stale.coverage.state, 'partial'); assert.equal(stale.coverage.updatedRuns, 0);
  const undated = update('08:00', [12, 17, 22]); delete undated.tripUpdate.trip.startDate;
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, [route], { excludedRuns: [] }, now + 1, async () => [feed([undated], now + 1)]);
  assert.ok(result.coverage.reasons.includes('undated-feed'));
});

test('excluding a run is service-date specific, preserving the same trip ID tomorrow', async () => {
  const data = busFeed();
  data['trips.txt'] = data['trips.txt'].trim().split('\n').filter((row, index) => index === 0 || row.includes('B-08:00:00')).join('\n') + '\n';
  data['stop_times.txt'] = data['stop_times.txt'].trim().split('\n').filter((row, index) => index === 0 || row.startsWith('B-08:00:00,')).join('\n') + '\n';
  const only = await buildTimetable('nice', data);
  const network = new TransitNetwork([{ agencyId: 'nice', version: 'single', timetable: only }]);
  const result = await recoveryNetwork(network, days.days, days.baseStartMs, [], { excludedRuns: [{ ...ref(), scheduleVersion: scheduleVersionForTimetable(only) }] }, now, async () => []);
  const journey = search(result, wednesdayAt(7, 59), 48 * 3600)[0];
  const ride = journey.legs.find((leg) => leg.kind === 'ride');
  assert.equal(result.network.tripId(ride.trip), 'B-08:00:00');
  assert.equal(days.days[ride.day].date, 20261119);
});

test('bounded recovery reports incomplete coverage and never fetches arbitrary route IDs', async () => {
  let requests = 0;
  const routes = Array.from({ length: 13 }, (_, index) => ({ ...route, routeId: `unknown-${index}` }));
  const result = await recoveryNetwork(base, days.days, days.baseStartMs, routes, { excludedRuns: [] }, now, async () => { requests += 1; return []; });
  assert.equal(requests, 0);
  assert.equal(result.coverage.state, 'partial');
  assert.ok(result.coverage.reasons.includes('route-limit'));
  assert.ok(result.coverage.reasons.includes('missing-route'));
});

test('a first-line preference keeps a feasible local without banning a later transfer', async () => {
  const network = await buildTestNetwork();
  const firstRoute = network.routes.findIndex((entry) => entry.agencyId === 'subway' && entry.routeId === 'A');
  const day = serviceDaysAround(wednesdayAt(8));
  const journeys = new TransitRouter(network, 6).forward((wednesdayAt(8) - day.baseStartMs) / 1000,
    [{ stop: stopIndex(network, 'A1'), seconds: 0 }], [{ stop: stopIndex(network, 'A4'), seconds: 0 }],
    { days: day.days, maxRounds: 3, modes: new Set(['subway']), horizonSeconds: 3600, firstRoutes: new Set([firstRoute]) }, network.activeServices(day.days));
  assert.equal(network.routes[network.patternRoute[journeys[0].legs.find((leg) => leg.kind === 'ride').pattern]].routeId, 'A');
});

test('recovery exposes live feasibility while retaining the original run identity and scheduled times', async () => {
  setTransitNetworkForTests(base);
  const origin = { lat: 40.72, lng: -73.903 }, destination = { lat: 40.72, lng: -73.88 };
  const plans = await planTransitTrip({ request: { origin: { ...origin, label: 'Home' }, destination: { ...destination, label: 'Work' }, time: { mode: 'now' }, modes: ['bus'], ferry: false, preference: 'fastest', recovery: { excludedRuns: [], preferredRoute: route } }, origin, destination, nowMs: now, recoveryFeedLookup: async () => [feed([update('08:00', [12, 17, 22])])] });
  const ride = plans[0].steps.find((step) => step.kind === 'transit');
  assert.equal(ride.runRef.tripId, 'B-08:00:00');
  assert.equal(ride.from.time, new Date(wednesdayAt(8)).toISOString());
  assert.equal(ride.live.departs, new Date(wednesdayAt(8, 12)).toISOString());
  assert.equal(ride.to.time, new Date(wednesdayAt(8, 10)).toISOString());
  assert.equal(ride.live.arrives, new Date(wednesdayAt(8, 22)).toISOString());
  const firstRide = plans[0].steps.findIndex((step) => step.kind === 'transit');
  const lastRide = plans[0].steps.findLastIndex((step) => step.kind === 'transit');
  const leadWalkSeconds = plans[0].steps.slice(0, firstRide).reduce((sum, step) => sum + step.durationSeconds, 0);
  const tailWalkSeconds = plans[0].steps.slice(lastRide + 1).reduce((sum, step) => sum + step.durationSeconds, 0);
  assert.equal(Date.parse(plans[0].departureTime), Date.parse(ride.from.time) - leadWalkSeconds * 1000);
  assert.equal(Date.parse(plans[0].arrivalTime), Date.parse(ride.to.time) + tailWalkSeconds * 1000);
  assert.equal(plans[0].durationSeconds, (Date.parse(plans[0].arrivalTime) - Date.parse(plans[0].departureTime)) / 1000);
  assert.notEqual(plans[0].departureTime, ride.live.departs);
  assert.notEqual(plans[0].arrivalTime, ride.live.arrives);
  assert.equal(recoveryCoverageFor(plans).updatedRuns, 1);
});

test('a preferred line made unreachable by the measured transfer walk falls back to another line', async (context) => {
  const { plan } = await recoveryFixture([
    ['A', 'preferred', 'O', 'P', '08:10:00', '08:20:00'],
    ['B', 'connection', 'Q', 'D', '08:25:00', '08:35:00'],
    ['X', 'alternative', 'O', 'D', '08:12:00', '08:45:00'],
  ]);
  const walking = require('../lib/walkingGraph');
  context.mock.method(walking, 'hasWalkingData', () => true);
  context.mock.method(walking, 'walkingMeters', (a, b, c, d) => Math.hypot((c - a) * 111_000, (d - b) * 84_000));
  context.mock.method(walking, 'walkingPath', (a, b, c, d) => a === 40.74 && c === 40.74 && b !== d ? null : { meters: 0, path: [{ lat: a, lon: b }, { lat: c, lon: d }] });
  const plans = await plan();
  assert.ok(plans.length > 0, 'an impossible measured transfer must not hide the available alternate line');
  assert.ok(plans.every((itinerary) => itinerary.steps.find((step) => step.kind === 'transit').runRef.routeId === 'X'));
});

test('recovery rejects reversed global baseline clocks without changing immutable selected leg times', async () => {
  const { plan } = await recoveryFixture([
    ['A', 'preferred-old', 'O', 'P', '08:00:00', '08:20:00'],
    ['A', 'preferred-later', 'O', 'P', '08:10:00', '08:20:00'],
    ['B', 'connection-old', 'Q', 'D', '07:30:00', '07:40:00'],
    ['B', 'connection-later', 'Q', 'D', '08:25:00', '09:30:00'],
    ['X', 'alternative', 'O', 'D', '08:15:00', '09:05:00'],
  ]);
  const live = (tripId, routeId, startTime, stopIds, minutes) => ({ tripUpdate: { trip: { tripId, routeId, startDate: '20261118', startTime, directionId: 0 }, timestamp: now / 1000,
    stopTimeUpdate: stopIds.map((stopId, index) => ({ stopId, stopSequence: index + 1, arrival: { time: wednesdayAt(8, minutes[index]) / 1000 }, departure: { time: wednesdayAt(8, minutes[index]) / 1000 } })) } });
  const cancelled = live('connection-later', 'B', '08:25:00', [], []);
  cancelled.tripUpdate.trip.scheduleRelationship = 3;
  const plans = await plan([live('preferred-old', 'A', '08:00:00', ['O', 'P'], [12, 32]), live('connection-old', 'B', '07:30:00', ['Q', 'D'], [40, 50]), cancelled]);
  assert.ok(plans.length > 0, 'valid other-line recovery remains available');
  assert.ok(plans.every((itinerary) => Date.parse(itinerary.arrivalTime) >= Date.parse(itinerary.departureTime)), 'a live rescue must not emit a negative-duration static snapshot');
  assert.ok(plans.every((itinerary) => itinerary.steps.find((step) => step.kind === 'transit').runRef.routeId === 'X'));
});

test('a recovery trip crossing midnight keeps its valid positive UTC baseline interval', async () => {
  const { plan } = await recoveryFixture([['A', 'overnight', 'O', 'D', '24:10:00', '24:30:00']]);
  const plans = await plan();
  assert.ok(plans.length > 0);
  const ride = plans[0].steps.find((step) => step.kind === 'transit');
  assert.equal(ride.runRef.serviceDate, '20261118');
  assert.equal(ride.from.time, new Date(wednesdayAt(24, 10)).toISOString());
  assert.ok(Date.parse(plans[0].arrivalTime) > Date.parse(plans[0].departureTime));
  assert.equal(plans[0].durationSeconds, 20 * 60);
});
