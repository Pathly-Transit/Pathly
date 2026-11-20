import { act, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { RouteMap } from '../src/components/RouteMap';
import { VehicleSheet } from '../src/components/VehicleSheet';
import type { RouteLiveVehicle } from '../src/data/transitLive';
import { stopsAwayLabel, vehicleArrival, vehicleProgress } from '../src/data/vehicleProgress';
import { AppSettingsProvider } from '../src/theme/AppSettings';

// Four stops along a straight east-west line, about 840 m apart, two minutes apart on the timetable.
const stops = ['Newark', 'Harrison', 'Journal Square', 'Grove Street'].map((name, index) => ({
  stopId: String(index),
  name,
  lat: 40.73,
  lon: -74.1 + index * 0.01,
  offsetMinutes: index * 2,
}));
const between = (a: number, b: number, share = 0.5) => ({ lat: 40.73, lon: -74.1 + (a + (b - a) * share) * 0.01 });
const hidden = { includeHiddenElements: true };

describe('vehicleProgress', () => {
  it('names the next stop and counts the stops to the rider’s, with the scheduled minutes left', () => {
    expect(vehicleProgress(stops, between(0, 1), 3)).toEqual({ atStop: null, nextStop: 'Harrison', stopsAway: 3, minutes: 5 });
    // The rider's stop is the next one: one stop away.
    expect(vehicleProgress(stops, between(2, 3), 3)).toEqual({ atStop: null, nextStop: 'Grove Street', stopsAway: 1, minutes: 1 });
  });

  it('says it is at a stop when it is right by one', () => {
    expect(vehicleProgress(stops, { lat: 40.7301, lon: -74.08 }, 3)).toEqual({ atStop: 'Journal Square', nextStop: null, stopsAway: 1, minutes: 2 });
    expect(vehicleProgress(stops, { lat: 40.73, lon: -74.07 }, 3)).toMatchObject({ atStop: 'Grove Street', stopsAway: 0, minutes: 0 });
  });

  it('leaves out what it cannot tell', () => {
    // Past the rider's stop: still the next stop, but no count or time.
    expect(vehicleProgress(stops, between(2, 3), 1)).toEqual({ atStop: null, nextStop: 'Grove Street', stopsAway: null, minutes: null });
    // No rider's stop (the whole line).
    expect(vehicleProgress(stops, between(0, 1), -1)).toMatchObject({ nextStop: 'Harrison', stopsAway: null, minutes: null });
    // No timetable.
    const untimed = stops.map(({ offsetMinutes: _offset, ...stop }) => stop);
    expect(vehicleProgress(untimed, between(0, 1), 3)).toMatchObject({ stopsAway: 3, minutes: null });
    // Far off the line.
    expect(vehicleProgress(stops, { lat: 40.8, lon: -74.05 }, 3)).toEqual({ atStop: null, nextStop: null, stopsAway: null, minutes: null });
  });

  it('words the count', () => {
    expect(stopsAwayLabel(1)).toBe('1 stop away');
    expect(stopsAwayLabel(4)).toBe('4 stops away');
    expect(stopsAwayLabel(0)).toBeNull();
    expect(stopsAwayLabel(null)).toBeNull();
  });

  it('shows the live time nearest the schedule’s guess, else the guess', () => {
    const predictions = [{ minutes: 2, live: true }, { minutes: 9, live: true }, { minutes: 20, live: false }];
    expect(vehicleArrival(8, predictions, true)).toEqual({ minutes: 9, live: true });
    expect(vehicleArrival(40, predictions, true)).toEqual({ minutes: 40, live: true });
    expect(vehicleArrival(40, predictions, false)).toEqual({ minutes: 40, live: false });
    expect(vehicleArrival(null, predictions, true)).toBeNull();
  });
});

describe('VehicleSheet layout', () => {
  const vehicle = (point: { lat: number; lon: number }): RouteLiveVehicle => ({ tripId: 't1', directionId: 0, ...point, updatedAt: Date.now() });
  const renderSheet = (props: Partial<Parameters<typeof VehicleSheet>[0]>) => render(
    <AppSettingsProvider>
      <VehicleSheet color="#D93A30" destination="World Trade Center" focusStopId="3" lineName="NWK-WTC" mode="subway" onClaim={jest.fn()} onClose={jest.fn()} onDismiss={jest.fn()} ridingTripId={null} sharingEnabled={false} stops={stops} vehicle={vehicle(between(1, 2))} {...props} />
    </AppSettingsProvider>,
  );

  it('heads with the destination, then stops away, the next stop and the arrival at the rider’s stop', () => {
    const screen = renderSheet({ predictions: [{ minutes: 3, live: true }] });
    expect(screen.getByTestId('vehicle-sheet-title').props.children).toBe('World Trade Center');
    expect(screen.getByTestId('vehicle-sheet-stops-away').props.children).toBe('2 stops away');
    expect(screen.getByTestId('vehicle-sheet-where').props.children).toBe('Next stop: Journal Square');
    const arrival = screen.getByTestId('vehicle-sheet-arrival');
    expect(arrival.props.accessibilityLabel).toBe('Arrives in 3 minutes, live');
    expect(screen.getByTestId('live-gps-signal', hidden)).toBeTruthy();
    expect(screen.getByText('minutes')).toBeTruthy();
  });

  it('keeps its dimmed backdrop', () => {
    const screen = renderSheet({});
    expect(StyleSheet.flatten(screen.getByTestId('vehicle-sheet-backdrop').props.style).backgroundColor).toBe('rgba(0, 0, 0, 0.35)');
  });

  it('says it is at a stop, singular when one stop away', () => {
    const screen = renderSheet({ vehicle: vehicle({ lat: 40.73, lon: -74.08 }) });
    expect(screen.getByTestId('vehicle-sheet-stops-away').props.children).toBe('1 stop away');
    expect(screen.getByTestId('vehicle-sheet-where').props.children).toBe('At Journal Square');
  });

  it('leaves parts out rather than showing placeholders', () => {
    // Past the rider's stop.
    const passed = renderSheet({ focusStopId: '0' });
    expect(passed.queryByTestId('vehicle-sheet-stops-away')).toBeNull();
    expect(passed.queryByTestId('vehicle-sheet-arrival')).toBeNull();
    expect(passed.getByTestId('vehicle-sheet-where').props.children).toBe('Next stop: Journal Square');
    // No stops known at all.
    const bare = renderSheet({ stops: [] });
    expect(bare.queryByTestId('vehicle-sheet-stops-away')).toBeNull();
    expect(bare.queryByTestId('vehicle-sheet-where')).toBeNull();
    expect(bare.queryByTestId('vehicle-sheet-arrival')).toBeNull();
  });
});

describe('selected vehicle on the map', () => {
  const vehicles: RouteLiveVehicle[] = [
    { tripId: 'a', directionId: 0, ...between(0, 1), updatedAt: Date.now() },
    { tripId: 'b', directionId: 0, ...between(2, 3), updatedAt: Date.now() },
  ];
  const map = (selectedVehicleId: string | null, reducedMotion = false) => (
    <AppSettingsProvider initialReducedMotion={reducedMotion}>
      <RouteMap color="#D93A30" focusStopId="3" onVehiclePress={jest.fn()} selectedVehicleId={selectedVehicleId} stops={stops} vehicles={vehicles} />
    </AppSettingsProvider>
  );

  // How large a vehicle is drawn (1 plain).
  const scaleOf = (screen: ReturnType<typeof render>, tripId: string) => {
    const transform = StyleSheet.flatten(screen.getByTestId(`route-vehicle-drawing-${tripId}`, hidden).props.style).transform as { scale?: number }[] | undefined;
    return transform?.find((step) => step.scale != null)?.scale ?? 1;
  };

  it('draws the picked vehicle larger, above every other marker, with nothing drawn over it', () => {
    const screen = render(map('a'));
    expect(screen.getByTestId('route-vehicle-a', hidden).props.zIndex).toBe(10);
    expect(screen.getByTestId('route-vehicle-b', hidden).props.zIndex).toBe(2);
    expect(scaleOf(screen, 'a')).toBeCloseTo(1.3);
    expect(scaleOf(screen, 'b')).toBe(1);
    expect(StyleSheet.flatten(screen.getByTestId('route-vehicle-badge-a', hidden).props.style).borderWidth).toBeUndefined();
  });

  it('grows when picked and shrinks back when let go', () => {
    jest.useFakeTimers();
    try {
      const screen = render(map(null));
      expect(scaleOf(screen, 'a')).toBe(1);
      screen.rerender(map('a'));
      act(() => jest.advanceTimersByTime(500));
      expect(scaleOf(screen, 'a')).toBeCloseTo(1.3);
      screen.rerender(map(null));
      act(() => jest.advanceTimersByTime(500));
      expect(scaleOf(screen, 'a')).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('switches at once with reduced motion', () => {
    const screen = render(map(null, true));
    screen.rerender(map('a', true));
    expect(scaleOf(screen, 'a')).toBeCloseTo(1.3);
    screen.rerender(map(null, true));
    expect(scaleOf(screen, 'a')).toBe(1);
  });
});
