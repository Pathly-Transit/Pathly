const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { consumeTokenBucket, resetCallableSecurityForTests, setSharedRateLimitConsumerForTests } = require('../lib/callableSecurity');
const { planTrip, requiredPlanTripRequest, setTransitPlannerForTests, setTripAlertsLookupForTests, setTripLiveLookupForTests } = require('../lib');
const { SERVICE_AREA_BOUNDS } = require('../lib/serviceArea');
const { resetGtfsSnapshotStateForTests, setGtfsSnapshotBucketForTests } = require('../lib/gtfsSnapshots');
const { resetGtfsStaticDataForTests } = require('../lib/gtfsStaticData');

const STONY_BROOK = { lat: 40.9126, lng: -73.1234 };
const PENN = { lat: 40.7506, lng: -73.9935 };
const validData = {
  origin: { ...STONY_BROOK, label: 'Current location' },
  destination: { ...PENN, label: 'Penn Station' },
  time: { mode: 'now' },
  preference: 'fastest',
  modes: ['subway', 'bus', 'rail'],
};
const run = (data, uid = 'trip-user') => planTrip.run({ auth: uid ? { uid } : null, data, rawRequest: {} });

const ITINERARY = {
  id: 'abc123abc123',
  departureTime: '2026-11-18T13:00:00.000Z',
  arrivalTime: '2026-11-18T14:00:00.000Z',
  durationSeconds: 3600,
  transfers: 0,
  steps: [],
};

let fetchCalls;
let planned;
let originalFetch;
test.beforeEach(() => {
  resetCallableSecurityForTests();
  fetchCalls = [];
  planned = [];
  originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    throw new Error('no outside request is expected');
  };
  setTripAlertsLookupForTests(async () => []);
  setTripLiveLookupForTests(async () => undefined);
  setTransitPlannerForTests(async (input) => {
    planned.push(input);
    return [ITINERARY];
  });
});
test.afterEach(() => {
  global.fetch = originalFetch;
  setTransitPlannerForTests(undefined);
  setTripLiveLookupForTests(undefined);
  setTripAlertsLookupForTests(undefined);
  setSharedRateLimitConsumerForTests(undefined);
});

/** Answers Google Places' place-details request with `location` (and records it). */
function stubPlace(location, status = 200) {
  global.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(JSON.stringify(location ? { location } : {}), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

test("plans with Pathly's own planner from the request's coordinates, asking no outside service", async () => {
  const { itineraries } = await run(validData);
  assert.deepEqual(itineraries, [ITINERARY]);
  assert.equal(fetchCalls.length, 0);
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0].origin, STONY_BROOK);
  assert.deepEqual(planned[0].destination, PENN);
  assert.equal(planned[0].request.destination.label, 'Penn Station');
  assert.equal(typeof planned[0].estimateFare, 'function', 'fares come from the published fare rules');
  // The LIRR's zone fares price a planned Stony Brook to Penn Station ride.
  const ride = { kind: 'transit', mode: 'rail', agency: { name: 'Long Island Rail Road' }, line: { name: 'Port Jefferson Branch' }, from: { name: 'Stony Brook', location: { lat: 40.92, lng: -73.128 }, time: '2026-11-18T15:00:00Z' }, to: { name: 'Penn Station', location: { lat: 40.7506, lng: -73.9935 }, time: '2026-11-18T16:30:00Z' }, stopCount: 9, durationSeconds: 5400, path: [] };
  assert.equal(planned[0].estimateFare([ride], ride.from.time).cents, 1600);
});

test('requires a signed-in rider and consumes a rate-limit token', async () => {
  await assert.rejects(() => run(validData, null), (error) => error.code === 'unauthenticated');
  const consumed = [];
  setSharedRateLimitConsumerForTests(async (key, limit, nowMs) => {
    consumed.push(key.split(':')[0]);
    return consumeTokenBucket(undefined, limit, nowMs);
  });
  await run(validData);
  assert.deepEqual(consumed, ['planTrip']);
  assert.equal(planned.length, 1, 'the anonymous call never planned');
});

test('rejects endpoints outside the service area before planning', async () => {
  await assert.rejects(
    () => run({ ...validData, destination: { lat: 42.36, lng: -71.06, label: 'Boston' } }),
    (error) => error.code === 'invalid-argument' && error.details?.reason === 'out-of-area',
  );
  assert.equal(planned.length, 0);
});

