const assert = require('node:assert/strict');
const test = require('node:test');

const { observeSelectedRun } = require('../lib/tripLiveSelection');

const NOW = Date.parse('2026-11-22T15:00:00Z');
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const event = (minutes) => ({ time: Date.parse(at(minutes)) / 1000 });
const REF = { version: 1, agencyId: 'lirr', routeId: '1', tripId: 'selected', serviceDate: '20261122', scheduleVersion: 'snapshot-a', startTime: '09:00:00', boardStopId: 'A', alightStopId: 'B', boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 10, alightStopSequence: 20, directionId: 1 };
const RUN = { runRef: REF, departs: at(0), arrives: at(30), stops: [
  { stopId: 'A', occurrence: 0, stopSequence: 10, arrives: at(0), departs: at(0) },
  { stopId: 'B', occurrence: 0, stopSequence: 20, arrives: at(30), departs: at(30) },
] };
const update = (extra = {}) => ({ trip: { tripId: 'selected', routeId: '1', startDate: '20261122', startTime: '09:00:00', directionId: 1 }, timestamp: NOW / 1000, stopTimeUpdate: [{ stopId: 'A', stopSequence: 10, departure: event(4) }, { stopId: 'B', stopSequence: 20, arrival: event(36) }], ...extra });
const feed = (updates = [update()], extra = {}) => ({ observedAt: NOW, fetchedAt: NOW, differential: false, entities: updates.map((tripUpdate, i) => ({ id: String(i), tripUpdate })), ...extra });
const observe = (updates, run = RUN) => observeSelectedRun([feed(updates)], run, '1', NOW);

test('exact run returns independent arrival/departure delays and measured expiry', () => {
  const result = observe();
  assert.equal(result.legKey, '1');
  assert.equal(result.state, 'fresh');
  assert.equal(result.status, 'predicted');
  assert.equal(result.departs, at(4));
  assert.equal(result.arrives, at(36));
  assert.equal(result.departureDelaySeconds, 240);
  assert.equal(result.arrivalDelaySeconds, 360);
  assert.equal(result.expiresAt, NOW + 90_000);
  assert.deepEqual(result.runRef, REF);
});

test('another day, direction, route, start time or next bus never stands in for the selected run', () => {
  for (const change of [{ startDate: '20261121' }, { startDate: '20261123' }, { directionId: 0 }, { routeId: '2' }, { startTime: '09:15:00' }, { tripId: 'next-bus' }]) {
    const item = update();
    item.trip = { ...item.trip, ...change };
    assert.equal(observe([item]).state, 'unknown');
  }
});

test('missing service date stays ambiguous even when absolute times look nearby', () => {
  const item = update();
  delete item.trip.startDate;
  const result = observe([item]);
  assert.equal(result.reason, 'ambiguous-run');
  assert.equal(result.departs, undefined);
});

test('only subway IDs can use the shortened static-ID adapter', () => {
  const tripId = 'AFA26GEN-L-2024-S300_096400_L..S16R';
  const item = update();
  item.trip.tripId = '096400_L..S';
  assert.equal(observe([item], { ...RUN, runRef: { ...REF, agencyId: 'subway', tripId } }).state, 'fresh');
  assert.equal(observe([item], { ...RUN, runRef: { ...REF, tripId } }).state, 'unknown');
  item.trip.tripId = '096400_L..N';
  assert.equal(observe([item], { ...RUN, runRef: { ...REF, agencyId: 'subway', tripId } }).state, 'unknown');
});

test('repeated stop visits use raw GTFS sequence, never first matching stop_id', () => {
  const repeated = { ...RUN, runRef: { ...REF, boardOccurrence: 1, boardStopSequence: 30 }, stops: [RUN.stops[0], { stopId: 'C', occurrence: 0, stopSequence: 20, arrives: at(-10), departs: at(-10) }, { ...RUN.stops[0], occurrence: 1, stopSequence: 30 }, { ...RUN.stops[1], stopSequence: 40 }] };
  const item = update({ stopTimeUpdate: [{ stopId: 'A', stopSequence: 10, departure: event(-20) }, { stopSequence: 30, departure: event(5) }, { stopId: 'B', stopSequence: 40, arrival: event(35) }] });
  repeated.runRef.alightStopSequence = 40;
  assert.equal(observe([item], repeated).departs, at(5));
  item.stopTimeUpdate = [{ stopId: 'A', departure: event(5) }, { stopId: 'B', stopSequence: 40, arrival: event(35) }];
  assert.equal(observe([item], repeated).reason, 'ambiguous-run');
});

test('a reassigned stop or duplicate sequence is ambiguous instead of silently changing boarding', () => {
  const moved = update({ stopTimeUpdate: [{ stopId: 'OTHER', stopSequence: 10, departure: event(5) }] });
  assert.equal(observe([moved]).reason, 'ambiguous-run');
  const duplicate = update();
  duplicate.stopTimeUpdate.push({ stopId: 'A', stopSequence: 10, departure: event(10) });
  assert.equal(observe([duplicate]).reason, 'ambiguous-run');
});

