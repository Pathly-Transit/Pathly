const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BUS_COLORS } = require('../lib/routeColors');
const { liveTripRefs } = require('../lib/tripLive');
const { chooseJourneys, planTransitTrip, resetTripPlannerForTests, setTransitNetworkForTests } = require('../lib/tripPlanner');
const { setWalkingDataForTests } = require('../lib/walkingGraph');
const { buildTestNetwork, wednesdayAt } = require('./helpers/routingFeeds');

let network;
let noWalkingData;
test.before(async () => {
  network = await buildTestNetwork();
  // Without the street graph, walks are straight lines stretched for the streets.
  noWalkingData = fs.mkdtempSync(path.join(os.tmpdir(), 'pathly-no-walking-'));
  setWalkingDataForTests(noWalkingData);
});
test.beforeEach(() => setTransitNetworkForTests(network));
test.after(() => {
  resetTripPlannerForTests();
  setWalkingDataForTests(null);
  fs.rmSync(noWalkingData, { recursive: true, force: true });
});

// Just south of First Av, and just east of East St.
const NEAR_A1 = { lat: 40.6995, lng: -73.9 };
const NEAR_B3 = { lat: 40.72, lng: -73.8795 };
const request = (time, extra = {}) => ({
  origin: { ...NEAR_A1, label: 'Home' },
  destination: { ...NEAR_B3, label: 'Work' },
  time,
  preference: 'fastest',
  modes: ['subway', 'bus', 'rail'],
  ...extra,
});
const fareStub = (steps) => ({ text: `$${steps.length}.00`, cents: steps.length * 100, currency: 'USD', estimated: true });
const planAt = (time, extra) => planTransitTrip({ request: request(time, extra), origin: NEAR_A1, destination: NEAR_B3, nowMs: wednesdayAt(7, 50), estimateFare: fareStub });

test('an itinerary in the app\'s format: walks, rides with their stops and lines, fares, and live references', async () => {
  const [itinerary, ...rest] = await planAt({ mode: 'depart', at: new Date(wednesdayAt(7, 55)).toISOString() });
  assert.ok(itinerary);
  assert.deepEqual(itinerary.steps.map((step) => step.kind), ['walk', 'transit', 'walk', 'transit', 'walk']);
  const [toStation, subway, change, bus, toWork] = itinerary.steps;

  assert.equal(subway.mode, 'subway');
  assert.deepEqual(subway.agency, { name: 'MTA New York City Transit', url: 'https://www.mta.info' });
  assert.deepEqual(subway.line, { name: 'Avenue Local', shortName: 'A', color: '#FF0000', textColor: '#FFFFFF', vehicleName: 'Subway' });
  assert.equal(subway.headsign, 'Fourth Av');
  assert.deepEqual([subway.from.name, subway.to.name, subway.stopCount], ['First Av', 'Third Av', 2]);
  assert.equal(subway.from.time, new Date(wednesdayAt(8, 0)).toISOString());
  assert.equal(subway.to.time, new Date(wednesdayAt(8, 8)).toISOString());
  assert.deepEqual(subway.stops, [{ name: 'Second Av', location: { lat: 40.71, lng: -73.9 }, time: new Date(wednesdayAt(8, 4)).toISOString() }]);
  assert.equal(subway.tripId, 'A-08:00:00');
  assert.ok(subway.path.length >= 5, 'the line follows its shape, bends included');
  assert.deepEqual(subway.liveRoute, { agencyId: 'subway', routeId: 'A', boardStopId: 'A1', alightStopId: 'A3', directionId: 0 });
  assert.deepEqual(liveTripRefs.get(subway), { agencyId: 'subway', routeId: 'A', tripId: 'A-08:00:00', boardStopId: 'A1', alightStopId: 'A3', directionId: 0, stopIdsBetween: ['A2'] });
  // The same line's other departures between the same stations, this one first.
  assert.equal(subway.departures[0].departs, subway.from.time);
  assert.ok(subway.departures.length > 5);
  assert.deepEqual(subway.departures[1].stopTimes, [new Date(wednesdayAt(8, 14)).toISOString()]);

  assert.equal(bus.mode, 'bus');
  assert.deepEqual(bus.line, { name: 'Crosstown', shortName: 'n1', color: BUS_COLORS.nice, textColor: '#FFFFFF', vehicleName: 'Bus' });
  assert.equal(bus.headsign, 'East St', 'all-caps headsigns read as riders expect');
  assert.equal(bus.from.time, new Date(wednesdayAt(8, 15)).toISOString());

  assert.equal(toStation.toName, 'First Av');
  assert.equal(change.toName, 'West St');
  assert.equal(toWork.toName, 'Work');
  assert.ok(change.distanceMeters > 250 && change.distanceMeters < 400);
  assert.equal(itinerary.departureTime, new Date(wednesdayAt(8, 0) - toStation.durationSeconds * 1000).toISOString());
  assert.equal(itinerary.arrivalTime, new Date(wednesdayAt(8, 25) + toWork.durationSeconds * 1000).toISOString());
  assert.equal(itinerary.durationSeconds, (Date.parse(itinerary.arrivalTime) - Date.parse(itinerary.departureTime)) / 1000);
  assert.equal(itinerary.transfers, 1);
  assert.equal(itinerary.fare.cents, 200);
  assert.match(itinerary.id, /^[0-9a-f]{12}$/);
  // The next departure is offered too.
  assert.ok(rest.some((other) => other.steps[1].from.time === new Date(wednesdayAt(8, 10)).toISOString()));
});

