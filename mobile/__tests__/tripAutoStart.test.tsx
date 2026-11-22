import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { PlannedTripDetailView } from '../src/components/PlannedTripDetailView';
import type { RideFix } from '../src/data/rideDetection';
import { IDLE_WALK, nextWalkFollowState, type WalkFollowState } from '../src/data/tripAutoStart';
import type { Itinerary, LatLng } from '../src/data/tripPlanning';
import { AppSettingsProvider } from '../src/theme/AppSettings';

// The trip's vehicles come from the backend; none here, so only the walk can start a trip.
jest.mock('../src/lib/firebase', () => ({ callable: () => () => Promise.resolve({ data: { vehicles: [] } }) }));

// A straight walk north, about 445 m long.
const start: LatLng = { lat: 40.75, lng: -73.99 };
const end: LatLng = { lat: 40.754, lng: -73.99 };
const path = [start, end];
const METERS_PER_DEGREE_LAT = 111_195;
const at = (meters: number, offEast = 0): LatLng => ({ lat: start.lat + meters / METERS_PER_DEGREE_LAT, lng: start.lng + offEast / 84_300 });
const fix = (point: LatLng, seconds: number, accuracyMeters: number | null = 10): RideFix => ({ at: seconds * 1000, lat: point.lat, lon: point.lng, accuracyMeters });

function walk(fixes: RideFix[]): WalkFollowState {
  return fixes.reduce((state, next) => nextWalkFollowState(state, path, next), IDLE_WALK);
}

describe('telling a rider is already walking their trip', () => {
  it('confirms steady progress away from the start over a minute and 150 m', () => {
    expect(walk([fix(at(0), 0), fix(at(80), 40), fix(at(170), 75)]).phase).toBe('confirmed');
  });

  it('never counts standing at the start, however long', () => {
    expect(walk([fix(at(0), 0), fix(at(5), 60), fix(at(2), 120), fix(at(8), 300)]).phase).toBe('candidate');
  });

  it('needs a full minute, even walking fast', () => {
    expect(walk([fix(at(0), 0), fix(at(100), 20), fix(at(200), 40)]).phase).toBe('candidate');
  });

  it('starts over when the rider leaves the path or turns back', () => {
    expect(walk([fix(at(0), 0), fix(at(100), 40), fix(at(150, 120), 70)]).phase).toBe('idle');
    const turnedBack = walk([fix(at(0), 0), fix(at(120), 40), fix(at(40), 70), fix(at(160), 90)]);
    expect(turnedBack.phase).toBe('candidate');
  });

  it('ignores fixes too inaccurate to place on the path', () => {
    expect(walk([fix(at(0), 0), fix(at(100), 40, 120), fix(at(200), 80, null)]).phase).toBe('candidate');
  });
});

const itinerary: Itinerary = {
  arrivalTime: new Date(Date.now() + 20 * 60_000).toISOString(),
  departureTime: new Date().toISOString(),
  durationSeconds: 20 * 60,
  id: 'walk-then-ride',
  steps: [
    { kind: 'walk', distanceMeters: 445, durationSeconds: 360, path, toName: 'Demo stop' },
    {
      agency: { name: 'Demo Transit' },
      durationSeconds: 600,
      from: { name: 'Demo stop', location: end, time: new Date(Date.now() + 6 * 60_000).toISOString() },
      headsign: 'Uptown',
      kind: 'transit',
      line: { color: '#2457C5', name: '10', shortName: '10' },
      mode: 'bus',
      path: [end, { lat: 40.76, lng: -73.99 }],
      stopCount: 3,
      to: { name: 'Demo end', location: { lat: 40.76, lng: -73.99 }, time: new Date(Date.now() + 16 * 60_000).toISOString() },
    },
  ],
  transfers: 0,
};

function renderTrip(followFix: RideFix | null, onAutoStart?: jest.Mock) {
  return (
    <SafeAreaProvider initialMetrics={{ frame: { height: 844, width: 390, x: 0, y: 0 }, insets: { bottom: 34, left: 0, right: 0, top: 47 } }}>
      <AppSettingsProvider initialReducedMotion={true}>
        <PlannedTripDetailView
          destination="Demo end"
          followFix={followFix}
          isActive={false}
          isFavorite={false}
          itinerary={itinerary}
          onAutoStart={onAutoStart}
          onBack={jest.fn()}
          onEnd={jest.fn()}
          onStart={jest.fn()}
          onToggleFavorite={jest.fn()}
          origin="Demo start"
        />
      </AppSettingsProvider>
    </SafeAreaProvider>
  );
}

describe('Trip Details starting a trip the rider is already taking', () => {
  const walking = [fix(at(0), 0), fix(at(80), 40), fix(at(170), 75), fix(at(260), 110)];

  it('starts following once, after the walk is confirmed', () => {
    const onAutoStart = jest.fn();
    const screen = render(renderTrip(walking[0]!, onAutoStart));
    screen.rerender(renderTrip(walking[1]!, onAutoStart));
    expect(onAutoStart).not.toHaveBeenCalled();
    screen.rerender(renderTrip(walking[2]!, onAutoStart));
    screen.rerender(renderTrip(walking[3]!, onAutoStart));
    expect(onAutoStart).toHaveBeenCalledTimes(1);
    expect(onAutoStart.mock.calls[0]![0].id).toBe(itinerary.id);
  });

  it('only starts with GO when no auto-start is offered', () => {
    const screen = render(renderTrip(walking[0]!));
    for (const next of walking.slice(1)) screen.rerender(renderTrip(next));
    expect(screen.getByTestId('search-trip-go')).toBeTruthy();
  });
});
