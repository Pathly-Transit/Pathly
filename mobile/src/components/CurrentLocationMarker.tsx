import { StyleSheet, View } from 'react-native';

import { useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';

/** The dot's size in px with its halo: how much of the map it covers. */
export const CURRENT_LOCATION_SIZE = 38;

export function CurrentLocationMarker() {
  const styles = useThemedStyles(createStyles);
  return (
    <View
      accessibilityLabel="Current location"
      accessible={true}
      style={styles.pulse}
    >
      <View style={styles.dot} />
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  pulse: {
    width: CURRENT_LOCATION_SIZE,
    height: CURRENT_LOCATION_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: CURRENT_LOCATION_SIZE / 2,
    backgroundColor: colors.locationHalo,
  },
  dot: {
    width: 17,
    height: 17,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    backgroundColor: colors.location,
    shadowColor: colors.location,
    shadowOpacity: 0.32,
    shadowRadius: 5,
  },
});
