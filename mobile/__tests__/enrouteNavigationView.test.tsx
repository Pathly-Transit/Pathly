import { fireEvent, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ActiveTripNotices } from '../src/components/ActiveTripNotices';
import { EnrouteRecoveryView, TripDemoControls } from '../src/components/EnrouteNavigationView';
import { PlannedTripDetailView, type LiveTripFollow } from '../src/components/PlannedTripDetailView';
import { initialNavigationCursor, normalizeItinerary } from '../src/data/enrouteNavigation';
import { navigationMapProgress } from '../src/data/tripMap';
import type { Itinerary, LatLng, TransitStep, WalkStep } from '../src/data/tripPlanning';
import type { RideTracking } from '../src/data/rideTracking';
import { AppSettingsProvider } from '../src/theme/AppSettings';

// The trip's vehicles come from the backend; none here.
jest.mock('../src/lib/firebase', () => ({ callable: () => () => Promise.resolve({ data: { vehicles: [] } }) }));

const baseTime = Date.UTC(2026, 9, 15, 13);
const at = (minutes: number) => new Date(baseTime + minutes * 60_000).toISOString();
const point = (latOffset: number): LatLng => ({ lat: 40.7 + latOffset, lng: -73.9 });
const stop = (name: string, location: LatLng, minute: number) => ({ name, location, time: at(minute) });

const walk = (toName: string, path: LatLng[], minutes = 5): WalkStep => ({
  kind: 'walk',
  distanceMeters: minutes * 80,
  durationSeconds: minutes * 60,
  path,
  toName,
});

const transit = (
  name: string,
  fromPoint: LatLng,
  toPoint: LatLng,
  fromMinute: number,
  toMinute: number,
  intermediate?: { name: string; point: LatLng; minute: number }[],
): TransitStep => ({
  agency: { name: 'Demo Transit' },
  durationSeconds: (toMinute - fromMinute) * 60,
  from: stop(`${name} origin`, fromPoint, fromMinute),
  headsign: `Downtown via ${name}`,
  kind: 'transit',
  line: { color: '#2457C5', name, shortName: name },
  mode: 'bus',
  path: [fromPoint, ...(intermediate ?? []).map((item) => item.point), toPoint],
  stopCount: (intermediate?.length ?? 0) + 1,
  ...(intermediate ? { stops: intermediate.map((item) => stop(item.name, item.point, item.minute)) } : {}),
  to: stop(`${name} terminal`, toPoint, toMinute),
});

const origin = point(0);
const boardOne = point(0.001);
const knownStop = point(0.003);
const transfer = point(0.005);
const boardTwo = point(0.006);
const alightTwo = point(0.01);
const destination = point(0.011);

const itinerary: Itinerary = {
  arrivalTime: at(45),
  departureTime: at(0),
  durationSeconds: 45 * 60,
  id: 'component-test-trip',
  steps: [
    walk('10 origin', [origin, boardOne]),
    transit('10', boardOne, transfer, 5, 20, [{ minute: 12, name: 'First Street', point: knownStop }]),
    walk('20 origin', [transfer, boardTwo], 4),
    transit('20', boardTwo, alightTwo, 25, 40),
    walk('Demo destination', [alightTwo, destination], 5),
  ],
  transfers: 1,
};

const plan = normalizeItinerary(itinerary);

const safeAreaMetrics = {
  frame: { height: 844, width: 390, x: 0, y: 0 },
  insets: { bottom: 34, left: 0, right: 0, top: 47 },
};

function TestProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <AppSettingsProvider initialReducedMotion={true}>{children}</AppSettingsProvider>
    </SafeAreaProvider>
  );
}

const sharing = (dismiss = jest.fn()): RideTracking => ({ ridingTripId: 'bus-1', sharingEnabled: true, claim: jest.fn(), dismiss });

function liveFollow(overrides: Partial<LiveTripFollow> = {}): LiveTripFollow {
  return {
    progress: navigationMapProgress(plan, initialNavigationCursor(plan, baseTime)),
    followLocation: null,
    userLocation: origin,
    userLocationStale: false,
    hurry: null,
    rideFix: null,
    ...overrides,
  };
}

