const assert = require('node:assert/strict');
const test = require('node:test');
const { serviceDaysAround } = require('../lib/tripPlanner');

for (const [at, anchor] of [
  ['2026-03-08T05:30:00Z', '2026-03-08T04:00:00Z'],
  ['2026-03-08T06:30:00Z', '2026-03-08T04:00:00Z'],
  ['2026-03-08T07:30:00Z', '2026-03-08T04:00:00Z'],
  ['2026-11-01T04:30:00Z', '2026-11-01T05:00:00Z'],
  ['2026-11-01T05:30:00Z', '2026-11-01T05:00:00Z'],
  ['2026-11-01T06:30:00Z', '2026-11-01T05:00:00Z'],
]) {
  test(`planner keeps the correct GTFS service anchor at ${at}`, () => {
    assert.equal(serviceDaysAround(Date.parse(at)).baseStartMs, Date.parse(anchor));
  });
}

test('planner day offsets preserve the 23-hour spring service-date boundary', () => {
  const { baseStartMs, days } = serviceDaysAround(Date.parse('2026-03-08T05:30:00Z'));
  assert.deepEqual(days, [
    { date: 20260307, dayOfWeek: 6, offset: -23 * 3600 },
    { date: 20260308, dayOfWeek: 0, offset: 0 },
    { date: 20260309, dayOfWeek: 1, offset: 24 * 3600 },
  ]);
  // Prior-date 26:30 service is 03:30 civil time after the spring change.
  assert.equal(new Date(baseStartMs + (days[0].offset + 26.5 * 3600) * 1000).toISOString(), '2026-03-08T07:30:00.000Z');
});

test('planner day offsets preserve the 25-hour autumn service-date boundary', () => {
  const { baseStartMs, days } = serviceDaysAround(Date.parse('2026-11-01T04:30:00Z'));
  assert.deepEqual(days, [
    { date: 20261031, dayOfWeek: 6, offset: -25 * 3600 },
    { date: 20261101, dayOfWeek: 0, offset: 0 },
    { date: 20261102, dayOfWeek: 1, offset: 24 * 3600 },
  ]);
  // Prior-date 26:30 service falls in the repeated autumn hour.
  assert.equal(new Date(baseStartMs + (days[0].offset + 26.5 * 3600) * 1000).toISOString(), '2026-11-01T06:30:00.000Z');
});

test('planner service calendars retain the previous date across the year boundary', () => {
  const result = serviceDaysAround(Date.parse('2027-01-01T05:30:00Z'));
  assert.equal(result.baseStartMs, Date.parse('2027-01-01T05:00:00Z'));
  assert.deepEqual(result.days, [
    { date: 20261231, dayOfWeek: 4, offset: -86400 },
    { date: 20270101, dayOfWeek: 5, offset: 0 },
    { date: 20270102, dayOfWeek: 6, offset: 86400 },
  ]);
});
