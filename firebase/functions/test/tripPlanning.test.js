const assert = require('node:assert/strict');
const test = require('node:test');

const { itineraryFare, simplifiedPath, walkOnlyItinerary, walkOnlyLimitMeters } = require('../lib/tripPlanning');

const ride = (agency, at) => ({ kind: 'transit', mode: 'bus', agency: { name: agency }, line: { name: '1', shortName: '1' }, from: { name: 'A', location: { lat: 40.7, lng: -73.9 }, time: at }, to: { name: 'B', location: { lat: 40.71, lng: -73.9 }, time: at }, stopCount: 3, durationSeconds: 600, path: [] });

test('a fare carries each discount fare the rules price lower, and nothing prices no rides', () => {
  const estimate = (steps, _departs, rider = 'full') => {
    const cents = { full: 300, reduced: 150, student: 0, college: 300, fairFares: 150 }[rider];
    return { text: `$${(cents / 100).toFixed(2)}`, cents, currency: 'USD', estimated: true, lines: [{ label: rider, text: '' }] };
  };
  const fare = itineraryFare([ride('MTA New York City Transit', '2026-11-18T15:00:00Z')], '2026-11-18T14:55:00Z', estimate);
  assert.equal(fare.cents, 300);
  assert.equal(fare.estimated, true);
  assert.deepEqual(fare.reduced, { text: '$1.50', cents: 150, lines: [{ label: 'reduced', text: '' }] });
  assert.equal(fare.student.cents, 0);
  assert.equal(fare.fairFares.cents, 150);
  assert.equal(fare.college, undefined, 'no cheaper than the full fare');
  assert.equal(itineraryFare([], '2026-11-18T14:55:00Z', estimate), undefined);
  assert.equal(itineraryFare([ride('Hampton Jitney', '2026-11-18T15:00:00Z')], '2026-11-18T14:55:00Z', () => undefined), undefined);
  assert.equal(itineraryFare([ride('MTA New York City Transit', '2026-11-18T15:00:00Z')], '2026-11-18T14:55:00Z'), undefined);
});

test('paths are simplified and rounded for the app', () => {
  const straight = [{ lat: 40.7, lng: -73.9 }, { lat: 40.70001, lng: -73.9 }, { lat: 40.71, lng: -73.9 }];
  assert.deepEqual(simplifiedPath(straight), [{ lat: 40.7, lng: -73.9 }, { lat: 40.71, lng: -73.9 }]);
  const bent = [{ lat: 40.7, lng: -73.9 }, { lat: 40.705, lng: -73.899 }, { lat: 40.71, lng: -73.9 }];
  assert.equal(simplifiedPath(bent).length, 3);
  assert.deepEqual(simplifiedPath([{ lat: 40.7000049, lng: -73.9000051 }]), [{ lat: 40.7, lng: -73.90001 }]);
});

test('walking the whole way is one walk step, timed from the request, and only within the cap', () => {
  const path = [{ lat: 40.75, lng: -73.99 }, { lat: 40.76, lng: -73.98 }];
  const now = Date.parse('2026-10-14T12:00:00Z');
  // 1,560 m at 1.3 m/s is 20 minutes.
  const walk = walkOnlyItinerary({ meters: 1560, path }, { mode: 'now' }, now, 'Bryant Park', 40);
  assert.equal(walk.durationSeconds, 1200);
  assert.equal(walk.departureTime, '2026-10-14T12:00:00.000Z');
  assert.equal(walk.arrivalTime, '2026-10-14T12:20:00.000Z');
  assert.equal(walk.transfers, 0);
  assert.equal(walk.fare, undefined);
  assert.deepEqual(walk.steps.map((step) => [step.kind, step.distanceMeters, step.toName]), [['walk', 1560, 'Bryant Park']]);
  // Arrive by: it leaves early enough to get there on time.
  const arriving = walkOnlyItinerary({ meters: 1560, path }, { mode: 'arrive', at: '2026-10-14T15:00:00.000Z' }, now, 'Bryant Park', 40);
  assert.equal(arriving.departureTime, '2026-10-14T14:40:00.000Z');
  assert.equal(arriving.arrivalTime, '2026-10-14T15:00:00.000Z');
  // Over the rider's cap: not offered.
  assert.equal(walkOnlyItinerary({ meters: 1560, path }, { mode: 'now' }, now, 'Bryant Park', 15), null);
  // The street search never looks past what the cap allows.
  assert.equal(walkOnlyLimitMeters(40), 3120);
});
