import { useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';

import { Icon } from '../components/Icon';
import { PressableScale } from '../components/PressableScale';
import { useThumbSide } from '../hooks/useThumbSide';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { typography } from '../theme/typography';
import { MAP_ATTRIBUTION } from './mapStyle';

const SIZE = 24;
/** Tucked into the corner, closer in than the full-size buttons. */
const EDGE = 10;
const COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
/** The chip's © glyph already says "©", so the opened text drops it. */
const CREDIT_TEXT = MAP_ATTRIBUTION.replace(/^©\s*/, '');

/**
 * The map's credit (mapStyle.ts MAP_ATTRIBUTION: OpenStreetMap's footpaths need it): a small ©
 * chip tucked into the bottom corner across from Locate, opening into the credit, which links to
 * OpenStreetMap's copyright page. Closed until tapped. `bottomInset` lifts it clear of what covers
 * the map's bottom (the map's bottom padding: the home sheet resting over it).
 */
export function MapCredit({ bottomInset = 0 }: { bottomInset?: number }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const thumb = useThumbSide();
  const [open, setOpen] = useState(false);
  return (
    <PressableScale
      accessibilityLabel={open ? MAP_ATTRIBUTION : 'Map data credits'}
      accessibilityRole="button"
      hitSlop={10}
      onPress={() => setOpen((value) => !value)}
      style={[styles.button, thumb.leftHanded ? { right: EDGE } : { left: EDGE }, bottomInset > 0 && { bottom: EDGE + bottomInset }, open && styles.open]}
      testID="map-credit"
    >
      {/* Pathly's blue, like the other map buttons. */}
      <Icon color={colors.primary} name="credit" size={15} />
      {open ? (
        <Text
          accessibilityRole="link"
          numberOfLines={1}
          onPress={() => void Linking.openURL(COPYRIGHT_URL)}
          style={styles.text}
          testID="map-credit-text"
        >
          {CREDIT_TEXT}
        </Text>
      ) : null}
    </PressableScale>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  // MapControlButton's color and shadow, smaller and lighter: it's a credit, not a control.
  button: {
    position: 'absolute',
    bottom: EDGE,
    minWidth: SIZE,
    height: SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: SIZE / 2,
    backgroundColor: colors.mapControl,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  open: { paddingLeft: 5, paddingRight: 10 },
  text: { color: colors.mutedInk, ...typography.bodyStrong, fontSize: 11, lineHeight: 14 },
});
