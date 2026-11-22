const assert = require('node:assert/strict');
const test = require('node:test');
const { TransitNetwork } = require('../lib/transitNetwork');
const { planTransitTrip, resetTripPlannerForTests, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { scheduleVersionForTimetable } = require('../lib/tripRunSchedule');
const { buildTimetable, busFeed, stopIndex, wednesdayAt } = require('./helpers/routingFeeds');

test.afterEach(() => resetTripPlannerForTests());
async function fixture({ held = false, walking = false } = {}) {
  const files = busFeed();
  files['routes.txt'] = 'route_id,agency_id,route_short_name,route_long_name,route_type\nA,LIBUS,A,Incoming train,2\nC,LIBUS,C,Onward train,2\n';
  files['stops.txt'] = 'stop_id,stop_name,stop_lat,stop_lon\nO,Origin,40.70,-73.90\nP,Alighting,40.74,-73.90\nQ,Walk destination,40.74,-73.899\nD,Destination,40.78,-73.90\n';
  files['trips.txt'] = 'route_id,service_id,trip_id,direction_id\nA,WK,incoming,0\nC,WK,early,0\nC,WK,later,0\n';
  const board = walking ? 'Q' : 'P';
  const early = walking ? '08:07:00' : '08:06:00';
  files['stop_times.txt'] = `trip_id,arrival_time,departure_time,stop_id,stop_sequence\nincoming,08:00:00,08:00:00,O,10\nincoming,08:05:00,08:05:00,P,30\nearly,${early},${early},${board},50\nearly,08:10:00,08:10:00,D,80\nlater,08:09:00,08:09:00,${board},50\nlater,08:13:00,08:13:00,D,80\n`;
  if (held) files['transfers.txt'] = 'from_stop_id,to_stop_id,from_trip_id,to_trip_id,transfer_type\nP,P,incoming,early,1\n';
  const table = await buildTimetable('metronorth', files);
  const network = new TransitNetwork([{ agencyId: 'metronorth', version: 'incoming-fixture', timetable: table }]);
  setTransitNetworkForTests(network);
  const ref = { version: 1, agencyId: 'metronorth', routeId: 'A', tripId: 'incoming', serviceDate: '20261118', scheduleVersion: scheduleVersionForTimetable(table), startTime: '08:00:00', boardStopId: 'O', alightStopId: 'P', boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 10, alightStopSequence: 30, directionId: 0 };
  const origin = { lat: 40.74, lng: -73.9 }, destination = { lat: 40.78, lng: -73.9 };
  const now = wednesdayAt(8, 5);
  const plan = ({ incomingRun = ref, point = origin, at = now, feeds = [] } = {}) => planTransitTrip({ request: { origin: { ...point, label: 'Alighting' }, destination: { ...destination, label: 'Work' }, time: { mode: 'depart', at: new Date(at).toISOString() }, preference: 'fastest', modes: ['rail'], ferry: false, recovery: { excludedRuns: [], preferredRoute: { agencyId: 'metronorth', routeId: 'C' }, ...(incomingRun ? { incomingRun } : {}) } }, origin: point, destination, nowMs: now, recoveryFeedLookup: async () => feeds });
  return { network, ref, plan, now };
}
const ride = (plans) => plans[0]?.steps.find((step) => step.kind === 'transit');

test('an incoming rail ride keeps its180second same-stop change time instead of boarding an immediate train', async () => {
  const { plan } = await fixture();
  assert.equal(ride(await plan({ incomingRun: null })).tripId, 'early', 'a fresh street origin alone cannot represent the previous ride');
  const plans = await plan();
  assert.equal(ride(plans).tripId, 'later');
  assert.equal(ride(plans).minimumTransferSeconds, 180);
  assert.equal(plans[0].steps[0].durationSeconds, 0, 'the transfer margin is not disguised as extra access walking');
});

test('a canonical guaranteed transfer may board sooner with zero extra margin', async () => {
  const { plan } = await fixture({ held: true });
  const first = ride(await plan());
  assert.equal(first.tripId, 'early');
  assert.equal(first.minimumTransferSeconds, 0);
});

test('a guaranteed incoming transfer still targets its correct live-cloned service-date run', async () => {
  const { plan, now } = await fixture({ held: true });
  const feeds = [{ observedAt: now, fetchedAt: now, differential: false, entities: [{ tripUpdate: { trip: { tripId: 'early', routeId: 'C', startDate: '20261118', startTime: '08:06:00', directionId: 0 }, timestamp: now / 1000, stopTimeUpdate: [
    { stopId: 'P', stopSequence: 50, arrival: { time: wednesdayAt(8, 7) / 1000 }, departure: { time: wednesdayAt(8, 7) / 1000 } },
    { stopId: 'D', stopSequence: 80, arrival: { time: wednesdayAt(8, 11) / 1000 }, departure: { time: wednesdayAt(8, 11) / 1000 } },
  ] } }] }];
  const first = ride(await plan({ feeds }));
  assert.equal(first.tripId, 'early');
  assert.equal(first.minimumTransferSeconds, 0);
  assert.equal(first.live.departs, new Date(wednesdayAt(8, 7)).toISOString());
});

test('an incoming different-stop walk includes canonical transfer walking once with no extra rail margin', async () => {
  const { plan, network } = await fixture({ walking: true });
  const plans = await plan();
  const first = ride(plans);
  assert.equal(first.tripId, 'early');
  assert.equal(first.minimumTransferSeconds, 0);
  const from = stopIndex(network, 'P'), to = stopIndex(network, 'Q');
  const slot = [...network.transferTo].findIndex((stop, index) => index >= network.transferStart[from] && index < network.transferStart[from + 1] && stop === to);
  assert.ok(slot >= 0);
  assert.equal(plans[0].steps[0].durationSeconds, network.transferSeconds[slot]);
  assert.ok(plans[0].steps[0].durationSeconds < 180);
});

test('unmatched incoming stops, schedules and earlier alighting claims fail safely before onward planning', async () => {
  const { plan, ref, now } = await fixture();
  for (const change of [{ point: { lat: 40.78, lng: -73.9 } }, { incomingRun: { ...ref, alightStopId: 'D' } }, { incomingRun: { ...ref, scheduleVersion: 'old' } }, { incomingRun: { ...ref, alightStopSequence: 99 } }, { at: now - 60_000 }]) {
    assert.deepEqual(await plan(change), [], JSON.stringify(change));
  }
});
