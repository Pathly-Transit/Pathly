import { StyleSheet, Text, View } from 'react-native';

import { MapMarker } from '../map/MapCanvas';
import type { MapStop } from '../map/mapTypes';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { typography } from '../theme/typography';
import { Icon } from './Icon';
import { stopDisplayName } from './StopRoutesSheet';

/** A tapped stop's name in a small pill just above its icon; tapping it lists the lines there. */
export function StopPill({ onPress, stop }: { onPress: () => void; stop: MapStop }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const name = stopDisplayName(stop.name);
  return (
    <MapMarker
      accessibilityLabel={`${name}. Shows the lines here`}
      anchor="bottom"
      coordinate={stop.coordinate}
      offset={[0, stop.kind === 'bus' ? -12 : -16]}
      onPress={onPress}
      testID="map-stop-pill"
      zIndex={6}
    >
      <View style={styles.pill}>
        <Icon color={colors.mutedInk} name={stop.kind} size={15} />
        <Text numberOfLines={1} style={styles.name}>{name}</Text>
        <Icon color={colors.mutedInk} name="forward" size={13} />
      </View>
    </MapMarker>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  pill: {
    maxWidth: 260,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  name: { flexShrink: 1, color: colors.ink, ...typography.bodyStrong, fontSize: 14 },
});
