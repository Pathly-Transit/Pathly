import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { RideGuideView, type RideGuideLiveTrip } from '../src/components/RideGuideView';
import { retimeItinerary } from '../src/data/tripDepartures';
import { rideAlerts, rideGuideItinerary, ridePath, rideStopTimes, type RideGuideRequest } from '../src/data/rideGuide';
import { formatTripClock, type TransitStep } from '../src/data/tripPlanning';
import { projectTripTiming, type TripTimingProjection } from '../src/data/tripTiming';
import { nativeRun } from './fixtures/nativeJourney';
import { UserPreferencesProvider } from '../src/data/userPreferences';
import { AppSettingsProvider } from '../src/theme/AppSettings';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

const NOW = Date.parse('2026-11-04T14:00:00Z');

const request = (overrides: Partial<RideGuideRequest> = {}): RideGuideRequest => ({
  routeId: 'suffolk:51',
  directionIndex: 0,
  agency: 'Suffolk County Transit',
  agencyId: 'suffolk',
  routeIdAtAgency: '51',
  directionId: 0,
  mode: 'bus',
  routeName: 'Route 51',
  shortName: '51',
  color: '#C43D4B',
  headsign: 'Port Jefferson',
  stops: [
    { name: 'Main St', stopId: 'a', lat: 40.8, lon: -73.1, offsetMinutes: 10 },
    { name: 'Elm Ave', stopId: 'b', lat: 40.81, lon: -73.1, offsetMinutes: 14 },
    { name: 'Oak Rd', stopId: 'c', lat: 40.82, lon: -73.1, offsetMinutes: 19 },
    { name: 'Harbor', stopId: 'd', lat: 40.83, lon: -73.1, offsetMinutes: 30 },
  ],
  departures: [{ minutes: 6, live: true, delayMinutes: 0 }, { minutes: 26, live: false }, { minutes: 46, live: false }],
  selectedDeparture: 0,
  walk: { minutes: 3, path: [{ lat: 40.799, lon: -73.101 }, { lat: 40.8, lon: -73.1 }] },
  notices: [
    { kind: 'delay', label: 'Running late', warning: true, title: 'Bus in 6 min is running 4 min late', detail: null },
    { kind: 'alert', label: 'Detour in effect', warning: true, title: 'Detour on Main St', detail: 'Buses use Elm Ave.' },
    { kind: 'outlook', label: 'Thanksgiving, Nov 26', warning: false, title: 'Thanksgiving is Thursday', detail: null },
  ],
  capturedAt: NOW,
  ...overrides,
});

const ride = (itinerary: ReturnType<typeof rideGuideItinerary>) => itinerary!.steps.find((step): step is TransitStep => step.kind === 'transit')!;

