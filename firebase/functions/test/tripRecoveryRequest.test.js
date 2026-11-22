const assert = require('node:assert/strict');
const test = require('node:test');
const { requiredPlanTripRequest } = require('../lib');
const data = { origin: { lat: 40.9126, lng: -73.1234, label: 'Origin' }, destination: { lat: 40.7506, lng: -73.9935, label: 'Destination' }, time: { mode: 'now' }, preference: 'fastest', modes: ['rail'] };
const ref = { version: 1, agencyId: 'lirr', routeId: '10', tripId: 'scheduled-trip', serviceDate: '20261118', scheduleVersion: `routing-v1:${'a'.repeat(64)}`, startTime: '08:00:00', boardStopId: '14', alightStopId: '237', boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 10, alightStopSequence: 70, directionId: 1 };

test('normal planning has no recovery side effects while triggered recovery preserves exact bounded run refs', () => {
  assert.equal(requiredPlanTripRequest(data).recovery, undefined);
  const recovery = { excludedRuns: [ref], preferredRoute: { agencyId: 'lirr', routeId: '10' }, incomingRun: ref };
  assert.deepEqual(requiredPlanTripRequest({ ...data, recovery }).recovery, recovery);
  assert.deepEqual(requiredPlanTripRequest({ ...data, recovery: { excludedRuns: [] } }).recovery, { excludedRuns: [] });
});

test('rejects oversized, malformed and arrival-mode recovery before planner/provider work', () => {
  for (const recovery of [null, [], { excludedRuns: 'all' }, { excludedRuns: Array(13).fill(ref) }, { excludedRuns: [{ ...ref, boardOccurrence: -1 }] }, { excludedRuns: [], preferredRoute: { agencyId: 'unknown', routeId: '10' } }, { excludedRuns: [], incomingRun: null }, { excludedRuns: [], incomingRun: { ...ref, alightOccurrence: -1 } }]) {
    assert.throws(() => requiredPlanTripRequest({ ...data, recovery }), (error) => error.code === 'invalid-argument');
  }
  assert.throws(() => requiredPlanTripRequest({ ...data, time: { mode: 'arrive', at: new Date(Date.now() + 3600_000).toISOString() }, recovery: { excludedRuns: [] } }), (error) => error.code === 'invalid-argument');
});
