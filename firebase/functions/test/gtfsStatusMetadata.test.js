const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { transit_realtime } = require('gtfs-realtime-bindings');
const { AGENCY_CONFIGS } = require('../lib/gtfsAgencies');
const { getRouteStatus } = require('../lib/gtfsStatus');
const { resetGtfsStaticDataForTests, setAgencyDataForTests } = require('../lib/gtfsStaticData');

const NOW = Date.parse('2026-11-22T15:00:00Z');
let originalFetch;
let originalRequests;
let originalClock;
let originalKey;
let serial = 0;
test.beforeEach(() => {
  originalFetch = global.fetch;
  originalClock = Date.now;
  originalRequests = AGENCY_CONFIGS.mn.feedRequestsForRoute;
  originalKey = process.env.MTA_BUS_TIME_API_KEY;
  process.env.MTA_BUS_TIME_API_KEY = 'test-key';
  Date.now = () => NOW;
  const url = `https://example.test/route-status-${serial++}`;
  AGENCY_CONFIGS.mn.feedRequestsForRoute = () => [{ url }];
  resetGtfsStaticDataForTests();
  setAgencyDataForTests('mn', path.join(__dirname, 'fixtures', 'gtfs', 'mn'));
});
test.afterEach(() => {
  global.fetch = originalFetch;
  Date.now = originalClock;
  AGENCY_CONFIGS.mn.feedRequestsForRoute = originalRequests;
  if (originalKey === undefined) delete process.env.MTA_BUS_TIME_API_KEY;
  else process.env.MTA_BUS_TIME_API_KEY = originalKey;
});
const respond = (message) => { global.fetch = async () => new Response(transit_realtime.FeedMessage.encode(message).finish()); };

test('route metadata preserves service identity/source age and suppresses NO_DATA or skipped event times', async () => {
  respond({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000 - 120 }, entity: [{ id: 'one', tripUpdate: {
    trip: { tripId: 'M15-N-1', routeId: 'M15', startDate: '20261122', startTime: '09:00:00' }, timestamp: NOW / 1000,
    stopTimeUpdate: [
      { stopId: '403', stopSequence: 1, scheduleRelationship: 2, arrival: { time: NOW / 1000 + 300, delay: 0 } },
      { stopId: '404', stopSequence: 2, scheduleRelationship: 1, arrival: { time: NOW / 1000 + 600 } },
      { stopId: '403', stopSequence: 3, arrival: { delay: 60 } },
    ],
  } }] });
  const status = await getRouteStatus('mn', 'M15');
  const trip = status.trips[0];
  assert.equal(trip.serviceDate, '20261122');
  assert.equal(trip.startTime, '09:00:00');
  assert.equal(trip.freshness, 'stale');
  assert.equal(trip.observedAt, NOW - 120_000);
  assert.equal(trip.expiresAt, NOW - 30_000);
  assert.deepEqual(trip.stops.map((stop) => stop.scheduledTime), [null, null, null]);
  assert.deepEqual(trip.stops.map((stop) => stop.delaySeconds), [null, null, 60]);
});

test('a differential feed cannot replace a route snapshot', async () => {
  respond({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000, incrementality: 1 }, entity: [{ id: 'one', tripUpdate: { trip: { tripId: 'M15-N-1', routeId: 'M15' }, stopTimeUpdate: [] } }] });
  assert.deepEqual((await getRouteStatus('mn', 'M15')).trips, []);
});

test('deleted entities are ignored rather than resurfacing as live trips', async () => {
  respond({ header: { gtfsRealtimeVersion: '2.0', timestamp: NOW / 1000 }, entity: [{ id: 'one', isDeleted: true, tripUpdate: { trip: { tripId: 'M15-N-1', routeId: 'M15' }, stopTimeUpdate: [] } }] });
  assert.deepEqual((await getRouteStatus('mn', 'M15')).trips, []);
});
