const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getStopPredictions } = require('../lib/gtfsSchedule');
const { gtfsServiceDaysFor } = require('../lib/gtfsServiceTime');
const { resetGtfsStaticDataForTests, setAgencyDataForTests } = require('../lib/gtfsStaticData');

let fixtureDir;
function timetable(departure, dates, { weekdays = [0, 0, 0, 0, 0, 0, 0], exceptions } = {}) {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-schedule-clock-'));
  fs.writeFileSync(path.join(fixtureDir, 'routes.txt'), 'route_id,route_short_name,route_long_name\nR,R,Clock fixture\n');
  fs.writeFileSync(path.join(fixtureDir, 'stops.txt'), 'stop_id,stop_name,stop_lat,stop_lon\nS1,Start,40.7,-73.9\nS2,End,40.8,-73.9\n');
  fs.writeFileSync(path.join(fixtureDir, 'trips.txt'), 'trip_id,route_id,service_id,direction_id,trip_headsign\nT,R,S,0,End\n');
  fs.writeFileSync(path.join(fixtureDir, 'stop_times.txt'),
    'trip_id,stop_id,arrival_time,departure_time,stop_sequence\n' + ['S1', 'S2'].map((id, index) => ['T', id, departure, departure, index + 1].join(',')).join('\n') + '\n');
  fs.writeFileSync(path.join(fixtureDir, 'calendar.txt'),
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,' + weekdays.join(',') + ',20200101,20991231\n');
  fs.writeFileSync(path.join(fixtureDir, 'calendar_dates.txt'), 'service_id,date,exception_type\n'
    + (exceptions ?? dates.map((date) => [date, 1])).map(([date, kind]) => ['S', date, kind].join(',')).join('\n') + '\n');
  setAgencyDataForTests('mn', fixtureDir);
}
const predictions = (trips = [], limit = 1) => getStopPredictions('mn', 'R', 'S1', 'S1', trips, limit);
const live = (at, delaySeconds = null) => ({
  tripId: 'T', directionId: 0, peakOffpeak: null,
  stops: [{ stopId: 'S1', stopName: 'Start', lat: 40.7, lon: -73.9, sequence: 1, scheduledTime: at, delaySeconds }],
});

test.beforeEach(() => resetGtfsStaticDataForTests());
test.afterEach(() => {
  resetGtfsStaticDataForTests();
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

const cases = [
  ['spring before transition', '2026-03-08T05:30:00Z', '20260308', '03:30:00', 120],
  ['spring after transition', '2026-03-08T07:10:00Z', '20260308', '03:30:00', 20],
  ['fall before transition', '2026-11-01T04:30:00Z', '20261101', '03:30:00', 240],
  ['first repeated fall hour', '2026-11-01T05:10:00Z', '20261101', '01:30:00', 80],
  ['second repeated fall hour', '2026-11-01T06:10:00Z', '20261101', '01:30:00', 20],
  ['fall after transition', '2026-11-01T07:10:00Z', '20261101', '03:30:00', 80],
  ['previous fall service past 24h', '2026-11-01T06:00:00Z', '20261031', '26:30:00', 30],
  ['previous spring service past 24h', '2026-03-08T05:00:00Z', '20260307', '25:30:00', 90],
  ['next spring service begins before civil midnight', '2026-03-08T04:30:00Z', '20260308', '00:45:00', 15],
  ['next fall service has a 25h boundary', '2026-11-01T03:30:00Z', '20261101', '00:00:00', 90],
];
for (const [label, now, serviceDate, departure, expected] of cases) {
  test('scheduled countdown uses GTFS elapsed service time: ' + label, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    timetable(departure, [serviceDate]);
    const result = await predictions();
    assert.equal(result.towardDirection0[0]?.minutes, expected);
    assert.equal(result.towardDirection0[0]?.live, false);
  });
}

for (const [label, now, serviceDate, departure, event] of [
  ['spring before', '2026-03-08T05:30:00Z', '20260308', '03:30:00', '2026-03-08T07:37:00Z'],
  ['spring after', '2026-03-08T07:10:00Z', '20260308', '03:30:00', '2026-03-08T07:37:00Z'],
  ['fall before', '2026-11-01T04:30:00Z', '20261101', '03:30:00', '2026-11-01T08:37:00Z'],
  ['fall after', '2026-11-01T07:10:00Z', '20261101', '03:30:00', '2026-11-01T08:37:00Z'],
  ['previous overnight service', '2026-11-01T06:00:00Z', '20261031', '26:30:00', '2026-11-01T06:37:00Z'],
]) {
  test('live delay comparison uses the correct service anchor: ' + label, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
    timetable(departure, [serviceDate]);
    const result = await predictions([live(event)]);
    assert.equal(result.towardDirection0[0].live, true);
    assert.equal(result.towardDirection0[0].delayMinutes, 7);
  });
}

test('calendar-date additions and removals apply to the departure service date, including overnight', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-01T06:00:00Z') });
  // Every weekday is active, but Saturday is specifically removed. Sunday 26:30 is tomorrow,
  // so it must not masquerade as the removed Saturday's 30-minute departure.
  timetable('26:30:00', [], { weekdays: [1, 1, 1, 1, 1, 1, 1], exceptions: [['20261031', 2]] });
  const result = await predictions();
  assert.equal(result.towardDirection0.some((entry) => entry.minutes === 30), false);
  // A live event for a non-running service must not get a fabricated timetable delay.
  const inactive = await predictions([live('2026-11-01T06:37:00Z')]);
  assert.equal(inactive.towardDirection0[0].delayMinutes, null);
});

test('an existing live trip only deduplicates its own run, leaving the same trip ID on the next service date', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-15T13:00:00Z') });
  timetable('09:20:00', ['20261015', '20261016']);
  const result = await predictions([live('2026-10-15T13:27:00Z')], 6);
  assert.deepEqual(result.towardDirection0.map((entry) => [entry.live, entry.minutes]), [[true, 27], [false, 1460]]);
});

test('selected-trip matching shares independent noon anchors before both DST transitions', () => {
  const spring = gtfsServiceDaysFor(Date.parse('2026-03-08T05:30:00Z'));
  assert.equal(new Date(spring[0].startMs).toISOString(), '2026-03-08T04:00:00.000Z');
  assert.equal(spring[0].seconds, 90 * 60);
  assert.equal(new Date(spring[1].startMs).toISOString(), '2026-03-07T05:00:00.000Z');
  const fall = gtfsServiceDaysFor(Date.parse('2026-11-01T04:30:00Z'));
  assert.equal(new Date(fall[0].startMs).toISOString(), '2026-11-01T05:00:00.000Z');
  assert.equal(fall[0].seconds, -30 * 60);
  assert.equal(new Date(fall[1].startMs).toISOString(), '2026-10-31T04:00:00.000Z');
  // The next service day is relevant before spring's civil midnight as well.
  const eve = gtfsServiceDaysFor(Date.parse('2026-03-08T04:30:00Z'));
  assert.equal(eve[2].dateKey, '20260308');
  assert.equal(eve[2].seconds, 30 * 60);
});

test('service labels and weekday rollovers use the Eastern calendar, independent of server timezone', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    const days = gtfsServiceDaysFor(Date.parse('2027-01-01T04:30:00Z'));
    assert.deepEqual(days.map((day) => [day.dateKey, day.dayOfWeek]), [['20261231', 4], ['20261230', 3], ['20270101', 5]]);
    assert.equal(new Date(days[0].startMs).toISOString(), '2026-12-31T05:00:00.000Z');
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});
