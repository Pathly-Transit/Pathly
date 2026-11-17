const assert = require('node:assert/strict');
const test = require('node:test');

const { TransitRouter } = require('../lib/transitRouter');
const { serviceDaysAround } = require('../lib/tripPlanner');
const { buildTestNetwork, stopIndex, wednesdayAt } = require('./helpers/routingFeeds');

const ALL_MODES = new Set(['subway', 'bus', 'rail', 'ferry', 'other']);
let network;
let router;
test.before(async () => {
  network = await buildTestNetwork();
  router = new TransitRouter(network, 6);
});

/** Plans from `from` to `to` (feed stop ids, no walking either end) leaving or arriving at a New York time. */
function plan({ from, to, at, arriveBy = false, options = {} }) {
  const { baseStartMs, days } = serviceDaysAround(at);
  const time = Math.round((at - baseStartMs) / 1000);
  const access = [{ stop: stopIndex(network, from), seconds: 0 }];
  const egress = [{ stop: stopIndex(network, to), seconds: 0 }];
  const search = { days, maxRounds: 6, modes: ALL_MODES, horizonSeconds: 18 * 3600, ...options };
  const active = network.activeServices(days);
  const journeys = arriveBy ? router.backward(time, access, egress, search, active) : router.forward(time, access, egress, search, active);
  const clock = (seconds) => new Date(baseStartMs + seconds * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return journeys.map((journey) => ({
    ...journey,
    summary: journey.legs.map((leg) => (leg.kind === 'ride'
      ? `${network.routes[network.patternRoute[leg.pattern]].shortName} ${network.stopId(leg.boardStop)} ${clock(leg.departs)}-${network.stopId(leg.alightStop)} ${clock(leg.arrives)}`
      : leg.from !== null && leg.to !== null ? `walk ${network.stopId(leg.from)}-${network.stopId(leg.to)}` : 'walk')).join(' | '),
  }));
}

test('the express beats the local where both go, and only the local serves the stops between', () => {
  const [express] = plan({ from: 'A1', to: 'A4', at: wednesdayAt(8, 0) });
  assert.equal(express.summary, 'walk | X A1 8:05 AM-A4 8:11 AM | walk');
  const [local] = plan({ from: 'A2', to: 'A4', at: wednesdayAt(8, 0) });
  assert.equal(local.summary, 'walk | A A2 8:04 AM-A4 8:12 AM | walk');
  // The express lets nobody off before A4.
  const [toA3] = plan({ from: 'A1', to: 'A3', at: wednesdayAt(8, 1) });
  assert.equal(toA3.summary, 'walk | A A1 8:10 AM-A3 8:18 AM | walk');
});

test('a change between agencies walks to the nearby stop and waits for the next bus', () => {
  const journeys = plan({ from: 'A1', to: 'B3', at: wednesdayAt(8, 0) });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].summary, 'walk | A A1 8:00 AM-A3 8:08 AM | walk A3-B1 | n1 B1 8:15 AM-B3 8:25 AM | walk');
  assert.equal(journeys[0].rides, 2);
  const walk = journeys[0].legs[2];
  // About 250 m stretched for the streets, the time to spare, and the stairs up from the platform.
  assert.ok(walk.seconds > 250 && walk.seconds < 400, `${walk.seconds} s`);
});

test('arriving by a time leaves as late as possible', () => {
  const [journey] = plan({ from: 'A1', to: 'B3', at: wednesdayAt(8, 40), arriveBy: true });
  assert.equal(journey.summary, 'walk | A A1 8:10 AM-A3 8:18 AM | walk A3-B1 | n1 B1 8:30 AM-B3 8:40 AM | walk');
  const [direct] = plan({ from: 'A1', to: 'A4', at: wednesdayAt(8, 45), arriveBy: true });
  assert.equal(direct.summary, 'walk | X A1 8:35 AM-A4 8:41 AM | walk');
});

test("just after midnight, yesterday's late trips still run", () => {
  const [journey] = plan({ from: 'A1', to: 'A4', at: Date.UTC(2026, 10, 19, 5, 20) });
  assert.equal(journey.summary, 'walk | N A1 12:30 AM-A4 12:42 AM | walk');
});

test('a left-out line is never ridden, and with nothing left there is no trip', () => {
  const express = network.routes.findIndex((route) => route.routeId === 'X');
  const [journey] = plan({ from: 'A1', to: 'A4', at: wednesdayAt(8, 0), options: { bannedRoutes: new Set([express]) } });
  assert.equal(journey.summary, 'walk | A A1 8:00 AM-A4 8:12 AM | walk');
  assert.deepEqual(plan({ from: 'A1', to: 'B3', at: wednesdayAt(8, 0), options: { modes: new Set(['subway']) } }), []);
});

test('no trip runs on a day the calendar leaves out', () => {
  assert.deepEqual(plan({ from: 'A1', to: 'A4', at: Date.UTC(2026, 10, 21, 13, 0) }), [], 'a Saturday');
});