test("locates a place sent only as a Google place id, and rejects one outside the service area", async () => {
  stubPlace({ latitude: 40.7527, longitude: -73.9772 });
  await run({ ...validData, destination: { placeId: 'ChIJ-grand-central', label: 'Grand Central' } });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://places.googleapis.com/v1/places/ChIJ-grand-central');
  assert.equal(fetchCalls[0].init.headers['X-Goog-FieldMask'], 'location');
  assert.deepEqual(planned[0].destination, { lat: 40.7527, lng: -73.9772 });

  stubPlace({ latitude: 42.36, longitude: -71.06 });
  await assert.rejects(() => run({ ...validData, destination: { placeId: 'ChIJ-boston', label: 'Boston' } }), (error) => error.details?.reason === 'out-of-area');
  assert.equal(planned.length, 1);
});

test('a place that cannot be located, or a planner failure, is unavailable; no trip is an empty list', async () => {
  stubPlace(null, 404);
  await assert.rejects(() => run({ ...validData, destination: { placeId: 'ChIJ-gone', label: 'Gone' } }), (error) => error.code === 'unavailable');

  setTransitPlannerForTests(async () => {
    throw new Error('timetable unreadable');
  });
  await assert.rejects(() => run(validData), (error) => error.code === 'unavailable');

  setTransitPlannerForTests(async () => []);
  assert.deepEqual(await run(validData), { itineraries: [] });
});

test('validates the request shape and the plannable time window', () => {
  const now = Date.parse('2026-10-14T12:00:00Z');
  const bad = (patch) => assert.throws(() => requiredPlanTripRequest({ ...validData, ...patch }, now), (error) => error.details?.reason === 'bad-request');
  bad({ origin: { label: 'Nowhere' } });
  bad({ origin: { placeId: 'bad id!', label: 'X' } });
  bad({ preference: 'scenic' });
  bad({ modes: [] });
  bad({ modes: ['ferry'] });
  bad({ time: { mode: 'depart', at: 'soon' } });
  bad({ time: { mode: 'depart', at: '2026-10-01T12:00:00Z' } });
  bad({ time: { mode: 'arrive', at: '2027-03-01T12:00:00Z' } });
  const ok = requiredPlanTripRequest({ ...validData, time: { mode: 'arrive', at: '2026-10-15T16:00:00Z' }, modes: ['bus', 'bus'] }, now);
  assert.deepEqual(ok.time, { mode: 'arrive', at: '2026-10-15T16:00:00.000Z' });
  assert.deepEqual(ok.modes, ['bus']);
  bad({ lessWalking: 'yes' });
  assert.equal(requiredPlanTripRequest({ ...validData, lessWalking: true }, now).lessWalking, true);
  assert.equal('lessWalking' in requiredPlanTripRequest({ ...validData, lessWalking: false }, now), false);
  // Ferries ride unless turned off; older apps never send the field.
  bad({ ferry: 'no' });
  assert.equal(requiredPlanTripRequest({ ...validData, ferry: false }, now).ferry, false);
  assert.equal('ferry' in requiredPlanTripRequest({ ...validData, ferry: true }, now), false);
  assert.equal('ferry' in requiredPlanTripRequest(validData, now), false);
  // Ferries alone: no other mode, said outright.
  assert.deepEqual(requiredPlanTripRequest({ ...validData, modes: [], ferry: true }, now).modes, []);
  bad({ modes: [], ferry: false });
  bad({ walkOnlyMaxMinutes: 0 });
  bad({ walkOnlyMaxMinutes: 91 });
  bad({ walkOnlyMaxMinutes: 12.5 });
  bad({ walkOnlyMaxMinutes: '40' });
  assert.equal(requiredPlanTripRequest({ ...validData, walkOnlyMaxMinutes: 40 }, now).walkOnlyMaxMinutes, 40);
  assert.equal('walkOnlyMaxMinutes' in requiredPlanTripRequest(validData, now), false);
});

test('the backend service area matches the app\'s', () => {
  const mobile = fs.readFileSync(path.join(__dirname, '../../../mobile/src/data/serviceArea.ts'), 'utf8');
  // Metro-North extends the former NYC/Suffolk service area north to its upper stations.
  assert.equal(SERVICE_AREA_BOUNDS.north, 41.85, 'backend north includes Metro-North destinations');
  for (const [side, value] of Object.entries(SERVICE_AREA_BOUNDS)) {
    assert.match(mobile, new RegExp(`${side}: ${String(value).replace('.', '\\.')},`), `mobile ${side} is ${value}`);
  }
});
