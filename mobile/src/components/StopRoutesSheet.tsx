import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { fetchRoutesAtStop, type DiscoveredRoute } from '../data/nearbyTransit';
import type { MapStop } from '../map/mapTypes';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { typography } from '../theme/typography';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { RouteBadge, transitModeForAgency } from './RouteBadge';
import { SheetPanel } from './SheetPanel';

/**
 * A stop's name as riders read it: the feeds' all-caps names ("RICHMOND TERR/WALL ST") in title
 * case, with route numbers ("S46") and short words kept as they are.
 */
export function stopDisplayName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/[a-z0-9]+/g, (word) => {
    if (/\d/.test(word)) return word.toUpperCase();
    if (word === 'and' || word === 'of') return word;
    return word[0]!.toUpperCase() + word.slice(1);
  });
}

type Status = { status: 'loading' } | { status: 'failed' } | { status: 'loaded'; routes: readonly DiscoveredRoute[] };

type StopRoutesSheetProps = {
  /** The tapped station or bus stop; null hides the sheet. */
  stop: MapStop | null;
  onClose: () => void;
  /** A line picked from the list: opened in route view at this stop. */
  onOpenRoute: (route: DiscoveredRoute, stop: MapStop) => void;
};

/** Where each of a line's directions heads from this stop ("To St George"), or its name. */
function headsigns(route: DiscoveredRoute): string {
  const toward = [route.direction0?.headsign, route.direction1?.headsign].filter((headsign): headsign is string => Boolean(headsign));
  const unique = [...new Set(toward)];
  return unique.length ? unique.map((headsign) => `To ${headsign}`).join('\n') : route.routeName;
}

/**
 * What a stop's name pill on the map opens: every line that stops there, each opening its route
 * view at this stop.
 */
export function StopRoutesSheet({ onClose, onOpenRoute, stop }: StopRoutesSheetProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [state, setState] = useState<Status>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const lat = stop?.coordinate.latitude;
  const lon = stop?.coordinate.longitude;
  const kind = stop?.kind;
  const stopName = stop?.name ?? '';
  useEffect(() => {
    if (lat === undefined || lon === undefined || !kind) return undefined;
    let current = true;
    setState({ status: 'loading' });
    fetchRoutesAtStop({ latitude: lat, longitude: lon }, stopName).then(
      // A station lists its own kind of line (a subway station its trains, not the buses outside).
      (routes) => current && setState({ status: 'loaded', routes: routes.filter((route) => transitModeForAgency(route.agencyDisplayName) === kind).sort((a, b) => a.shortName.localeCompare(b.shortName, undefined, { numeric: true })) }),
      () => current && setState({ status: 'failed' }),
    );
    return () => {
      current = false;
    };
  }, [attempt, kind, lat, lon, stopName]);

  const name = stop ? stopDisplayName(stop.name) : '';
  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent={true} transparent={true} visible={stop !== null}>
      <View style={styles.viewport}>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.backdrop} testID="stop-routes-backdrop" />
        <SheetPanel accessibilityViewIsModal={true} style={styles.sheet} testID="stop-routes">
          <View style={styles.header}>
            <Icon color={colors.mutedInk} name={stop?.kind ?? 'bus'} size={22} />
            <Text numberOfLines={2} style={styles.heading}>{name}</Text>
            <PressableScale accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={onClose} testID="stop-routes-close"><Icon name="close" size={26} /></PressableScale>
          </View>
          {state.status === 'loading' ? (
            <View accessibilityLabel="Finding the lines here" style={styles.message}><ActivityIndicator color={colors.primary} /></View>
          ) : state.status === 'failed' ? (
            <View style={styles.message}>
              <Text style={styles.messageText}>Couldn't load the lines here.</Text>
              <PressableScale accessibilityRole="button" onPress={() => setAttempt((count) => count + 1)} style={styles.retry} testID="stop-routes-retry">
                <Text style={styles.retryText}>Try again</Text>
              </PressableScale>
            </View>
          ) : state.routes.length === 0 ? (
            <View style={styles.message}><Text style={styles.messageText}>No lines found stopping here.</Text></View>
          ) : (
            <ScrollView bounces={false} style={styles.list}>
              {state.routes.map((route) => (
                <PressableScale
                  accessibilityHint="Opens this line at this stop"
                  accessibilityLabel={`${route.shortName}, ${headsigns(route).replace(/\n/g, ', ')}`}
                  accessibilityRole="button"
                  key={`${route.agencyId}-${route.routeId}`}
                  onPress={() => stop && onOpenRoute(route, stop)}
                  style={styles.row}
                  testID={`stop-routes-${route.agencyId}-${route.routeId}`}
                >
                  <RouteBadge agency={route.agencyDisplayName} color={route.color} shortName={route.shortName} />
                  <Text numberOfLines={2} style={styles.toward}>{headsigns(route)}</Text>
                  <Icon color={colors.mutedInk} name="forward" size={18} />
                </PressableScale>
              ))}
            </ScrollView>
          )}
        </SheetPanel>
      </View>
    </Modal>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  viewport: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  sheet: { width: '100%', maxWidth: 540, maxHeight: '70%', alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 30, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, backgroundColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
  heading: { flex: 1, color: colors.ink, ...typography.sectionHeading, fontSize: 18 },
  list: { flexGrow: 0 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  toward: { flex: 1, minWidth: 0, color: colors.ink, ...typography.bodyStrong, fontSize: 15 },
  message: { alignItems: 'center', gap: 12, paddingVertical: 28 },
  messageText: { color: colors.mutedInk, ...typography.metadata, fontSize: 15 },
  retry: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 18, borderRadius: radii.pill, backgroundColor: colors.surfaceMuted },
  retryText: { color: colors.primary, ...typography.bodyStrong, fontSize: 15 },
});
