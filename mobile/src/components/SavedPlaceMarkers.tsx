import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { addressAfterName } from '../data/placesSearch';
import { metersPerPixelAtZoom, SAVED_PIN, savedPlaceColor, stackSavedPins } from '../data/savedPlacePin';
import { locationPoint, savedPlaceName, type SavedLocation } from '../data/userData';
import { MapMarker } from '../map/MapCanvas';
import { useTheme } from '../theme/AppSettings';
import { Icon, type IconName } from './Icon';
import { savedLocationIcon } from './FavoritesStrip';

/**
 * The rider's saved places, for every map to show (HomeScreen provides them): the home map makes
 * its pins tappable, and the route and trip maps show them so a rider sees their places on the way.
 */
const SavedPlacesContext = createContext<readonly SavedLocation[]>([]);

export function SavedPlacesProvider({ children, locations }: { children: ReactNode; locations: readonly SavedLocation[] }) {
  return <SavedPlacesContext.Provider value={locations}>{children}</SavedPlacesContext.Provider>;
}

export function useSavedPlaces(): readonly SavedLocation[] {
  return useContext(SavedPlacesContext);
}

/**
 * A saved place's map marker: its icon centered in a round badge right on the place, in the
 * place's color. A marker stacked under another leaves its icon off. The clear square around the
 * badge is part of the marker, so it takes taps too.
 */
function SavedPlacePin({ color, icon }: { color: string; icon: IconName | null }) {
  const { colors } = useTheme();
  return (
    <View style={pinStyles.hitArea}>
      <View style={[pinStyles.badge, { backgroundColor: color, borderColor: colors.savedPlaceBorder }]}>
        {icon ? <Icon color={colors.ring} name={icon} size={16} /> : null}
      </View>
    </View>
  );
}

const pinStyles = StyleSheet.create({
  hitArea: { width: SAVED_PIN.hitSize, height: SAVED_PIN.hitSize, alignItems: 'center', justifyContent: 'center' },
  badge: { width: SAVED_PIN.size, height: SAVED_PIN.size, alignItems: 'center', justifyContent: 'center', borderRadius: SAVED_PIN.size / 2, borderWidth: 2.5 },
});

type SavedPlaceMarkersProps = {
  /** The map's zoom (the app's scale): pins that would collide there are stacked. */
  zoom: number;
  /** The places to show; the provider's when left out. */
  locations?: readonly SavedLocation[];
  /** Tapping a pin, with the places stacked at its spot (the home map). */
  onPress?: (location: SavedLocation, stack: readonly SavedLocation[]) => void;
  zIndex?: number;
};

/** The saved places' pins on a map; render them before a map's other markers so those draw on top natively. */
export function SavedPlaceMarkers({ locations, onPress, zIndex = 1, zoom }: SavedPlaceMarkersProps) {
  const provided = useSavedPlaces();
  const saved = locations ?? provided;
  const { colors } = useTheme();
  // Pins that would collide at this zoom are stacked at one spot (see stackSavedPins).
  const pins = useMemo(() => {
    const placed = saved.flatMap((location) => {
      const point = locationPoint(location.address);
      return point ? [{ saved: location, point }] : [];
    });
    if (placed.length === 0) return [];
    const stacks = stackSavedPins(placed.map(({ point }) => point), metersPerPixelAtZoom(zoom, placed[0]!.point.latitude));
    const stacked = placed.map((pin, index) => ({ ...pin, ...stacks[index]! }));
    // Stacked pins draw under their stack's leader.
    return [...stacked].sort((a, b) => Number(a.leader) - Number(b.leader)).map((pin) => ({ ...pin, stack: stacked.filter((other) => other.position === pin.position).map((other) => other.saved) }));
  }, [saved, zoom]);

  return (
    <>
      {pins.map(({ saved: location, position, leader, stack }) => {
        const name = savedPlaceName(location.address);
        const address = addressAfterName(name, location.address.streetAddress);
        return (
          <MapMarker
            accessibilityLabel={onPress ? (address ? `Plan a trip to ${name}, ${address}` : `Plan a trip to ${name}`) : `Saved place: ${name}`}
            coordinate={position}
            key={location.id}
            onPress={onPress ? () => onPress(location, stack) : undefined}
            testID={`saved-place-marker-${location.id}`}
            zIndex={leader ? zIndex + 1 : zIndex}
          >
            <SavedPlacePin color={savedPlaceColor(location.address, colors.primary)} icon={leader ? savedLocationIcon(location.address) : null} />
          </MapMarker>
        );
      })}
    </>
  );
}
