import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';

import { useViewportSize } from '../hooks/useViewportSize';
import { useRouteColor } from '../data/routeColors';
import { departureDisplay, directionDestination, preferredDirectionIndex, type RouteDetail, type TransitDirection } from '../data/transit';
import { useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { typography } from '../theme/typography';
import { FitText } from './FitText';
import { Icon } from './Icon';
import { LIVE_SIGNAL_WIDTH, LiveSignal } from './LiveSignal';
import { PressableScale } from './PressableScale';
import { isPath, PathMark } from './RouteBadge';
import { useSkeletonPulse } from './Skeleton';
import { radii } from '../theme/shape';

type TransitCardProps = {
  /** With the direction shown on the card when it was pressed (by `directions` index). */
  onPress: (directionIndex: number) => void;
  /** Saved by the rider: shown first in Nearby with a small star. */
  saved?: boolean;
  route: RouteDetail;
};

const CARD_HORIZONTAL_MARGIN = 8;
/** The card is a fixed 104 tall, so the big time can only grow this much with the phone's text size. */
const MAX_TIME_FONT_SCALE = 1.3;
/**
 * A drag counts as a page swipe once its sideways part is at least this share of its up-down part
 * (about 55° from horizontal), so a swipe needn't be dead level; a steeper drag scrolls the list.
 */
const SWIPE_SLOPE = 0.7;
/** On phones a gentle drag this far (pt) turns the page; the page already follows the finger. */
const PAGE_TURN_DISTANCE = 12;
/** How far a finger moves before the card claims the drag from the list. */
const CLAIM_DISTANCE = 6;
/** A quick flick turns the page even when it's shorter than PAGE_TURN_DISTANCE (points per ms). */
const FLICK_VELOCITY = 0.15;
const webImmediatePress = Platform.OS === 'web' ? { delayPressIn: 0 } : null;

/** A pulsing block where the minutes will appear, while the first live times load. */
function TimePlaceholder({ styles }: { styles: ReturnType<typeof createStyles> }) {
  const opacity = useSkeletonPulse();
  return (
    <Animated.View style={[styles.timePlaceholder, { opacity }]} testID="transit-time-placeholder">
      <View style={styles.timePlaceholderNumber} />
      <View style={styles.timePlaceholderUnit} />
    </Animated.View>
  );
}

function PageBody({ index, item, route, styles }: {
  index: number;
  item: TransitDirection;
  route: RouteDetail;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <>
      <View style={styles.copy}>
        {isPath(route.agency) ? (
          // PATH's lines are signed with its P; white on the line's color, like the other cards' names.
          <View accessibilityLabel={`PATH ${route.routeName}`} accessible={true} style={styles.pathMark} testID={`transit-${route.id}-title`}>
            <PathMark color="#FFFFFF" height={29} />
          </View>
        ) : (
          <FitText style={styles.routeName} testID={`transit-${route.id}-title`}>
            {route.shortName || route.routeName}
          </FitText>
        )}
        <FitText style={styles.direction}>{directionDestination(item.direction)}</FitText>
        <Text numberOfLines={1} style={styles.stopName}>{item.stopName}</Text>
      </View>

      {item.unavailable ? (
        <View style={styles.timing} testID={`transit-${route.id}-arrival-${index}`}>
          {route.liveStatus === 'loading' ? <TimePlaceholder styles={styles} /> : <Text style={styles.unavailableText}>{'—'}</Text>}
        </View>
      ) : (
        <View style={[styles.timing, !item.live && styles.scheduledTiming]}>
          <View style={styles.timeRow}>
            {item.live ? <View style={styles.signalSpacer} /> : null}
            <Text
              adjustsFontSizeToFit={true}
              maxFontSizeMultiplier={MAX_TIME_FONT_SCALE}
              minimumFontScale={0.6}
              numberOfLines={1}
              style={styles.minutes}
              testID={`transit-${route.id}-arrival-${index}`}
            >
              {departureDisplay(item.minutes).value}
            </Text>
            {item.live ? <LiveSignal style={styles.signal} /> : null}
          </View>
          <Text maxFontSizeMultiplier={MAX_TIME_FONT_SCALE} numberOfLines={1} style={styles.minuteUnit}>{departureDisplay(item.minutes).unit}</Text>
        </View>
      )}
    </>
  );
}

/**
 * Which direction a card opens on: the first, unless the rider is at or near the end of that
 * direction's line (or clearly at the other end's stop), where the other way is the one they'd
 * ride. Known from the stops themselves, so the card opens there at once: it never flips over
 * when live times arrive as the rider scrolls.
 */
export function openingDirectionIndex(route: RouteDetail): 0 | 1 {
  return preferredDirectionIndex(route.directions) ?? 0;
}

export function TransitCard({ onPress, route, saved = false }: TransitCardProps) {
  const styles = useThemedStyles(createStyles);
  const routeColor = useRouteColor();
  const { width } = useViewportSize();
  const pageWidth = Math.min(width, 540) - CARD_HORIZONTAL_MARGIN * 2;
  const [activePage, setActivePage] = useState<number>(() => openingDirectionIndex(route));

  // A tap opens the route only when the pointer stayed put. On web a press still ends in a click
  // after a mouse drag (react-native-web fires onPress from the click), so a swipe that the card
  // or the tab pager took over must not also count as a tap. Taking the drag cancels the press
  // with the pointer already moved, which is what marks it here.
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const pressMoved = useRef(false);
  const handlePressIn = (event: GestureResponderEvent) => {
    pressStart.current = { x: event.nativeEvent.pageX, y: event.nativeEvent.pageY };
    pressMoved.current = false;
  };
  const handlePressOut = (event: GestureResponderEvent) => {
    const start = pressStart.current;
    pressStart.current = null;
    if (start && Math.hypot(event.nativeEvent.pageX - start.x, event.nativeEvent.pageY - start.y) > CLAIM_DISTANCE) pressMoved.current = true;
  };
  const handlePress = (index: number) => {
    // The drag's own click: skipped once, so a later keyboard press still opens the route.
    if (pressMoved.current) {
      pressMoved.current = false;
      return;
    }
    onPress(index);
  };

  // The pages sit in a row that follows the finger (or mouse), then settles on `activePage`. A
  // horizontal scroller nested in the vertical list only took dead-level swipes on Android (the list
  // claimed anything at an angle), so the card claims sideways-ish drags itself instead, in the
  // capture phase, ahead of the Nearby/Favorites pager around it (TransitSheet). It starts
  // already on the opening page, so nothing slides into place as the card appears.
  const [slide] = useState(() => new Animated.Value(-activePage * pageWidth));
  const pageCount = route.directions.length;
  useEffect(() => {
    Animated.spring(slide, { toValue: -activePage * pageWidth, bounciness: 0, speed: 18, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [activePage, pageWidth, slide]);
  const swipe = useMemo(() => {
    const settle = () => Animated.spring(slide, { toValue: -activePage * pageWidth, bounciness: 0, speed: 18, useNativeDriver: Platform.OS !== 'web' }).start();
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_event, gesture) => pageCount > 1 && Math.abs(gesture.dx) > CLAIM_DISTANCE && Math.abs(gesture.dx) > Math.abs(gesture.dy) * SWIPE_SLOPE,
      // Once the card has the swipe, neither the list nor the Nearby/Favorites pager may take it back.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_event, gesture) => slide.setValue(-activePage * pageWidth + gesture.dx),
      onPanResponderRelease: (_event, gesture) => {
        const step = gesture.dx < -PAGE_TURN_DISTANCE || gesture.vx < -FLICK_VELOCITY ? 1 : gesture.dx > PAGE_TURN_DISTANCE || gesture.vx > FLICK_VELOCITY ? -1 : 0;
        const next = Math.min(Math.max(activePage + step, 0), pageCount - 1);
        if (next === activePage) settle();
        else setActivePage(next);
      },
      onPanResponderTerminate: settle,
    });
  }, [activePage, pageCount, pageWidth, slide]);

  const accessibilityLabelFor = (item: TransitDirection) => {
    if (item.unavailable) {
      return `${route.agency} ${route.routeName}. ${directionDestination(item.direction)}. ${item.stopName}. ${route.liveStatus === 'loading' ? 'Loading live data.' : 'Live data unavailable.'}`;
    }
    const timing = departureDisplay(item.minutes).accessibility;
    return `${route.agency} ${route.routeName}. ${directionDestination(item.direction)}. ${item.stopName}. ${timing}, ${item.live ? 'live GPS prediction' : 'scheduled time'}.`;
  };

  return (
    <View
      style={[styles.card, { backgroundColor: routeColor(route.color) }]}
      testID={`route-card-${route.id}`}
    >
      <Animated.View
        {...swipe.panHandlers}
        style={[styles.pages, { width: pageWidth * pageCount, transform: [{ translateX: slide }] }]}
        testID={`transit-${route.id}-directions`}
      >
        {route.directions.map((item, index) => (
          <PressableScale
            key={`${item.direction}-${index}`}
            accessibilityHint="Opens route details. Swipe horizontally for the other direction."
            accessibilityLabel={accessibilityLabelFor(item)}
            accessibilityRole="button"
            // Pressed at once on web (react-native-web waits 50 ms), so even a quick flick is
            // cancelled as moved rather than left unpressed. Not in RN's Pressable types.
            {...webImmediatePress}
            focusable={Platform.OS === 'web' ? index === activePage : undefined}
            onPress={() => handlePress(index)}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            style={[styles.page, { width: pageWidth }]}
            testID={`route-card-${route.id}-${index === 0 ? 'primary' : 'alternate'}`}
          >
            <PageBody index={index} item={item} route={route} styles={styles} />
          </PressableScale>
        ))}
      </Animated.View>

      {saved ? <View pointerEvents="none" style={styles.savedBadge} testID={`route-card-${route.id}-saved`}><Icon color="rgba(255,255,255,0.9)" name="favorite" size={12} /></View> : null}
      <View accessibilityElementsHidden={true} style={styles.pageDots}>
        {route.directions.map((item, index) => (
          <View
            key={`${item.direction}-${index}`}
            style={[styles.pageDot, index === activePage && styles.activePageDot]}
          />
        ))}
      </View>
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  card: {
    height: 104,
    overflow: 'hidden',
    marginHorizontal: CARD_HORIZONTAL_MARGIN,
    marginVertical: 3,
    borderRadius: radii.card,
  },
  page: {
    height: 104,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 18,
  },
  // The pages sit side by side and slide under the finger (or mouse). On web, dragging with the
  // mouse mustn't select the card's text.
  pages: { flexDirection: 'row', ...(Platform.OS === 'web' ? { userSelect: 'none' as const } : null) },
  copy: { minWidth: 0, flex: 1 },
  routeName: { color: colors.white, ...typography.displayTime },
  pathMark: { alignSelf: 'flex-start', height: 29, justifyContent: 'center' },
  direction: {
    marginTop: 3,
    color: colors.white,
    ...typography.bodyStrong,
    fontSize: 13,
  },
  stopName: {
    marginTop: 2,
    color: colors.white,
    ...typography.metadata,
    opacity: 0.84,
  },
  timing: { minWidth: 56, alignItems: 'center', justifyContent: 'center' },
  scheduledTiming: { opacity: 0.68 },
  // Translucent white reads as gray on any route color.
  timePlaceholder: { alignItems: 'center', gap: 5 },
  timePlaceholderNumber: { width: 34, height: 28, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.32)' },
  timePlaceholderUnit: { width: 30, height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.24)' },
  unavailableText: {
    color: colors.white,
    opacity: 0.68,
    ...typography.displayTime,
    fontSize: 24,
  },
  dueText: {
    color: colors.white,
    ...typography.displayTime,
    fontSize: 22,
    lineHeight: 34,
  },
  timeRow: {
    minHeight: 30,
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  // The spacer mirrors the signal so the number stays centered over "minutes".
  signalSpacer: { width: LIVE_SIGNAL_WIDTH },
  signal: { marginLeft: 2, marginTop: 1 },
  savedBadge: { position: 'absolute', top: 6, right: 8 },
  // iOS clips the top of glyphs whose line is shorter than the font, so the line gets room to draw
  // and the negative margin keeps the layout as tight as before.
  minutes: {
    marginVertical: -4,
    color: colors.white,
    ...typography.displayTime,
    fontSize: 35,
    lineHeight: 42,
  },
  minuteUnit: {
    marginTop: -1,
    color: colors.white,
    ...typography.label,
    fontSize: 10,
    lineHeight: 12,
    letterSpacing: 0,
    textAlign: 'center',
    textTransform: 'none',
  },
  provenance: {
    marginTop: 5,
    color: colors.white,
    ...typography.label,
    fontSize: 9,
    lineHeight: 11,
  },
  pageDots: {
    position: 'absolute',
    right: 0,
    bottom: 9,
    left: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 5,
  },
  pageDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.42)',
  },
  // Two round dots; the shown direction's is solid white.
  activePageDot: { backgroundColor: colors.white },
});
