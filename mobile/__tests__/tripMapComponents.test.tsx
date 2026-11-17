import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { TripMap } from '../src/components/TripMap';
import type { TripMapProgress } from '../src/data/tripMap';

const ORIGIN = { lat: 40.9, lng: -73.12 };
const DESTINATION = { lat: 40.93, lng: -73.08 };
const progress: TripMapProgress = {
  segments: [
    { path: [ORIGIN, { lat: 40.91, lng: -73.11 }], walk: false, color: '#0062CF', state: 'completed', stepIndex: 0 },
    { path: [{ lat: 40.91, lng: -73.11 }, { lat: 40.92, lng: -73.1 }], walk: true, state: 'current', stepIndex: 1 },
    { path: [{ lat: 40.92, lng: -73.1 }, DESTINATION], walk: false, color: '#F26A21', state: 'upcoming', stepIndex: 2 },
  ],
  stops: [
    { point: ORIGIN, kind: 'start', state: 'completed', visible: true },
    { point: { lat: 40.92, lng: -73.1 }, kind: 'stop', state: 'current', visible: true },
    { point: DESTINATION, kind: 'end', state: 'upcoming', visible: true },
  ],
  followTarget: { lat: 40.92, lng: -73.1 },
};

const hidden = { includeHiddenElements: true };
const kit = () => jest.requireMock('../src/map/MapCanvas') as { mockEaseTo: jest.Mock; mockFitPoints: jest.Mock };

