const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { consumeTokenBucket, resetCallableSecurityForTests, setSharedRateLimitConsumerForTests } = require('../lib/callableSecurity');
const { planTrip, requiredPlanTripRequest, setTripAlertsLookupForTests, setTripLiveLookupForTests, setTripStopMatcherForTests } = require('../lib');
const { SERVICE_AREA_BOUNDS } = require('../lib/serviceArea');
const { resetGtfsSnapshotStateForTests, setGtfsSnapshotBucketForTests } = require('../lib/gtfsSnapshots');
const { resetGtfsStaticDataForTests } = require('../lib/gtfsStaticData');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const validData = {
  origin: { lat: 40.9126, lng: -73.1234, label: 'Current location' },
  destination: { placeId: 'ChIJ-penn', label: 'Penn Station' },
  time: { mode: 'now' },
  preference: 'fastest',
  modes: ['subway', 'bus', 'rail'],
};
const run = (data, uid = 'trip-user') => planTrip.run({ auth: uid ? { uid } : null, data, rawRequest: {} });

let fetchCalls;
let originalFetch;
test.beforeEach(() => {
  resetCallableSecurityForTests();
  fetchCalls = [];
  originalFetch = global.fetch;
  // Line alerts come from their own feed; these tests count only the Routes API call.
  setTripAlertsLookupForTests(async () => []);
});
test.afterEach(() => {
  global.fetch = originalFetch;
  setTripStopMatcherForTests(undefined);
  setTripLiveLookupForTests(undefined);
  setTripAlertsLookupForTests(undefined);
  setSharedRateLimitConsumerForTests(undefined);
});

/** Answers the Routes API call with `body` (and records the request). */
function stubRoutes(body, status = 200) {
  global.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
}

test('plans real itineraries through the Routes API with the field mask and alternatives', async () => {
  stubRoutes(fixture('routes-sbu-penn.json'));
  const { itineraries } = await run(validData);
  assert.ok(itineraries.length >= 2);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://routes.googleapis.com/directions/v2:computeRoutes');
  assert.match(fetchCalls[0].init.headers['X-Goog-FieldMask'], /routes\.legs\.steps\.transitDetails/);
  const sent = JSON.parse(fetchCalls[0].init.body);
  assert.equal(sent.travelMode, 'TRANSIT');
  assert.equal(sent.computeAlternativeRoutes, true);
  assert.deepEqual(sent.destination, { placeId: 'ChIJ-penn' });
});

test('requires a signed-in rider and consumes a rate-limit token', async () => {
  stubRoutes({ routes: [] });
  await assert.rejects(() => run(validData, null), (error) => error.code === 'unauthenticated');
  const consumed = [];
  setSharedRateLimitConsumerForTests(async (key, limit, nowMs) => {
    consumed.push(key.split(':')[0]);
    return consumeTokenBucket(undefined, limit, nowMs);
  });
  await run(validData);
  assert.deepEqual(consumed, ['planTrip']);
  assert.equal(fetchCalls.length, 1, 'the anonymous call never reached Google');
});

test('rejects endpoints outside the service area before calling Google', async () => {
  stubRoutes({ routes: [] });
  await assert.rejects(
    () => run({ ...validData, destination: { lat: 42.36, lng: -71.06, label: 'Boston' } }),
    (error) => error.code === 'invalid-argument' && error.details?.reason === 'out-of-area',
  );
  assert.equal(fetchCalls.length, 0);
});

test('rejects a place-only endpoint that Google locates outside the service area', async () => {
  const raw = JSON.parse(fixture('routes-sbu-penn.json'));
  raw.routes[0].legs[0].endLocation = { latLng: { latitude: 42.36, longitude: -71.06 } };
  stubRoutes(raw);
  await assert.rejects(() => run(validData), (error) => error.details?.reason === 'out-of-area');
});

