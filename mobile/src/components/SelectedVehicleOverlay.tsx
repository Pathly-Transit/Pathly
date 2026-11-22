import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Animated, Image, Platform, StyleSheet, Text, View } from 'react-native';

import { SELECT_MS, SELECTED_SCALE, selectionEasing } from '../hooks/useSelectionScale';
import { useAppSettings } from '../theme/AppSettings';
import { fontFamilies } from '../theme/typography';
import { Icon } from './Icon';
import type { TransitMode } from './RouteBadge';

export type VehicleScreenPoint = { tripId: string; x: number; y: number; badgeUrl?: string };

const GLYPH: Record<TransitMode, 'bus' | 'subway' | 'rail' | 'ferry'> = { bus: 'bus', subway: 'subway', rail: 'rail', ferry: 'ferry' };

/** Keep the vehicle glyph and timestamp together above the backdrop at the marker's position. */
export function SelectedVehicleOverlay({ ageLabel, color, mode, point }: { ageLabel: string | null; color: string; mode: TransitMode; point: VehicleScreenPoint | null }) {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const view = useRef<ComponentRef<typeof View>>(null);
  const { reducedMotionActive } = useAppSettings();
  const [scale] = useState(() => new Animated.Value(reducedMotionActive ? SELECTED_SCALE : 1));
  useEffect(() => {
    if (reducedMotionActive) {
      scale.setValue(SELECTED_SCALE);
      return;
    }
    const animation = Animated.timing(scale, { toValue: SELECTED_SCALE, duration: SELECT_MS, easing: selectionEasing, useNativeDriver: Platform.OS !== 'web' });
    animation.start();
    return () => animation.stop();
  }, [reducedMotionActive, scale]);
  const size = point?.badgeUrl ? 36 : 42;
  const ageSize = point?.badgeUrl ? 22 : 24;
  return (
    <View
      collapsable={false}
      onLayout={() => {
        view.current?.measureInWindow((x, y) => setOrigin({ x, y }));
      }}
      pointerEvents="none"
      ref={view}
      style={StyleSheet.absoluteFill}
      testID="selected-vehicle-overlay"
    >
      {point && origin ? (
        <Animated.View
          style={[styles.badge, { left: point.x - origin.x - size / 2, top: point.y - origin.y - size / 2, width: size, height: size, borderRadius: size / 2, transform: [{ scale }] }]}
          testID="selected-vehicle-overlay-badge"
        >
          {point.badgeUrl ? <Image source={{ uri: point.badgeUrl }} style={{ width: size, height: size }} /> : <Icon color={color} name={GLYPH[mode]} size={22} />}
          {ageLabel ? (
            <View style={[styles.ageBadge, { backgroundColor: color, left: size / 2 + 21 - ageSize / 2, top: size / 2 - 21 - ageSize / 2, width: ageSize, height: ageSize, borderRadius: ageSize / 2 }]}>
              <Text style={styles.ageText} testID="selected-vehicle-overlay-age">{ageLabel}</Text>
            </View>
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { position: 'absolute', alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  ageBadge: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  ageText: { color: '#FFFFFF', fontFamily: fontFamilies.extraBold, fontSize: 9 },
});