describe('the live trip on Trip Details', () => {
  function renderLive(live: LiveTripFollow, onEnd = jest.fn()) {
    const screen = render(
      <TestProviders>
        <PlannedTripDetailView
          destination="Demo destination"
          isActive={true}
          isFavorite={false}
          itinerary={itinerary}
          live={live}
          onBack={jest.fn()}
          onEnd={onEnd}
          onStart={jest.fn()}
          onToggleFavorite={jest.fn()}
          origin="Demo origin"
          showFavorite={false}
        />
      </TestProviders>,
    );
    return { onEnd, screen };
  }

  it('turns GO into END, which ends the trip only once confirmed', () => {
    const { onEnd, screen } = renderLive(liveFollow());
    expect(screen.queryByTestId('search-trip-go')).toBeNull();
    fireEvent.press(screen.getByTestId('search-trip-end'));
    fireEvent.press(screen.getByTestId('search-trip-end-confirm-cancel'));
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('search-trip-end'));
    fireEvent.press(screen.getByTestId('search-trip-end-confirm-confirm'));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('follows the rider on the map from the start', () => {
    const { screen } = renderLive(liveFollow({ followLocation: origin }));
    expect(screen.getByTestId('search-trip-location').props.accessibilityState).toMatchObject({ selected: true });
  });

  it('says to hurry and that a ride is shared, above the steps', () => {
    const dismiss = jest.fn();
    const { screen } = renderLive(liveFollow({ hurry: { title: 'Hurry to your stop', body: 'The 10 leaves in 2 min' }, ride: sharing(dismiss) }));
    expect(screen.getByTestId('active-trip-hurry-up')).toBeTruthy();
    expect(screen.getByText('Hurry to your stop')).toBeTruthy();
    fireEvent.press(screen.getByTestId('active-trip-ride-not-on'));
    expect(dismiss).toHaveBeenCalledWith('bus-1');
  });

  it('shows the admin checkpoint stepper only when given one', () => {
    const admin = renderLive(liveFollow({ adminPanel: <TripDemoControls checkpoints={plan.checkpoints} initialIndex={0} onCheckpoint={jest.fn()} onReset={jest.fn()} /> })).screen;
    expect(admin.getByTestId('trip-demo-controls')).toBeTruthy();
    admin.unmount();
    const rider = renderLive(liveFollow()).screen;
    expect(rider.queryByTestId('trip-demo-controls')).toBeNull();
  });
});

describe('ActiveTripNotices', () => {
  it('shows nothing when there is nothing to say', () => {
    const screen = render(<TestProviders><ActiveTripNotices hurry={null} reportTripId={null} rideFix={null} /></TestProviders>);
    expect(screen.queryByTestId('active-trip-notices')).toBeNull();
  });

  it('never claims a shared ride the rider is not sharing', () => {
    const screen = render(<TestProviders><ActiveTripNotices hurry={null} reportTripId={null} ride={{ ...sharing(), ridingTripId: null }} rideFix={null} /></TestProviders>);
    expect(screen.queryByTestId('active-trip-ride-sharing')).toBeNull();
  });
});

describe('TripDemoControls', () => {
  it('lets an admin select, step through, and reset deterministic checkpoints', () => {
    const onCheckpoint = jest.fn();
    const onReset = jest.fn();
    const screen = render(<TestProviders><TripDemoControls checkpoints={plan.checkpoints} initialIndex={0} onCheckpoint={onCheckpoint} onReset={onReset} /></TestProviders>);
    fireEvent.press(screen.getByTestId('trip-demo-checkpoint-2'));
    expect(onCheckpoint).toHaveBeenLastCalledWith(plan.checkpoints[2], 2);
    fireEvent.press(screen.getByTestId('trip-demo-next'));
    expect(onCheckpoint).toHaveBeenLastCalledWith(plan.checkpoints[3], 3);
    fireEvent.press(screen.getByTestId('trip-demo-previous'));
    expect(onCheckpoint).toHaveBeenLastCalledWith(plan.checkpoints[2], 2);
    fireEvent.press(screen.getByTestId('trip-demo-reset'));
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('trip-demo-checkpoint-0').props.accessibilityState).toEqual({ selected: true });
  });
});

describe('EnrouteRecoveryView', () => {
  it('offers Retry and confirmed End without replacing the saved route', () => {
    const onBack = jest.fn();
    const onEnd = jest.fn();
    const onRetry = jest.fn();
    const screen = render(
      <TestProviders>
        <EnrouteRecoveryView destination="Demo destination" onBack={onBack} onEnd={onEnd} onRetry={onRetry} />
      </TestProviders>,
    );

    expect(screen.getByText('We can’t restore the exact route yet')).toBeTruthy();
    fireEvent.press(screen.getByTestId('enroute-recovery-retry'));
    fireEvent.press(screen.getByTestId('enroute-recovery-back'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('enroute-recovery-end'));
    fireEvent.press(screen.getByTestId('enroute-recovery-end-confirm-cancel'));
    expect(onEnd).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('enroute-recovery-end'));
    fireEvent.press(screen.getByTestId('enroute-recovery-end-confirm-confirm'));
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
