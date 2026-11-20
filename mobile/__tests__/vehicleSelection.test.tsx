import { act, fireEvent, render, within } from '@testing-library/react-native';
import { useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { RouteMap } from '../src/components/RouteMap.native';
import { WebVehicleMarker } from '../src/components/RouteMap.web';
import { VehicleSheet } from '../src/components/VehicleSheet';
import type { VehicleScreenPoint } from '../src/components/SelectedVehicleOverlay';
import type { RouteLiveVehicle } from '../src/data/transitLive';
import { stopsAwayLabel, vehicleArrival, vehicleProgress } from '../src/data/vehicleProgress';
import { AppSettingsProvider } from '../src/theme/AppSettings';
import { lightColors } from '../src/theme/colors';
import { radii } from '../src/theme/shape';

jest.mock('@react-google-maps/api', () => ({
  OverlayViewF: ({ children }: { children: ReactNode }) => children,
  OVERLAY_MOUSE_TARGET: 'overlayMouseTarget',
}));

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
    expect(screen.getByTestId('vehicle-sheet-backdrop', hidden)).toHaveStyle({ backgroundColor: lightColors.scrim });
  });

  it('rises as a rounded vehicle popup', () => {
    const timing = jest.spyOn(Animated, 'timing');
    try {
      const screen = renderSheet({});
      expect(screen.getByTestId('vehicle-sheet')).toHaveStyle({ borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet });
      expect(timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, duration: 300 }));
    } finally {
      timing.mockRestore();
    }
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
  const { mockPointForCoordinate } = jest.requireMock('react-native-maps') as { mockPointForCoordinate: jest.Mock };
  beforeEach(() => {
    mockPointForCoordinate.mockReset().mockResolvedValue({ x: 0, y: 0 });
  });
  afterEach(() => jest.restoreAllMocks());

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

  it('enlarges only the picked vehicle and raises it above the other markers', () => {
    const screen = render(map('a'));
    expect(screen.getByTestId('route-vehicle-a', hidden).props.zIndex).toBe(10);
    expect(screen.getByTestId('route-vehicle-b', hidden).props.zIndex).toBe(2);
    expect(scaleOf(screen, 'a')).toBeCloseTo(1.3);
    expect(scaleOf(screen, 'b')).toBe(1);
  });

  it('grows when picked and shrinks back when let go', () => {
    jest.useFakeTimers();
    try {
      const screen = render(map(null));
      expect(scaleOf(screen, 'a')).toBe(1);
      screen.rerender(map('a'));
      act(() => jest.advanceTimersByTime(80));
      expect(scaleOf(screen, 'a')).toBeGreaterThan(1);
      expect(scaleOf(screen, 'a')).toBeLessThan(1.3);
      act(() => jest.advanceTimersByTime(500));
      expect(scaleOf(screen, 'a')).toBeCloseTo(1.3);
      screen.rerender(map(null));
      act(() => jest.advanceTimersByTime(80));
      expect(scaleOf(screen, 'a')).toBeGreaterThan(1);
      expect(scaleOf(screen, 'a')).toBeLessThan(1.3);
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

  it('draws the tapped icon and its timestamp above the backdrop and follows the map until dismissed', async () => {
    mockPointForCoordinate.mockResolvedValueOnce({ x: 116, y: 160 }).mockResolvedValueOnce({ x: 134, y: 170 });
    const viewPrototype = View.prototype as { measureInWindow: (callback: (x: number, y: number) => void) => void };
    jest.spyOn(viewPrototype, 'measureInWindow').mockImplementation(function (this: { props: { testID?: string } }, callback) {
      const isOverlay = this.props.testID === 'selected-vehicle-overlay';
      callback(isOverlay ? 0 : 20, isOverlay ? 24 : 30);
    });

    function MapAndSheet() {
      const [id, setId] = useState<string | null>(null);
      const [point, setPoint] = useState<VehicleScreenPoint | null>(null);
      return (
        <AppSettingsProvider initialReducedMotion={true}>
          <RouteMap color="#D93A30" onSelectedVehiclePosition={setPoint} onVehiclePress={setId} selectedVehicleId={id} stops={stops} vehicles={vehicles} />
          <VehicleSheet color="#D93A30" destination="World Trade Center" lineName="NWK-WTC" mode="subway" onClaim={jest.fn()} onClose={() => setId(null)} onDismiss={jest.fn()} ridingTripId={null} selectedVehiclePoint={point} sharingEnabled={false} stops={stops} vehicle={vehicles.find((vehicle) => vehicle.tripId === id) ?? null} />
        </AppSettingsProvider>
      );
    }

    const screen = render(<MapAndSheet />);
    await act(async () => fireEvent.press(screen.getByTestId('route-vehicle-b', hidden)));
    const backdrop = screen.getByTestId('vehicle-sheet-backdrop', hidden);
    expect(backdrop).toHaveStyle({ backgroundColor: lightColors.scrim });
    fireEvent(screen.getByTestId('selected-vehicle-overlay', hidden), 'layout');
    const badge = () => screen.getByTestId('selected-vehicle-overlay-badge', hidden);
    expect(mockPointForCoordinate).toHaveBeenCalledWith({ latitude: vehicles[1]!.lat, longitude: vehicles[1]!.lon });
    expect(badge()).toHaveStyle({ left: 115, top: 145, width: 42, height: 42, transform: [{ scale: 1.3 }] });
    expect(within(badge()).getByTestId('selected-vehicle-overlay-age', hidden)).toHaveTextContent(/^\d+[smh]$/);

    await act(async () => fireEvent(screen.getByTestId('route-map', hidden), 'regionChange'));
    expect(badge()).toHaveStyle({ left: 133, top: 155 });

    fireEvent.press(backdrop);
    expect(screen.queryByTestId('selected-vehicle-overlay-badge', hidden)).toBeNull();
  });

  it('follows the selected web vehicle at its on-screen center until dismissed', () => {
    jest.useFakeTimers();
    try {
      const onPosition = jest.fn();
      const getBoundingClientRect = jest.fn(() => ({ left: 100, top: 140, width: 42, height: 42 }));
      const marker = (selected: boolean) => (
        <AppSettingsProvider>
          <WebVehicleMarker color="#D93A30" now={Date.now()} onPosition={selected ? onPosition : undefined} selected={selected} title="Train" vehicle={vehicles[0]!} zIndex={2} />
        </AppSettingsProvider>
      );
      const screen = render(marker(true), { createNodeMock: () => ({ getBoundingClientRect }) });
      expect(onPosition).toHaveBeenLastCalledWith(expect.objectContaining({ tripId: 'a', x: 121, y: 161, badgeUrl: expect.stringContaining('data:image/svg+xml') }));
      getBoundingClientRect.mockReturnValue({ left: 97, top: 139, width: 54, height: 54 });
      act(() => jest.advanceTimersByTime(32));
      expect(onPosition).toHaveBeenLastCalledWith(expect.objectContaining({ tripId: 'a', x: 124, y: 166 }));
      screen.rerender(marker(false));
      act(() => jest.advanceTimersByTime(32));
      expect(onPosition.mock.calls).toHaveLength(3);
      expect(onPosition).toHaveBeenLastCalledWith(null);
    } finally {
      jest.useRealTimers();
    }
  });

  it('glides to a new vehicle position and projects the intermediate frames for the overlay', async () => {
    const measure = jest.spyOn(View.prototype as { measureInWindow: (callback: (x: number, y: number) => void) => void }, 'measureInWindow')
      .mockImplementation((callback) => callback(0, 0));
    const first = vehicles[0]!;
    const moved = { ...first, lon: first.lon + 0.004 };
    const onPosition = jest.fn();
    const map = (vehicle: RouteLiveVehicle) => (
      <AppSettingsProvider>
        <RouteMap color="#D93A30" onSelectedVehiclePosition={onPosition} selectedVehicleId={first.tripId} stops={stops} vehicles={[vehicle]} />
      </AppSettingsProvider>
    );
    mockPointForCoordinate.mockImplementation(async ({ longitude }) => ({ x: 100 + Math.round((longitude - first.lon) * 10_000), y: 160 }));
    jest.useFakeTimers();
    try {
      const screen = render(map(first));
      await act(async () => {});
      expect(onPosition).toHaveBeenLastCalledWith({ tripId: first.tripId, x: 100, y: 160 });
      screen.rerender(map(moved));
      await act(async () => { jest.advanceTimersByTime(600); });
      const middleX = onPosition.mock.lastCall?.[0].x;
      expect(middleX).toBeGreaterThan(100);
      expect(middleX).toBeLessThan(140);
      await act(async () => { jest.advanceTimersByTime(700); });
      expect(onPosition).toHaveBeenLastCalledWith({ tripId: first.tripId, x: 140, y: 160 });
    } finally {
      jest.useRealTimers();
      measure.mockRestore();
    }
  });
});
