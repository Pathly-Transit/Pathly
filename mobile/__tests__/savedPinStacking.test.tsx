import { act, fireEvent, render } from '@testing-library/react-native';

import { HomeMap } from '../src/components/HomeMap';
import { metersPerPixelAtZoom, savedPinUnderDot, stackSavedPins } from '../src/data/savedPlacePin';
import { placeToLocation, type SavedLocation } from '../src/data/userData';
import { AppSettingsProvider } from '../src/theme/AppSettings';

// Two places about 300 m apart in Midtown, and one in Brooklyn.
const HOME = { latitude: 40.7549, longitude: -73.984 };
const GYM = { latitude: 40.7575, longitude: -73.9855 };
const FAR = { latitude: 40.6782, longitude: -73.9442 };

describe('stackSavedPins', () => {
  it('stacks pins that would collide at a zoomed-out scale onto the first of them', () => {
    const zoomedOut = metersPerPixelAtZoom(11, 40.75); // about 58 m a pixel: a 34 px badge covers ~2 km
    expect(stackSavedPins([HOME, GYM, FAR], zoomedOut)).toEqual([
      { position: HOME, leader: true },
      { position: HOME, leader: false },
      { position: FAR, leader: true },
    ]);
  });

  it('leaves every pin at its own place once zoomed in far enough to part them', () => {
    const zoomedIn = metersPerPixelAtZoom(16, 40.75); // about 1.8 m a pixel
    expect(stackSavedPins([HOME, GYM, FAR], zoomedIn)).toEqual([
      { position: HOME, leader: true },
      { position: GYM, leader: true },
      { position: FAR, leader: true },
    ]);
  });

  it('finds the nearest pin the rider\'s dot covers', () => {
    const dot = { latitude: 40.75, longitude: -73.99 };
    const near = { id: 'near', position: { latitude: 40.75030, longitude: -73.99 } };
    const nearer = { id: 'nearer', position: { latitude: 40.75001, longitude: -73.99 } };
    const far = { id: 'far', position: { latitude: 40.76, longitude: -73.99 } };
    // At 1 m a pixel, a 38 px dot reaches pins centered within (38 + 44) / 2 = 41 m.
    expect(savedPinUnderDot([near, nearer, far], dot, 38, 1)?.id).toBe('nearer');
    expect(savedPinUnderDot([near, far], dot, 38, 1)?.id).toBe('near');
    expect(savedPinUnderDot([far], dot, 38, 1)).toBeNull();
    expect(savedPinUnderDot([], dot, 38, 1)).toBeNull();
  });
});

describe('home map saved places', () => {
  const saved = (id: string, title: string, location: typeof HOME): SavedLocation => ({
    id,
    address: placeToLocation({ id, title, subtitle: '', location }, 'Destination'),
    dateSaved: null,
  });

  it("draws colliding saved places fully overlapping, with only the top pin's icon, and parts them zoomed in", () => {
    const screen = render(
      <AppSettingsProvider>
        <HomeMap initialCamera={{ ...HOME, zoom: 11 }} location={HOME} savedLocations={[saved('home', 'Home', HOME), saved('gym', 'Gym', GYM)]} />
      </AppSettingsProvider>,
    );
    const hidden = { includeHiddenElements: true };
    const home = () => screen.getByTestId('saved-place-marker-home', hidden);
    const gym = () => screen.getByTestId('saved-place-marker-gym', hidden);
    expect(gym().props.coordinate).toEqual(home().props.coordinate);
    expect(home().props.zIndex).toBeGreaterThan(gym().props.zIndex);
    // The stacked pin's badge draws no icon of its own.
    expect(home().props.children.props.icon).not.toBeNull();
    expect(gym().props.children.props.icon).toBeNull();

    act(() => fireEvent(screen.getByTestId('home-map'), 'cameraIdle', { center: HOME, zoom: 16, bearing: 0, pitch: 0, userInteraction: true }));
    expect(gym().props.coordinate).toEqual(GYM);
    expect(gym().props.children.props.icon).not.toBeNull();
  });
});