test('onboard long runs can update arrival when the feed has dropped the old boarding stop', () => {
  const run = { ...RUN, departs: at(-75) };
  const result = observe([update({ stopTimeUpdate: [{ stopId: 'B', stopSequence: 20, arrival: event(40) }] })], run);
  assert.equal(result.status, 'predicted');
  assert.equal(result.departs, undefined);
  assert.equal(result.arrives, at(40));
});

test('NO_DATA overrides malformed event times without inventing zero delay for that endpoint', () => {
  const item = update();
  item.stopTimeUpdate[0].scheduleRelationship = 2;
  let result = observe([item]);
  assert.equal(result.status, 'predicted');
  assert.equal(result.departureNoData, true);
  assert.equal(result.departs, undefined);
  assert.equal(result.departureDelaySeconds, undefined);
  item.stopTimeUpdate[1].scheduleRelationship = 2;
  result = observe([item]);
  assert.equal(result.status, 'no-data');
  assert.equal(result.arrivalNoData, true);
  assert.equal(result.arrives, undefined);
  assert.equal(result.arrivalInferred, undefined);
  assert.equal(result.departureInferred, undefined);
});

test('one-sided predictions apply event delay against their own schedule and preserve a15-minute dwell', () => {
  const run = { ...RUN, stops: [{ ...RUN.stops[0], arrives: at(-15) }, { ...RUN.stops[1], departs: at(45) }] };
  const item = update({ stopTimeUpdate: [{ stopId: 'A', stopSequence: 10, arrival: event(-10) }, { stopId: 'B', stopSequence: 20, departure: event(45) }] });
  const result = observe([item], run);
  assert.equal(result.departs, at(5));
  assert.equal(result.departureDelaySeconds, 300);
  assert.equal(result.departureInferred, true);
  assert.equal(result.arrives, at(30));
  assert.equal(result.arrivalDelaySeconds, 0, 'scheduled terminal dwell is not a false15-minute arrival delay');
  assert.equal(result.arrivalInferred, true);
  item.stopTimeUpdate[0].departure = event(6);
  item.stopTimeUpdate[1].arrival = event(32);
  const direct = observe([item], run);
  assert.equal(direct.departs, at(6));
  assert.equal(direct.arrives, at(32));
  assert.equal(direct.departureInferred, undefined);
  assert.equal(direct.arrivalInferred, undefined);
});

test('cancellation and deletion need exact dated identity but no stop prediction', () => {
  for (const scheduleRelationship of [3, 7]) {
    const item = update({ stopTimeUpdate: [] });
    item.trip.scheduleRelationship = scheduleRelationship;
    assert.equal(observe([item]).status, 'cancelled');
    delete item.trip.startDate;
    assert.equal(observe([item]).state, 'unknown');
  }
});

test('skipped boarding and skipped alighting are distinguished for onboard consumers', () => {
  const item = update();
  item.stopTimeUpdate[0].scheduleRelationship = 1;
  let result = observe([item]);
  assert.equal(result.status, 'skips-stop');
  assert.equal(result.boardSkipped, true);
  assert.equal(result.alightSkipped, undefined);
  item.stopTimeUpdate[0].scheduleRelationship = 0;
  item.stopTimeUpdate[1].scheduleRelationship = 1;
  result = observe([item]);
  assert.equal(result.alightSkipped, true);
  assert.equal(result.boardSkipped, undefined);
});

test('old feed or trip measurements expire even when fetched just now and events are future', () => {
  const item = update();
  const oldFeed = feed([item], { observedAt: NOW - 90_000 });
  assert.equal(observeSelectedRun([oldFeed], RUN, '1', NOW).state, 'stale');
  item.timestamp = (NOW - 91_000) / 1000;
  assert.equal(observe([item]).state, 'stale');
  assert.equal(observe([item]).expiresAt, NOW - 1_000);
});

test('missing or future source timestamps are unknown, not newly live', () => {
  const item = update();
  delete item.timestamp;
  assert.equal(observeSelectedRun([feed([item], { observedAt: null })], RUN, '1', NOW).reason, 'missing-timestamp');
  item.timestamp = (NOW + 31_000) / 1000;
  assert.equal(observe([item]).reason, 'future-timestamp');
});

test('newer measurements win; contradictory equally timed selected-run updates are ambiguous', () => {
  const old = update({ timestamp: (NOW - 10_000) / 1000 });
  old.stopTimeUpdate[0].departure = event(1);
  assert.equal(observe([old, update()]).departs, at(4));
  old.timestamp = NOW / 1000;
  assert.equal(observe([old, update()]).reason, 'ambiguous-run');
});