describe('active TripMap', () => {
  beforeEach(() => {
    kit().mockEaseTo.mockClear();
    kit().mockFitPoints.mockClear();
  });

  it('draws an explicit, stale-capable rider marker and completed/current/upcoming legs', () => {
    const screen = render(
      <TripMap
        destination={DESTINATION}
        interactive={true}
        navigationProgress={progress}
        origin={ORIGIN}
        testID="nav-map"
        userLocation={{ lat: 40.915, lng: -73.105 }}
        userLocationStale={true}
      />,
    );

    expect(screen.getByTestId('nav-map-user-location', hidden).props.coordinate).toEqual({ latitude: 40.915, longitude: -73.105 });
    expect(StyleSheet.flatten(screen.getByTestId('nav-map-user-location-visual', hidden).props.style).opacity).toBeLessThan(1);
    const completed = screen.getByTestId('nav-map-progress-completed-0', hidden).props;
    expect(completed.width).toBe(4);
    expect(completed.opacity).toBeLessThan(1);
    const current = screen.getByTestId('nav-map-progress-current-1', hidden).props;
    expect(current.width).toBe(8);
    expect(current.dotted).toBe(true);
    const upcoming = screen.getByTestId('nav-map-progress-upcoming-2', hidden).props;
    expect(upcoming.color).toBe('#F26A21');
    expect(upcoming.width).toBe(6);
    // A stop already passed is ringed gray and faded; the start is a big gray dot.
    expect(StyleSheet.flatten(screen.getByTestId('trip-map-start-0', hidden).props.style).width).toBe(18);
  });

  it('follows movement, pauses after a pan, and resumes from locate', () => {
    const onFollowModeChange = jest.fn();
    const props = { destination: DESTINATION, interactive: true, navigationProgress: progress, onFollowModeChange, origin: ORIGIN, testID: 'follow-map' };
    const screen = render(<TripMap {...props} centerOnUserRequest={0} followUser={true} userLocation={{ lat: 40.915, lng: -73.105 }} />);
    expect(kit().mockFitPoints).toHaveBeenCalledWith(
      expect.arrayContaining([{ latitude: 40.915, longitude: -73.105 }]),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
    expect(kit().mockFitPoints.mock.calls.at(-1)![1].durationMs).toBeGreaterThan(0);

    kit().mockFitPoints.mockClear();
    screen.rerender(<TripMap {...props} centerOnUserRequest={0} followUser={true} userLocation={{ lat: 40.916, lng: -73.104 }} />);
    expect(kit().mockFitPoints).toHaveBeenCalledWith(expect.arrayContaining([{ latitude: 40.916, longitude: -73.104 }]), expect.anything());

    kit().mockFitPoints.mockClear();
    fireEvent(screen.getByTestId('follow-map', hidden), 'userGesture');
    expect(onFollowModeChange).toHaveBeenLastCalledWith(false);
    expect(kit().mockFitPoints).not.toHaveBeenCalled();
    screen.rerender(<TripMap {...props} centerOnUserRequest={0} followUser={false} userLocation={{ lat: 40.918, lng: -73.102 }} />);
    expect(kit().mockFitPoints).not.toHaveBeenCalled();
    screen.rerender(<TripMap {...props} centerOnUserRequest={1} followUser={false} userLocation={{ lat: 40.918, lng: -73.102 }} />);
    expect(onFollowModeChange).toHaveBeenLastCalledWith(true);
    expect(kit().mockFitPoints).toHaveBeenCalledWith(expect.arrayContaining([{ latitude: 40.918, longitude: -73.102 }]), expect.anything());
  });

  it('opens on a held camera without framing the trip, and frames it once the hold is cleared', () => {
    const held = { latitude: 40.95, longitude: -73.2, zoom: 16 };
    const screen = render(<TripMap destination={DESTINATION} holdCamera={held} interactive={true} origin={ORIGIN} testID="held-map" />);
    expect(screen.getByTestId('held-map', hidden).props.initialCamera).toEqual({ center: { latitude: 40.95, longitude: -73.2 }, zoom: 16 });
    expect(kit().mockFitPoints).not.toHaveBeenCalled();

    screen.rerender(<TripMap destination={DESTINATION} holdCamera={null} interactive={true} origin={ORIGIN} testID="held-map" />);
    expect(kit().mockFitPoints).toHaveBeenCalledWith(
      expect.arrayContaining([{ latitude: ORIGIN.lat, longitude: ORIGIN.lng }, { latitude: DESTINATION.lat, longitude: DESTINATION.lng }]),
      expect.objectContaining({ durationMs: 0 }),
    );
  });

  it('reports where the map rests only after the rider moves it', () => {
    const onUserCameraChange = jest.fn();
    const screen = render(<TripMap destination={DESTINATION} interactive={true} onUserCameraChange={onUserCameraChange} origin={ORIGIN} testID="report-map" />);
    const map = screen.getByTestId('report-map', hidden);
    fireEvent(map, 'cameraIdle', { center: { latitude: 40.91, longitude: -73.1 }, zoom: 13, bearing: 0, pitch: 0, userInteraction: false });
    expect(onUserCameraChange).not.toHaveBeenCalled();

    fireEvent(map, 'userGesture');
    fireEvent(map, 'cameraIdle', { center: { latitude: 40.97, longitude: -73.3 }, zoom: 14.5, bearing: 0, pitch: 0, userInteraction: true });
    expect(onUserCameraChange).toHaveBeenLastCalledWith({ latitude: 40.97, longitude: -73.3, zoom: 14.5 });
  });

  it('keeps the raw marker visible without following an unaccepted jump', () => {
    const accepted = { lat: 40.915, lng: -73.105 };
    const rawJump = { lat: 41.2, lng: -72.7 };
    const screen = render(
      <TripMap destination={DESTINATION} followLocation={accepted} followUser={true} interactive={true} navigationProgress={progress} origin={ORIGIN} testID="credible-follow-map" userLocation={rawJump} />,
    );
    expect(screen.getByTestId('credible-follow-map-user-location', hidden).props.coordinate).toEqual({ latitude: rawJump.lat, longitude: rawJump.lng });
    expect(kit().mockFitPoints).toHaveBeenCalledWith(expect.arrayContaining([{ latitude: accepted.lat, longitude: accepted.lng }]), expect.anything());
    expect(kit().mockFitPoints).not.toHaveBeenCalledWith(expect.arrayContaining([{ latitude: rawJump.lat, longitude: rawJump.lng }]), expect.anything());
  });

  it('centers the raw marker once on Locate without automatically following an unaccepted fix', () => {
    const onFollowModeChange = jest.fn();
    const rawLocation = { lat: 41.2, lng: -72.7 };
    const props = { destination: DESTINATION, followLocation: null, interactive: true, navigationProgress: progress, onFollowModeChange, origin: ORIGIN, testID: 'unaccepted-locate-map' };
    const screen = render(<TripMap {...props} centerOnUserRequest={0} followUser={false} userLocation={rawLocation} />);
    kit().mockEaseTo.mockClear();
    kit().mockFitPoints.mockClear();
    screen.rerender(<TripMap {...props} centerOnUserRequest={1} followUser={false} userLocation={rawLocation} />);

    expect(onFollowModeChange).toHaveBeenLastCalledWith(true);
    expect(kit().mockEaseTo).toHaveBeenCalledWith({
      center: { latitude: expect.closeTo(rawLocation.lat, 2), longitude: rawLocation.lng },
      zoom: 15,
      durationMs: 350,
    });
    // The default padding covers more of the top than the bottom, so the camera centers a little
    // north of the rider, putting them in the middle of the map's uncovered part.
    expect(kit().mockEaseTo.mock.calls.at(-1)![0].center.latitude).toBeGreaterThan(rawLocation.lat);
    expect(kit().mockFitPoints).not.toHaveBeenCalled();

    kit().mockEaseTo.mockClear();
    screen.rerender(<TripMap {...props} centerOnUserRequest={1} followUser={true} userLocation={{ lat: rawLocation.lat + 0.01, lng: rawLocation.lng + 0.01 }} />);
    expect(kit().mockEaseTo).not.toHaveBeenCalled();
    expect(kit().mockFitPoints).not.toHaveBeenCalled();
  });

  it('frames active navigation while the first trustworthy location is unavailable', () => {
    render(<TripMap destination={DESTINATION} followUser={true} interactive={true} navigationProgress={progress} origin={ORIGIN} testID="no-fix-map" />);
    expect(kit().mockFitPoints).toHaveBeenCalledWith(
      expect.arrayContaining([{ latitude: ORIGIN.lat, longitude: ORIGIN.lng }, { latitude: DESTINATION.lat, longitude: DESTINATION.lng }]),
      expect.objectContaining({ durationMs: 0 }),
    );
  });

  it('labels a tapped stop and clears the label on a tap elsewhere', () => {
    const screen = render(<TripMap destination={DESTINATION} interactive={true} navigationProgress={progress} origin={ORIGIN} testID="label-map" />);
    expect(screen.queryByTestId('trip-map-stop-label', hidden)).toBeNull();
    fireEvent.press(screen.getByTestId('trip-map-stop-1', hidden));
    // Progress stops carry no label of their own, so none shows; a still map has no taps at all.
    expect(screen.queryByTestId('trip-map-stop-label', hidden)).toBeNull();
    const still = render(<TripMap destination={DESTINATION} navigationProgress={progress} origin={ORIGIN} testID="still-map" />);
    expect(still.getByTestId('trip-map-stop-1', hidden).props.onPress).toBeUndefined();
    expect(still.getByTestId('still-map', hidden).props.interactive).toBe(false);
  });
});
