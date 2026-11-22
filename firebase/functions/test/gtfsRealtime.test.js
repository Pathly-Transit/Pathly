const assert = require('node:assert/strict');
const test = require('node:test');

const { transit_realtime } = require('gtfs-realtime-bindings');
const { fetchFeedEntities, fetchRealtimeFeed, sourceFreshness, timestampMilliseconds } = require('../lib/gtfsRealtime');

test('route and selected-run consumers share one fetch without renewing source timestamps', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  const body = transit_realtime.FeedMessage.encode({
    header: { gtfsRealtimeVersion: '2.0', timestamp: 1_800_000_000 },
    entity: [{ id: 'one', tripUpdate: { trip: { tripId: 'run' }, timestamp: 1_799_999_990 } }],
  }).finish();
  global.fetch = async () => {
    calls += 1;
    return new Response(body);
  };
  try {
    const url = 'https://example.test/shared-feed';
    const [feed, entities] = await Promise.all([fetchRealtimeFeed(url), fetchFeedEntities(url)]);
    const again = await fetchRealtimeFeed(url);
    assert.equal(calls, 1);
    assert.equal(entities, feed.entities);
    assert.equal(again, feed);
    assert.equal(feed.observedAt, 1_800_000_000_000);
    assert.equal(feed.differential, false);
    assert.equal(sourceFreshness(feed.observedAt, timestampMilliseconds(entities[0].tripUpdate.timestamp), 1_800_000_081_000).state, 'stale');
  } finally {
    global.fetch = originalFetch;
  }
});

test('missing, old, future and independently old trip measurements never become fresh HTTP data', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(sourceFreshness(null, null, now), { state: 'unknown', observedAt: null, expiresAt: null });
  assert.equal(sourceFreshness(now - 90_000, null, now).state, 'stale');
  assert.equal(sourceFreshness(now, now - 91_000, now).state, 'stale');
  assert.equal(sourceFreshness(now - 91_000, now, now).state, 'stale');
  assert.equal(sourceFreshness(now + 30_001, now, now).state, 'unknown');
  assert.equal(sourceFreshness(null, now - 1_000, now).state, 'fresh');
  assert.equal(sourceFreshness(now + 30_000, null, now).state, 'fresh');
  assert.equal(timestampMilliseconds(0), null);
  assert.equal(timestampMilliseconds('invalid'), null);
});

test('retains differential incrementality instead of treating a delta as a full snapshot', async () => {
  const originalFetch = global.fetch;
  const body = transit_realtime.FeedMessage.encode({ header: { gtfsRealtimeVersion: '2.0', incrementality: 1 }, entity: [] }).finish();
  global.fetch = async () => new Response(body);
  try {
    const feed = await fetchRealtimeFeed('https://example.test/differential-feed');
    assert.equal(feed.differential, true);
    assert.equal(feed.observedAt, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('coalesces repeated provider failures instead of retrying once per route', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response('temporarily unavailable', { status: 503 });
  };

  try {
    const feedUrl = 'https://example.test/failed-gtfs-rt';
    await assert.rejects(fetchFeedEntities(feedUrl), /failed: 503/);
    await assert.rejects(fetchFeedEntities(feedUrl), /failed: 503/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