test('arriving by a time gets there in time, leaving as late as possible', async () => {
  const arriveBy = wednesdayAt(8, 45);
  const itineraries = await planAt({ mode: 'arrive', at: new Date(arriveBy).toISOString() });
  assert.ok(itineraries.length > 0);
  assert.ok(itineraries.every((itinerary) => Date.parse(itinerary.arrivalTime) <= arriveBy));
  assert.equal(itineraries[0].steps[3].from.time, new Date(wednesdayAt(8, 30)).toISOString());
});

test('a mode turned off is never ridden, and nowhere near a stop there is no trip', async () => {
  // Without the bus, the subway to Third Av and a long walk is what's left.
  const subwayOnly = await planAt({ mode: 'depart', at: new Date(wednesdayAt(8, 0)).toISOString() }, { modes: ['subway'] });
  assert.ok(subwayOnly.length > 0);
  assert.ok(subwayOnly.every((itinerary) => itinerary.steps.every((step) => step.kind === 'walk' || step.mode === 'subway')));
  const nowhere = { lat: 40.9, lng: -73.5 };
  assert.deepEqual(await planTransitTrip({ request: request({ mode: 'now' }), origin: nowhere, destination: NEAR_B3, nowMs: wednesdayAt(8, 0) }), []);
});

test('an extra ride is offered only when it saves real time or walking', () => {
  const ride = { kind: 'ride' };
  const journey = (departs, arrives, rides, walk) => ({ departs, arrives, rides, legs: [{ kind: 'walk', from: null, to: 1, seconds: walk }, ...Array.from({ length: rides }, (_, index) => ({ ...ride, trip: arrives + index, day: 1, boardStop: index, alightStop: index + 1 }))] });
  const direct = journey(0, 1800, 1, 300);
  const slightlyFaster = journey(0, 1700, 2, 300);
  const muchFaster = journey(0, 1200, 2, 300);
  const lessWalking = journey(0, 1750, 2, 0);
  assert.deepEqual(chooseJourneys([direct, slightlyFaster], false, 0), [direct]);
  assert.deepEqual(chooseJourneys([direct, muchFaster], false, 0), [muchFaster, direct]);
  assert.deepEqual(chooseJourneys([direct, lessWalking], false, 0), [lessWalking, direct]);
  // Far slower than the best isn't offered at all.
  assert.deepEqual(chooseJourneys([muchFaster, journey(0, 6000, 1, 0)], false, 0), [muchFaster]);
});