describe('rideGuideItinerary', () => {
  it('rides the one line from the rider\'s stop to the picked one, after the walk there', () => {
    const itinerary = rideGuideItinerary(request(), 2)!;
    expect(itinerary.steps.map((step) => step.kind)).toEqual(['walk', 'transit']);
    const leg = ride(itinerary);
    expect(leg.from).toMatchObject({ name: 'Main St', time: new Date(NOW + 6 * 60_000).toISOString() });
    // Oak Rd is 9 minutes on from Main St.
    expect(leg.to).toMatchObject({ name: 'Oak Rd', time: new Date(NOW + 15 * 60_000).toISOString() });
    expect(leg.stops?.map((stop) => stop.name)).toEqual(['Elm Ave']);
    expect(leg.stopCount).toBe(2);
    expect(leg.liveRoute).toEqual({ agencyId: 'suffolk', routeId: '51', boardStopId: 'a', alightStopId: 'c', directionId: 0 });
    expect(leg.live).toEqual({ status: 'tracked', delaySeconds: 0 });
    // Leaving means setting off on the walk: 3 minutes before the bus.
    expect(itinerary.departureTime).toBe(new Date(NOW + 3 * 60_000).toISOString());
    expect(itinerary.arrivalTime).toBe(leg.to.time);
    expect(itinerary.transfers).toBe(0);
  });

  it('offers every departure, each timed to the picked stop', () => {
    const leg = ride(rideGuideItinerary(request({ selectedDeparture: 1 }), 3));
    expect(leg.from.time).toBe(new Date(NOW + 26 * 60_000).toISOString());
    expect(leg.live).toBeUndefined();
    expect(leg.departures).toHaveLength(3);
    expect(leg.departures![2]).toEqual({
      departs: new Date(NOW + 46 * 60_000).toISOString(),
      arrives: new Date(NOW + 66 * 60_000).toISOString(),
      stopTimes: [new Date(NOW + 50 * 60_000).toISOString(), new Date(NOW + 55 * 60_000).toISOString()],
    });
  });

  it('leaves the delays to the departure, and keeps the alerts and what\'s coming up', () => {
    const alerts = rideAlerts(request().notices);
    expect(alerts.map((alert) => alert.label)).toEqual(['Detour in effect', 'Thanksgiving, Nov 26']);
    expect(alerts[1]).toMatchObject({ warning: false, upcoming: true });
    expect(ride(rideGuideItinerary(request(), 1)).alerts).toEqual(alerts);
  });

  it('goes without a walk when there is none, and with nothing to ride there is no trip', () => {
    expect(rideGuideItinerary(request({ walk: null }), 1)!.steps.map((step) => step.kind)).toEqual(['transit']);
    expect(rideGuideItinerary(request({ departures: [] }), 1)).toBeNull();
    expect(rideGuideItinerary(request({ stops: request().stops.slice(0, 1) }), 1)).toBeNull();
  });

  it('follows the line\'s drawn shape between the two stops', () => {
    const stops = request().stops.slice(0, 3);
    const shape = [{ lat: 40.79, lon: -73.1 }, { lat: 40.8, lon: -73.1 }, { lat: 40.805, lon: -73.11 }, { lat: 40.82, lon: -73.1 }, { lat: 40.9, lon: -73.1 }];
    expect(ridePath(stops, shape)).toEqual([
      { lat: 40.8, lng: -73.1 }, { lat: 40.8, lng: -73.1 }, { lat: 40.805, lng: -73.11 }, { lat: 40.82, lng: -73.1 }, { lat: 40.82, lng: -73.1 },
    ]);
    expect(ridePath(stops, undefined)).toEqual(stops.map((stop) => ({ lat: stop.lat, lng: stop.lon })));
  });

  it('times every stop after the rider\'s for the picker', () => {
    const departs = new Date(NOW + 6 * 60_000).toISOString();
    expect(rideStopTimes(request(), departs).map(({ index, stop, arrives }) => [index, stop.name, arrives])).toEqual([
      [1, 'Elm Ave', new Date(NOW + 10 * 60_000).toISOString()],
      [2, 'Oak Rd', new Date(NOW + 15 * 60_000).toISOString()],
      [3, 'Harbor', new Date(NOW + 26 * 60_000).toISOString()],
    ]);
  });
});

