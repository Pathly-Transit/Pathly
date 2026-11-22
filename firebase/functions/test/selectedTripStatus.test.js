const assert = require('node:assert/strict');
const test = require('node:test');

const { parseTripLiveRequest, selectedTripStatus } = require('../lib/selectedTripStatus');
const { AGENCY_CONFIGS } = require('../lib/gtfsAgencies');
const { transit_realtime } = require('gtfs-realtime-bindings');

const NOW = Date.parse('2026-11-22T15:00:00Z');
const REF = { version: 1, agencyId: 'lirr', routeId: '1', tripId: 'selected', serviceDate: '20261122', scheduleVersion: 'snapshot-a', startTime: '09:00:00', boardStopId: 'A', alightStopId: 'B', boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 10, alightStopSequence: 20, directionId: 1 };
const at = (minutes) => new Date(NOW + minutes * 60_000).toISOString();
const request = (extra = {}) => ({ version: 1, legs: [{ legKey: '1', runRef: { ...REF } }], ...extra });
const run = (runRef) => ({ runRef, departs: at(0), arrives: at(30), stops: [{ stopId: 'A', occurrence: 0, stopSequence: 10, arrives: at(0), departs: at(0) }, { stopId: 'B', occurrence: 0, stopSequence: 20, arrives: at(30), departs: at(30) }] });
const feeds = () => [{ observedAt: NOW, fetchedAt: NOW, differential: false, entities: [{ id: 'one', tripUpdate: { trip: { tripId: 'selected', routeId: '1', startDate: '20261122', startTime: '09:00:00', directionId: 1 }, timestamp: NOW / 1000, stopTimeUpdate: [{ stopId: 'A', stopSequence: 10, departure: { time: (NOW + 300_000) / 1000 } }, { stopId: 'B', stopSequence: 20, arrival: { time: (NOW + 2_100_000) / 1000 } }] } }] }];

test('request bounds/version/keys are enforced before upstream work', () => {
  for (const invalid of [null, {}, request({ version: 2 }), request({ legs: [] }), request({ legs: Array.from({ length: 13 }, (_, i) => ({ legKey: String(i), runRef: REF })) }), request({ legs: [{ legKey: '1', runRef: REF }, { legKey: '1', runRef: REF }] })]) {
    assert.throws(() => parseTripLiveRequest(invalid), { code: 'invalid-argument' });
  }
});

test('run identity validates real dates, GTFS clocks, numeric occurrences and supported agency', () => {
  for (const change of [{ version: 2 }, { agencyId: 'unknown' }, { serviceDate: '20260230' }, { serviceDate: '2026-11-22' }, { startTime: '24:99:00' }, { startTime: '168:00:00' }, { boardOccurrence: -1 }, { boardOccurrence: 0.5 }, { alightStopSequence: Infinity }, { directionId: 2 }, { tripId: '\u0000' }, { scheduleVersion: '' }]) {
    assert.throws(() => parseTripLiveRequest(request({ legs: [{ legKey: '1', runRef: { ...REF, ...change } }] })), { code: 'invalid-argument' });
  }
  assert.equal(parseTripLiveRequest(request({ legs: [{ legKey: '1', runRef: { ...REF, startTime: '25:30:00' } }] })).legs[0].runRef.startTime, '25:30:00');
});

test('client-provided times and unknown fields never become authoritative baseline', async () => {
  const data = request();
  data.legs[0].departs = at(999);
  data.legs[0].runRef.departs = at(999);
  const parsed = parseTripLiveRequest(data);
  assert.equal(parsed.legs[0].departs, undefined);
  assert.equal(parsed.legs[0].runRef.departs, undefined);
  const result = await selectedTripStatus(parsed, { resolveRun: async (ref) => run(ref), feedsFor: async () => feeds(), nowMs: NOW });
  assert.equal(result.legs[0].departureDelaySeconds, 300);
  assert.equal(result.legs[0].arrivalDelaySeconds, 300);
});

test('schedule mismatch does not fetch a live feed or borrow another baseline', async () => {
  let fetched = 0;
  const result = await selectedTripStatus(request(), { resolveRun: async () => null, feedsFor: async () => { fetched += 1; return feeds(); }, nowMs: NOW });
  assert.equal(fetched, 0);
  assert.equal(result.legs[0].reason, 'schedule-mismatch');
});

test('each selected leg succeeds or fails independently', async () => {
  const data = request({ legs: [{ legKey: '1', runRef: REF }, { legKey: '3', runRef: { ...REF, tripId: 'unavailable' } }] });
  const result = await selectedTripStatus(data, { resolveRun: async (ref) => { if (ref.tripId === 'unavailable') throw new Error('offline'); return run(ref); }, feedsFor: async () => feeds(), nowMs: NOW });
  assert.equal(result.legs[0].state, 'fresh');
  assert.equal(result.legs[1].reason, 'feed-unavailable');
  assert.equal(result.version, 1);
  assert.equal(result.fetchedAt, NOW);
});

test('a failed agency cannot serve a cached stale root while other agencies remain usable', async () => {
  let resolved = 0;
  const result = await selectedTripStatus(request(), { unavailableAgencies: new Set(['lirr']), resolveRun: async (ref) => { resolved += 1; return run(ref); }, feedsFor: async () => feeds(), nowMs: NOW });
  assert.equal(resolved, 0);
  assert.equal(result.legs[0].reason, 'feed-unavailable');
});

test('slow work is bounded and a late completion cannot mutate the returned observation', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const result = await selectedTripStatus(request(), { resolveRun: async (ref) => run(ref), feedsFor: () => pending, nowMs: NOW, budgetMs: 5 });
  assert.equal(result.legs[0].reason, 'timeout');
  release(feeds());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result.legs[0].reason, 'timeout');
  assert.equal(result.legs[0].departs, undefined);
});

test('absent live coverage is unknown rather than on time', async () => {
  const result = await selectedTripStatus(request(), { resolveRun: async (ref) => run(ref), feedsFor: async () => [], nowMs: NOW });
  assert.equal(result.legs[0].state, 'unknown');
  assert.equal(result.legs[0].reason, 'unsupported-feed');
});

test('a selected-leg batch reuses the shared feed and cached HTTP data cannot renew source expiry', async () => {
  const originalFetch = global.fetch;
  const originalRequests = AGENCY_CONFIGS.lirr.feedRequestsForRoute;
  let calls = 0;
  AGENCY_CONFIGS.lirr.feedRequestsForRoute = () => [{ url: 'https://example.test/selected-batch-feed' }];
  global.fetch = async () => {
    calls += 1;
    return new Response(transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000 }, entity: feeds()[0].entities }).finish());
  };
  try {
    const data = request({ legs: [{ legKey: '1', runRef: REF }, { legKey: '3', runRef: REF }] });
    const dependencies = { resolveRun: async (ref) => run(ref), nowMs: NOW };
    const first = await selectedTripStatus(data, dependencies);
    const later = await selectedTripStatus(data, { ...dependencies, nowMs: NOW + 91_000 });
    assert.equal(calls, 1);
    assert.ok(first.legs.every((leg) => leg.state === 'fresh'));
    assert.ok(later.legs.every((leg) => leg.state === 'stale' && leg.expiresAt === NOW + 90_000));
  } finally {
    global.fetch = originalFetch;
    AGENCY_CONFIGS.lirr.feedRequestsForRoute = originalRequests;
  }
});
