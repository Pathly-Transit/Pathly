import { View } from 'react-native';

import { useDeviceHeading } from '../hooks/useDeviceHeading';
import { MapMarker } from '../map/MapCanvas';
import { HEADING_BEAM_SIZE, HeadingBeam } from './HeadingBeam';

/**
 * The rider's flashlight beam under their blue dot, turned to where the phone faces. It turns with
 * the map, so it stays true to north however the map itself is turned. Nothing shows without a
 * compass (a desktop browser, say).
 */
export function HeadingBeamMarker({ coordinate }: { coordinate: { latitude: number; longitude: number } }) {
  const heading = useDeviceHeading();
  if (heading == null) return null;
  return (
    <MapMarker coordinate={coordinate} rotation={heading} testID="heading-beam" zIndex={0}>
      <View pointerEvents="none" style={{ width: HEADING_BEAM_SIZE, height: HEADING_BEAM_SIZE }}>
        <HeadingBeam />
      </View>
    </MapMarker>
  );
}