describe('RideGuideView', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => jest.useRealTimers());

  const renderGuide = (onStart = jest.fn(), live: RideGuideLiveTrip | null = null, guide = request(), timing: TripTimingProjection | null = null) => render(
    <AppSettingsProvider>
      <UserPreferencesProvider>
        <RideGuideView live={live} onBack={jest.fn()} onEnd={jest.fn()} onStart={onStart} request={guide} riderLocation={null} timing={timing} />
      </UserPreferencesProvider>
    </AppSettingsProvider>,
  );

  it('starts the ride as it opens', () => {
    const onStart = jest.fn();
    renderGuide(onStart);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ arrivalTime: new Date(NOW + 26 * 60_000).toISOString() }), 'Harbor');
  });

  it('shows the live trip with END, and moves it to a newly picked stop', () => {
    const onStart = jest.fn();
    const live: RideGuideLiveTrip = {
      itinerary: retimeItinerary(rideGuideItinerary(request(), 3)!, new Map(), NOW),
      guidance: { phase: 'walking', currentAction: 'Walk to Main St', nextAction: 'Board Q1 toward Harbor', remainingStops: null } as RideGuideLiveTrip['guidance'],
    };
    renderGuide(onStart, live);
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.queryByTestId('ride-guide-go')).toBeNull();
    expect(screen.getByTestId('ride-guide-end')).toBeTruthy();
    fireEvent.press(screen.getByTestId('ride-guide-stop-picker'));
    fireEvent.press(screen.getByTestId('ride-guide-stop-2'));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ arrivalTime: new Date(NOW + 15 * 60_000).toISOString() }), 'Oak Rd');
  });

  it('reads like Trip Details for the one ride, and starts it to the stop picked', () => {
    const onStart = jest.fn();
    renderGuide(onStart);
    onStart.mockClear();
    expect(screen.getByTestId('ride-guide-leave-within')).toHaveTextContent(/Leave within 3 min to catch the /);
    expect(screen.getByTestId('ride-guide-leave-time')).toHaveTextContent(formatTripClock(new Date(NOW + 3 * 60_000).toISOString()));
    expect(screen.getByTestId('ride-guide-alerts-0')).toHaveTextContent(/Detour in effect/);
    // The end of the line until the rider picks, already in the picker; the stops wait in a popup.
    expect(screen.getByTestId('ride-guide-stop-picked')).toHaveTextContent('Harbor');
    expect(screen.getByTestId('ride-guide-arrival')).toBeTruthy();
    expect(screen.queryByTestId('ride-guide-stops')).toBeNull();
    fireEvent.press(screen.getByTestId('ride-guide-stop-picker'));
    expect(screen.getByTestId('ride-guide-stop-3').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('ride-guide-arrive-time')).toHaveTextContent(formatTripClock(new Date(NOW + 26 * 60_000).toISOString()));

    fireEvent.press(screen.getByTestId('ride-guide-stop-2'));
    // Picking closes the popup, and the page shows the stop picked.
    expect(screen.queryByTestId('ride-guide-stops')).toBeNull();
    expect(screen.getByTestId('ride-guide-stop-picked')).toHaveTextContent('Oak Rd');
    expect(screen.getByTestId('ride-guide-arrive-time')).toHaveTextContent(formatTripClock(new Date(NOW + 15 * 60_000).toISOString()));
    expect(within(screen.getByTestId('ride-guide-step-0')).getByText('Oak Rd')).toBeTruthy();

    fireEvent.press(screen.getByTestId('ride-guide-go'));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ arrivalTime: new Date(NOW + 15 * 60_000).toISOString() }), 'Oak Rd');
  });

  it('moves the stop times with a later departure picked', () => {
    renderGuide();
    const later = new Date(NOW + 26 * 60_000).toISOString();
    fireEvent.press(screen.getByTestId(`ride-guide-departure-0-${later}`));
    fireEvent.press(screen.getByTestId('ride-guide-stop-picker'));
    expect(screen.getByTestId('ride-guide-stop-time-1')).toHaveTextContent(formatTripClock(new Date(NOW + 30 * 60_000).toISOString()));
    expect(screen.queryByTestId('ride-guide-favorite')).toBeNull();
  });

  const canonicalRide = () => {
    const guide = request({ departures: [{ minutes: 6, live: true, tripId: 'bus-a', serviceDate: '20261104', stopId: 'a', directionId: 0, departureTime: new Date(NOW + 6 * 60_000).toISOString() }] });
    const provisional = rideGuideItinerary(guide, 3)!;
    const leg = ride(provisional);
    const ref = nativeRun({ serviceDate: '20261104', alightStopId: 'd' });
    const itinerary = { ...provisional, departureTime: new Date(NOW - 60_000).toISOString(), arrivalTime: new Date(NOW + 22 * 60_000).toISOString(),
      steps: provisional.steps.map((step) => step === leg ? { ...leg, tripId: ref.tripId, runRef: ref,
        from: { ...leg.from, time: new Date(NOW + 2 * 60_000).toISOString() }, to: { ...leg.to, time: new Date(NOW + 22 * 60_000).toISOString() } } : step) };
    const live = { itinerary, guidance: { phase: 'walking', currentAction: 'Walk to Main St', nextAction: 'Board 51', remainingStops: null } as RideGuideLiveTrip['guidance'] };
    return { guide, live, ref };
  };

  it('keeps the canonical selected run across past-departure clock ticks without restarting its provisional estimate', async () => {
    const { guide, live } = canonicalRide();
    const onStart = jest.fn();
    renderGuide(onStart, live, guide);
    await act(async () => { jest.advanceTimersByTime(10 * 60_000); });
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByTestId('ride-guide-arrive-time')).toHaveTextContent(formatTripClock(live.itinerary.arrivalTime));
  });

  it('changes an explicit canonical alighting choice once without restarting on subsequent clock ticks', async () => {
    const { guide, live } = canonicalRide();
    const onStart = jest.fn();
    renderGuide(onStart, live, guide);
    fireEvent.press(screen.getByTestId('ride-guide-stop-picker'));
    fireEvent.press(screen.getByTestId('ride-guide-stop-2'));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(ride(onStart.mock.calls[0]![0]).runSeed).toMatchObject({ tripId: 'bus-a', alightStopId: 'c' });
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('renders the shared exact-run live projection while preserving the canonical selection', () => {
    const { guide, live, ref } = canonicalRide();
    const arrival = new Date(NOW + 42 * 60_000).toISOString();
    const timing = projectTripTiming(live.itinerary, { version: 1, fetchedAt: NOW, legs: [{ legKey: '1', runRef: ref,
      state: 'fresh', status: 'predicted', observedAt: NOW, expiresAt: NOW + 90_000,
      departs: new Date(NOW + 22 * 60_000).toISOString(), arrives: arrival }] }, NOW);
    const onStart = jest.fn();
    renderGuide(onStart, live, guide, timing);
    expect(screen.getByTestId('ride-guide-arrive-time')).toHaveTextContent(formatTripClock(arrival));
    expect(onStart).not.toHaveBeenCalled();
    expect(live.itinerary.arrivalTime).toBe(new Date(NOW + 22 * 60_000).toISOString());
  });
});
