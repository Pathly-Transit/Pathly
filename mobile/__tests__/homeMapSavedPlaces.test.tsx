import { fireEvent, render } from '@testing-library/react-native';

import { HomeMap } from '../src/components/HomeMap';
import { placeFromName, placeToLocation, type SavedLocation } from '../src/data/userData';
import { AppSettingsProvider } from '../src/theme/AppSettings';
import { MAP_EXPLORATION_BOUNDS, SERVICE_AREA_BOUNDS } from '../src/data/serviceArea';

const WORK_PLACE = { id: 'work-place', title: 'Work', subtitle: '123 Main St', location: { latitude: 40.75, longitude: -73.99 } };
const savedWork: SavedLocation = { id: 'work-place', address: placeToLocation(WORK_PLACE, 'Destination'), dateSaved: null };
const unresolved: SavedLocation = { id: 'name%3AFuture', address: placeToLocation(placeFromName('Future'), 'Destination'), dateSaved: null };

function settings(child: React.ReactNode) {
  return <AppSettingsProvider>{child}</AppSettingsProvider>;
}

describe('home map saved-place markers', () => {
  it('allows browsing beyond service coverage, keeping the camera near it', () => {
    const screen = render(settings(<HomeMap location={{ latitude: 40.7, longitude: -73.9 }} />));
    const map = screen.getByTestId('home-map');
    expect(map.props.maxBounds).toEqual(MAP_EXPLORATION_BOUNDS);
    // Far enough out to see the whole region at once.
    expect(map.props.minZoom).toBe(6);
    expect(map.props.initialCamera).toEqual({ center: { latitude: 40.7, longitude: -73.9 }, zoom: 14 });
    expect(MAP_EXPLORATION_BOUNDS.north).toBeGreaterThan(SERVICE_AREA_BOUNDS.north);
    expect(MAP_EXPLORATION_BOUNDS.south).toBeLessThan(SERVICE_AREA_BOUNDS.south);
    expect(MAP_EXPLORATION_BOUNDS.east).toBeGreaterThan(SERVICE_AREA_BOUNDS.east);
    expect(MAP_EXPLORATION_BOUNDS.west).toBeLessThan(SERVICE_AREA_BOUNDS.west);
    // Room past Metro-North's reach: Wassaic (41.81) to the north, Port Jervis (-74.69) to the west.
    expect(MAP_EXPLORATION_BOUNDS.north).toBeGreaterThanOrEqual(42.8);
    expect(MAP_EXPLORATION_BOUNDS.west).toBeLessThanOrEqual(-75.2);
  });

  it('renders only routable saved places and opens the selected place', () => {
    const onSavedLocationPress = jest.fn();
    const screen = render(settings(
      <HomeMap
        location={{ latitude: 40.7, longitude: -73.9 }}
        onSavedLocationPress={onSavedLocationPress}
        savedLocations={[savedWork, unresolved]}
      />,
    ));

    const marker = screen.getByTestId('saved-place-marker-work-place', { includeHiddenElements: true });
    expect(marker.props.coordinate).toEqual(WORK_PLACE.location);
    expect(marker.props.accessibilityLabel).toBe('Plan a trip to Work, 123 Main St');
    // A round badge centered on the place.
    expect(marker.props.anchor ?? 'center').toBe('center');
    expect(screen.queryByTestId('saved-place-marker-name%3AFuture', { includeHiddenElements: true })).toBeNull();
    fireEvent.press(marker);
    expect(onSavedLocationPress).toHaveBeenCalledWith(savedWork, [savedWork]);
  });

  it('opens a favorite the rider\'s dot covers when the dot is tapped', () => {
    const onSavedLocationPress = jest.fn();
    const screen = render(settings(
      <HomeMap
        location={WORK_PLACE.location}
        locationKnown
        onSavedLocationPress={onSavedLocationPress}
        savedLocations={[savedWork]}
      />,
    ));

    const marker = screen.getByTestId('saved-place-marker-work-place', { includeHiddenElements: true });
    const dot = screen.getByTestId('home-map-user-location', { includeHiddenElements: true });
    // The dot stays drawn over the favorite, and a tap on it opens the favorite.
    expect(dot.props.zIndex).toBeGreaterThan(marker.props.zIndex);
    fireEvent.press(dot);
    expect(onSavedLocationPress).toHaveBeenCalledWith(savedWork, [savedWork]);
  });

  it('does nothing when the rider\'s dot is tapped away from favorites', () => {
    const onSavedLocationPress = jest.fn();
    const screen = render(settings(
      <HomeMap location={{ latitude: 40.7, longitude: -73.9 }} locationKnown onSavedLocationPress={onSavedLocationPress} savedLocations={[savedWork]} />,
    ));

    fireEvent.press(screen.getByTestId('home-map-user-location', { includeHiddenElements: true }));
    expect(onSavedLocationPress).not.toHaveBeenCalled();
  });

  it('opens on a restored camera, including an older one saved as a span', () => {
    const at = { latitude: 40.75, longitude: -73.99 };
    const zoomed = render(settings(<HomeMap initialCamera={{ ...at, zoom: 12 }} location={{ latitude: 40.7, longitude: -73.9 }} />));
    expect(zoomed.getByTestId('home-map').props.initialCamera).toEqual({ center: at, zoom: 12 });
    zoomed.unmount();
    const spanned = render(settings(<HomeMap initialCamera={{ ...at, latitudeDelta: 0.05, longitudeDelta: 0.05 }} location={{ latitude: 40.7, longitude: -73.9 }} />));
    // 0.05 degrees across a phone-width map.
    expect(spanned.getByTestId('home-map').props.initialCamera.zoom).toBeCloseTo(13.4, 1);
  });
});