test('differential, deleted entities and new/replacement runs are not authoritative selected-run facts', () => {
  assert.equal(observeSelectedRun([feed(undefined, { differential: true })], RUN, '1', NOW).reason, 'unsupported-feed');
  const deleted = feed();
  deleted.entities[0].isDeleted = true;
  assert.equal(observeSelectedRun([deleted], RUN, '1', NOW).reason, 'not-found');
  const item = update();
  item.trip.scheduleRelationship = 5;
  assert.equal(observe([item]).reason, 'unsupported-feed');
});

test('protobuf inherited zero defaults and invalid absolute values do not become predictions', () => {
  const item = update({ stopTimeUpdate: [{ stopId: 'A', stopSequence: 10, departure: Object.create({ delay: 0, time: 0 }) }] });
  assert.equal(observe([item]).reason, 'no-prediction');
  item.stopTimeUpdate[0].departure = { delay: 0 };
  assert.equal(observe([item]).departs, RUN.departs);
  item.stopTimeUpdate[0].departure = { time: Number.MAX_SAFE_INTEGER };
  assert.equal(observe([item]).departs, undefined);
});

const vehicle = (extra = {}) => ({ trip: update().trip, timestamp: NOW / 1000, currentStopSequence: 20,
  currentStatus: 1, stopId: 'B', position: { latitude: 40.9, longitude: -73.8 }, ...extra });
const withVehicle = (position, updates) => {
  const data = feed(updates);
  data.entities.push({ id: 'vehicle', vehicle: position });
  return observeSelectedRun([data], RUN, '1', NOW);
};

test('only an exact fresh vehicle past the raw boarding sequence can prove the vehicle has passed', () => {
  const result = withVehicle(vehicle());
  assert.equal(result.boardPassed, true);
  assert.deepEqual(result.vehicleLocation, { lat: 40.9, lng: -73.8, capturedAt: NOW });
  for (const currentStatus of [0, 1, 2, 'INCOMING_AT', 'STOPPED_AT', 'IN_TRANSIT_TO']) {
    assert.equal(withVehicle(vehicle({ currentStatus })).boardPassed, true);
  }
  const atBoard = withVehicle(vehicle({ currentStopSequence: 10, stopId: 'A' }));
  assert.equal(atBoard.boardPassed, undefined);
  assert.equal(withVehicle(vehicle({ currentStopSequence: 99 })).boardPassed, undefined);
  assert.equal(withVehicle(vehicle({ stopId: 'DIFFERENT-PLATFORM' })).boardPassed, undefined);
});

test('fresh vehicle-only evidence does not fabricate ETA or a cancellation', () => {
  const result = withVehicle(vehicle(), []);
  assert.equal(result.state, 'fresh');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'no-prediction');
  assert.equal(result.boardPassed, true);
  assert.equal(result.departs, undefined);
  assert.equal(result.arrives, undefined);
  const stale = update({ timestamp: (NOW - 100_000) / 1000 });
  stale.trip.scheduleRelationship = 3;
  assert.equal(withVehicle(vehicle(), [stale]).status, 'unavailable');
});

test('a predicted departure in the past alone never proves the vehicle left', () => {
  const item = update();
  item.stopTimeUpdate[0].departure = event(-5);
  assert.equal(observe([item]).boardPassed, undefined);
  assert.equal(withVehicle(vehicle({ currentStopSequence: 10, stopId: 'A' }), [item]).boardPassed, undefined);
});

test('missing or stale vehicle time/date/status and another run never prove boarding passed', () => {
  for (const extra of [{ timestamp: undefined }, { timestamp: (NOW - 91_000) / 1000 }, { timestamp: (NOW + 31_000) / 1000 },
    { currentStatus: undefined }, { currentStatus: 999 }, { currentStopSequence: undefined },
    { position: undefined }, { position: { latitude: 91, longitude: 0 } },
    { trip: { ...update().trip, tripId: 'next-bus' } }, { trip: { ...update().trip, startDate: '20261121' } },
    { trip: { ...update().trip, startDate: undefined } }, { trip: { ...update().trip, startTime: '09:15:00' } },
    { trip: { ...update().trip, scheduleRelationship: 3 } }]) {
    assert.equal(withVehicle(vehicle(extra)).boardPassed, undefined, JSON.stringify(extra));
  }
  const missingSequence = { ...RUN, stops: RUN.stops.map(({ stopSequence, ...stop }) => stop) };
  const data = feed();
  data.entities.push({ id: 'vehicle', vehicle: vehicle() });
  assert.equal(observeSelectedRun([data], missingSequence, '1', NOW).boardPassed, undefined);
});

test('old feed headers and conflicting equally timed vehicle positions suppress departure proof', () => {
  const data = feed(undefined, { observedAt: NOW - 91_000 });
  data.entities.push({ id: 'vehicle', vehicle: vehicle() });
  assert.equal(observeSelectedRun([data], RUN, '1', NOW).boardPassed, undefined);
  data.observedAt = NOW;
  data.entities.push({ id: 'other-vehicle', vehicle: vehicle({ currentStopSequence: 10, stopId: 'A' }) });
  assert.equal(observeSelectedRun([data], RUN, '1', NOW).boardPassed, undefined);
});
