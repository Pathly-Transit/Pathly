import { useMemo, useState, type ReactNode } from 'react';
import { Animated, Modal, PanResponder, Pressable, StyleSheet, View } from 'react-native';

import { useAppSettings, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { useNativeDriver } from '../theme/motion';
import { radii } from '../theme/shape';

/** How far a drag must go (in any direction) to throw the popup away, or how fast. */
const SWIPE_DISTANCE = 70;
const SWIPE_VELOCITY = 0.6;
/** How far a thrown popup flies before it's gone. */
const THROW_DISTANCE = 600;

/**
 * Where a released drag throws the popup, or null to spring it back: any direction counts, along
 * whichever axis the drag mostly went.
 */
export function swipeDismissTarget(dx: number, dy: number, vx = 0, vy = 0): { x: number; y: number } | null {
  const far = Math.hypot(dx, dy) >= SWIPE_DISTANCE || Math.hypot(vx, vy) >= SWIPE_VELOCITY;
  if (!far) return null;
  const length = Math.hypot(dx, dy) || 1;
  return { x: (dx / length) * THROW_DISTANCE, y: (dy / length) * THROW_DISTANCE };
}

type SwipePopupProps = {
  children: ReactNode;
  /** Swiped away in any direction, the overlay tapped, or Back pressed. */
  onDismiss: () => void;
  testID: string;
  visible?: boolean;
};

/**
 * The app's small popups (tips, feedback, reminders): a card centered over a dimmed overlay. It
 * goes away when thrown in any direction or when the overlay is tapped; taps inside still reach
 * its buttons.
 */
export function SwipePopup({ children, onDismiss, testID, visible = true }: SwipePopupProps) {
  const styles = useThemedStyles(createStyles);
  const { reducedMotionActive } = useAppSettings();
  const [offset] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const responder = useMemo(() => PanResponder.create({
    // A tap still reaches the buttons; only a real drag moves the popup.
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dx) > 6 || Math.abs(gesture.dy) > 6,
    onPanResponderMove: (_event, gesture) => offset.setValue({ x: gesture.dx, y: gesture.dy }),
    onPanResponderRelease: (_event, gesture) => {
      const target = swipeDismissTarget(gesture.dx, gesture.dy, gesture.vx, gesture.vy);
      if (!target) {
        Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver }).start();
        return;
      }
      if (reducedMotionActive) {
        offset.setValue({ x: 0, y: 0 });
        onDismiss();
        return;
      }
      Animated.timing(offset, { toValue: target, duration: 180, useNativeDriver }).start(() => {
        offset.setValue({ x: 0, y: 0 });
        onDismiss();
      });
    },
    onPanResponderTerminate: () => Animated.spring(offset, { toValue: { x: 0, y: 0 }, useNativeDriver }).start(),
  }), [offset, onDismiss, reducedMotionActive]);
  // Fades as it's dragged away, whichever way.
  const distance = Animated.add(Animated.multiply(offset.x, offset.x), Animated.multiply(offset.y, offset.y));
  const fade = distance.interpolate({ inputRange: [0, 240 * 240], outputRange: [1, 0.2], extrapolate: 'clamp' });

  return (
    <Modal animationType="fade" onRequestClose={onDismiss} statusBarTranslucent={true} transparent={true} visible={visible}>
      <View style={styles.center}>
        <Pressable accessibilityLabel="Close" accessibilityRole="button" onPress={onDismiss} style={styles.overlay} testID={`${testID}-overlay`} />
        <Animated.View
          accessibilityHint="Swipe away to close"
          accessibilityViewIsModal={true}
          style={[styles.card, { opacity: fade, transform: offset.getTranslateTransform() }]}
          testID={testID}
          {...responder.panHandlers}
        >
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  card: {
    width: '100%',
    maxWidth: 380,
    padding: 18,
    paddingBottom: 10,
    borderRadius: radii.card,
    backgroundColor: colors.surface,
    shadowColor: colors.shadow,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
});
