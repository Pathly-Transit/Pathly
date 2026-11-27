import { useDeviceHeading } from '../hooks/useDeviceHeading';
import { MapLocationDot } from '../map/MapCanvas';
import type { MapPoint } from '../map/mapTypes';

/**
 * The rider's blue dot with the flashlight beam toward where the phone faces (none without a
 * compass). On the phone both are drawn on the map itself, so they stay put on the streets while
 * the map is dragged.
 */
export function RiderLocationMarker({ coordinate, onPress, stale, testID, zIndex }: { coordinate: MapPoint; onPress?: () => void; stale?: boolean; testID: string; zIndex?: number }) {
  const heading = useDeviceHeading();
  return <MapLocationDot coordinate={coordinate} heading={heading} onPress={onPress} stale={stale} testID={testID} zIndex={zIndex} />;
}