test('accepts and plans a Metro-North destination beyond the former service-area bounds', async () => {
  const raw = JSON.parse(fixture('routes-sbu-penn.json'));
  const route = raw.routes[0];
  route.legs[0].endLocation = { latLng: { latitude: 41.814722, longitude: -73.567 } };
  const metroNorth = route.legs[0].steps.find((step) => step.transitDetails)?.transitDetails;
  metroNorth.transitLine = {
    agencies: [{ name: 'Metro-North Railroad' }],
    name: 'Harlem',
    nameShort: 'Harlem',
    color: '#0039A6',
    vehicle: { type: 'COMMUTER_TRAIN', name: { text: 'Train' } },
  };
  metroNorth.stopDetails.departureStop.name = 'Grand Central';
  metroNorth.stopDetails.arrivalStop.name = 'Wassaic';
  delete route.travelAdvisory;
  delete route.localizedValues;
  stubRoutes(raw);
  setTripLiveLookupForTests(async () => []);

  const { itineraries } = await run({ ...validData, destination: { placeId: 'wassaic', label: 'Wassaic' } });
  const metroNorthItinerary = itineraries.find((itinerary) => itinerary.steps.some((step) => step.kind === 'transit' && step.agency.name === 'Metro-North Railroad'));
  assert.ok(metroNorthItinerary, 'the Metro-North itinerary is returned');
  assert.equal(metroNorthItinerary.fare, undefined, 'no fare is inferred when the routing service has none');
  assert.ok(fetchCalls.length > 0, 'the request reached the routing service');
});

test('maps a Google failure to unavailable and an empty answer to no itineraries', async () => {
  stubRoutes({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Routes API has not been used' } }, 403);
  await assert.rejects(() => run(validData), (error) => error.code === 'unavailable');

  global.fetch = async () => {
    throw new Error('network down');
  };
  await assert.rejects(() => run(validData), (error) => error.code === 'unavailable');

  stubRoutes({});
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

test("adds the stops in between to LIRR legs from Pathly's timetables", async () => {
  stubRoutes(fixture('routes-sbu-penn.json'));
  const { itineraries } = await run(validData);
  const lirr = itineraries.flatMap((itinerary) => itinerary.steps).filter((step) => step.kind === 'transit' && step.agency.name === 'Long Island Rail Road');
  assert.ok(lirr.length > 0);
  assert.ok(lirr.every((step) => Array.isArray(step.stops) && step.stops.length > 0));
  assert.deepEqual(Object.keys(lirr[0].stops[0]).sort(), ['location', 'name', 'time']);
});

test('returns itineraries without stops when matching is slower than its budget', async () => {
  stubRoutes(fixture('routes-sbu-penn.json'));
  setTripStopMatcherForTests(() => new Promise(() => undefined));
  const started = Date.now();
  const { itineraries } = await run(validData);
  assert.ok(Date.now() - started < 4_000);
  assert.ok(itineraries.length > 0);
  assert.ok(itineraries.flatMap((itinerary) => itinerary.steps).every((step) => step.stops === undefined));
});

async function withStalledSnapshotReads(t, body) {
  const originalOverride = process.env.GTFS_USE_CLOUD_STORAGE;
  process.env.GTFS_USE_CLOUD_STORAGE = 'true';
  resetGtfsSnapshotStateForTests();
  resetGtfsStaticDataForTests();
  const reads = [];
  setGtfsSnapshotBucketForTests({
    file: (name) => ({
      getMetadata: () => {
        reads.push(name);
        return new Promise(() => undefined);
      },
    }),
  });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-19T12:00:00Z') });
  try {
    await body(reads);
  } finally {
    t.mock.timers.reset();
    resetGtfsSnapshotStateForTests();
    resetGtfsStaticDataForTests();
    if (originalOverride === undefined) delete process.env.GTFS_USE_CLOUD_STORAGE;
    else process.env.GTFS_USE_CLOUD_STORAGE = originalOverride;
  }
}

test('cold timetable reads share the stop enrichment budget instead of blocking ready routes', async (t) => {
  await withStalledSnapshotReads(t, async (reads) => {
    stubRoutes(fixture('routes-sbu-penn.json'));
    let matches = 0;
    setTripStopMatcherForTests(async () => { matches += 1; return undefined; });
    let settled = false;
    const pending = run(validData).then((answer) => { settled = true; return answer; });
    await new Promise((resolve) => setImmediate(resolve));
    const startedTogether = [...reads];
    t.mock.timers.tick(3_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'ready Google routes return within the single 3s timetable/stop budget');
    assert.ok(startedTogether.includes('gtfs/v1/lirr/current.json'));
    assert.ok(startedTogether.includes('gtfs/v1/suffolk/current.json'), 'both agencies begin loading before either finishes');
    assert.ok((await pending).itineraries.length > 0);
    assert.equal(matches, 0, 'expired enrichment does not start additional matching work');
  });
});

test('an empty route result does not load an unrelated LIRR fare timetable', async (t) => {
  await withStalledSnapshotReads(t, async (reads) => {
    stubRoutes({ routes: [] });
    let settled = false;
    const pending = run(validData).then((answer) => { settled = true; return answer; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, true, 'there is no optional transit data to wait for');
    assert.deepEqual(await pending, { itineraries: [] });
    assert.deepEqual(reads, []);
  });
});
