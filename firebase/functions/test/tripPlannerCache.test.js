const assert = require('node:assert/strict');
const test = require('node:test');
const staticData = require('../lib/gtfsStaticData');
const { encodeRoutingTimetable } = require('../lib/routingTimetable');
const { planTransitTrip, resetTripPlannerForTests } = require('../lib/tripPlanner');
const { buildTimetable, busFeed, subwayFeed, wednesdayAt } = require('./helpers/routingFeeds');

let files;
test.before(async () => {
  const [subway, nice] = await Promise.all([buildTimetable('subway', subwayFeed()), buildTimetable('nice', busFeed())]);
  files = { subway: encodeRoutingTimetable(subway), nice: encodeRoutingTimetable(nice) };
});
test.beforeEach(() => resetTripPlannerForTests());
test.afterEach(() => resetTripPlannerForTests());

function setup(t) {
  let now = wednesdayAt(7, 55);
  const versions = { subway: 's1', nice: 'b1' };
  const reads = { subway: 0, nice: 0 };
  const unavailable = new Set();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(staticData, 'prepareAgencyStaticData', async () => undefined);
  t.mock.method(staticData, 'isAgencyAvailable', (id) => id in files);
  t.mock.method(staticData, 'agencySnapshotVersion', (id) => versions[id]);
  t.mock.method(staticData, 'readRoutingTimetableFile', async (id) => {
    reads[id] += 1;
    return unavailable.has(id) ? null : files[id];
  });
  const origin = { lat: 40.7195, lng: -73.903 };
  const destination = { lat: 40.72, lng: -73.8795 };
  const plan = () => planTransitTrip({
    request: { origin: { ...origin, label: 'Origin' }, destination: { ...destination, label: 'Destination' }, time: { mode: 'now' }, preference: 'fastest', modes: ['bus'], ferry: false },
    origin, destination, nowMs: now,
  });
  return { versions, reads, unavailable, plan, tick: () => { now += 5_001; } };
}

test('retries a missing agency without rereading successful ones, then caches the complete network', async (t) => {
  const fixture = setup(t);
  fixture.unavailable.add('nice');
  assert.deepEqual(await fixture.plan(), []);
  fixture.unavailable.delete('nice');
  assert.deepEqual(await fixture.plan(), []); // Failure backoff bounds repeated upstream work.
  fixture.tick();
  assert.ok((await fixture.plan()).length > 0, 'recovered bus agency is included');
  assert.deepEqual(fixture.reads, { subway: 1, nice: 2 });
  await fixture.plan();
  assert.deepEqual(fixture.reads, { subway: 1, nice: 2 });
});

test('keeps the last good agency during a failed newer snapshot, then adopts its recovery', async (t) => {
  const fixture = setup(t);
  assert.ok((await fixture.plan()).length > 0);
  fixture.versions.nice = 'b2';
  fixture.unavailable.add('nice');
  assert.ok((await fixture.plan()).length > 0, 'last good bus timetable remains usable');
  fixture.unavailable.delete('nice');
  fixture.tick();
  assert.ok((await fixture.plan()).length > 0);
  assert.deepEqual(fixture.reads, { subway: 1, nice: 3 });
  await fixture.plan();
  assert.deepEqual(fixture.reads, { subway: 1, nice: 3 });
});

test('coalesces simultaneous cold network requests', async (t) => {
  const fixture = setup(t);
  const plans = await Promise.all([fixture.plan(), fixture.plan(), fixture.plan()]);
  assert.ok(plans.every((entries) => entries.length > 0));
  assert.deepEqual(fixture.reads, { subway: 1, nice: 1 });
});
