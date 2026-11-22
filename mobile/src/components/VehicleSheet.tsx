import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { BeanAvatar } from '../avatars/BeanAvatarImage';
import { formatAge, STALE_TRAIN_MS } from '../data/liveTrains';
import { nearRider } from '../data/rideDetection';
import { rideReportLabel } from '../data/rideReports';
import { focusStopIndex } from '../data/routeDirection';
import { stopsAwayLabel, vehicleArrival, vehicleProgress } from '../data/vehicleProgress';
import type { RideFix } from '../data/rideDetection';
import { feedVehicles } from '../data/rideTracking';
import type { LiveSource } from '../data/transit';
import type { RouteLiveVehicle } from '../data/transitLive';
import { useDebug } from '../debug/DebugContext';
import { useNow } from '../hooks/useNow';
import { useAppSettings, useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { fontFamilies, typography } from '../theme/typography';
import { readableColor } from '../theme/contrast';
import { ArrivalTime } from './ArrivalTime';
import { SheetPanel } from './SheetPanel';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { RideReportBar } from './RideReportBar';
import type { TransitMode } from './RouteBadge';
import { SelectedVehicleOverlay, type VehicleScreenPoint } from './SelectedVehicleOverlay';

const NOUNS: Record<TransitMode, string> = { bus: 'bus', subway: 'train', rail: 'train', ferry: 'boat' };

/** "You and 2 other riders", or null when nobody's sharing. */
export function ridersLabel(riders: RouteLiveVehicle['riders']): string | null {
  if (!riders || riders.count === 0) return null;
  const others = riders.count - (riders.you ? 1 : 0);
  const otherText = `${others} ${others === 1 ? 'rider' : 'riders'}`;
  if (!riders.you) return `${otherText} on board`;
  return others > 0 ? `You and ${others} other ${others === 1 ? 'rider' : 'riders'} on board` : 'You’re on board';
}

type VehicleSheetProps = {
  /** The vehicle the rider's location says they're on, even with sharing off: they can report on it. */
  onBoardTripId?: string | null;
  reportFix?: RideFix | null;
  reportSource?: Pick<LiveSource, 'agencyId' | 'routeId'>;
  color: string;
  /** Text on the line color (dark on light colors); white when not given. */
  onColor?: string;
  destination: string;
  lineName: string;
  /** The line's feed, for an admin to Ride Along with this vehicle. */
  liveSource?: LiveSource;
  mode: TransitMode;
  onClaim: (tripId: string) => void;
  onClose: () => void;
  onDismiss: (tripId: string) => void;
  /** The rider's position, when known: offers "I'm on this" only when they're near the vehicle. */
  riderAt?: { lat: number; lon: number } | null;
  ridingTripId: string | null;
  sharingEnabled: boolean;
  /** The line's stops in the vehicle's direction; `offsetMinutes` (scheduled, from the first) times its arrival. */
  stops: readonly { stopId?: string; name: string; lat: number; lon: number; offsetMinutes?: number }[];
  /** The rider's stop in `stops` (see focusStopIndex): what "stops away" and the arrival count to. */
  focusStopId?: string;
  focusStopName?: string;
  /** The line's drawn track, for placing the vehicle between stops; the stops are joined without it. */
  path?: readonly { lat: number; lon: number }[];
  /** This direction's times at the rider's stop: the one matching the vehicle is shown, live. */
  predictions?: readonly { minutes: number; live: boolean }[];
  /** Window position of the selected Route View marker. */
  selectedVehiclePoint?: VehicleScreenPoint | null;
  vehicle: RouteLiveVehicle | null;
};

/** Right by a stop's point, a vehicle is at it rather than on its way. Stations are long. */
const TRAIN_AT_STOP_METERS = 120;
const BUS_AT_STOP_METERS = 40;

/** A tapped vehicle, from the bottom: where it's headed, how far it is from the rider's stop, and who's on it. */
export function VehicleSheet({ color, onColor, destination, focusStopId, focusStopName, lineName, liveSource, mode, onClaim, onClose, onBoardTripId = null, onDismiss, path, predictions = [], reportFix = null, reportSource, riderAt, ridingTripId, selectedVehiclePoint, sharingEnabled, stops, vehicle }: VehicleSheetProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const { reducedMotionActive } = useAppSettings();
  const now = useNow(1000);
  const riding = vehicle != null && vehicle.tripId === ridingTripId;
  const riders = vehicle?.riders;
  const onBoard = ridersLabel(riders);
  // A position still being reported.
  const live = vehicle?.updatedAt != null && now - vehicle.updatedAt <= STALE_TRAIN_MS;
  // Where it is on the line, from its position: the stop it's at or heading for, how many stops
  // it is from the rider's, and when it gets there. Parts it can't tell are left out.
  const focusIndex = focusStopId || focusStopName ? focusStopIndex(stops, focusStopId, focusStopName) : -1;
  const progress = vehicle ? vehicleProgress(stops, vehicle, focusIndex, path, mode === 'bus' ? BUS_AT_STOP_METERS : TRAIN_AT_STOP_METERS) : null;
  const stopsAway = stopsAwayLabel(progress?.stopsAway ?? null);
  const whereNow = progress?.atStop ? `At ${progress.atStop}` : progress?.nextStop ? `Next stop: ${progress.nextStop}` : null;
  const arrival = vehicleArrival(progress?.minutes ?? null, predictions, live);
  // The line's color, lightened where it's too dark to read on the sheet.
  const accent = readableColor(color, colors.surface, 3);
  const canClaim = vehicle != null && sharingEnabled && !riding && riderAt != null && nearRider(feedVehicles([vehicle])[0]!, riderAt, now);
  const { isAdmin, rideAlong, setMockLocation, startRideAlong } = useDebug();
  const ridingAlong = vehicle != null && rideAlong?.tripId === vehicle.tripId;
  return (
    <Modal animationType={reducedMotionActive ? 'none' : 'fade'} onRequestClose={onClose} statusBarTranslucent={true} transparent={true} visible={vehicle != null}>
      <View style={styles.viewport}>
        <Pressable accessibilityLabel="Close vehicle details" onPress={onClose} style={styles.backdrop} testID="vehicle-sheet-backdrop">
          {vehicle && selectedVehiclePoint !== undefined ? (
            <SelectedVehicleOverlay
              ageLabel={vehicle.updatedAt != null && !vehicle.riders?.avatars.length ? formatAge(now - vehicle.updatedAt) : null}
              color={color}
              mode={mode}
              point={selectedVehiclePoint?.tripId === vehicle.tripId ? selectedVehiclePoint : null}
            />
          ) : null}
        </Pressable>
        {vehicle ? (
          <SheetPanel accessibilityViewIsModal={true} key={vehicle.tripId} style={styles.sheet} testID="vehicle-sheet">
            <View style={styles.header}>
              <View style={styles.headerCopy}>
                <Text accessibilityLabel={`${lineName} ${NOUNS[mode]} to ${destination}`} accessibilityRole="header" numberOfLines={2} style={styles.title} testID="vehicle-sheet-title">{destination}</Text>
                {stopsAway ? <Text numberOfLines={1} style={[styles.stopsAway, { color: accent }]} testID="vehicle-sheet-stops-away">{stopsAway}</Text> : null}
                {whereNow ? <Text numberOfLines={2} style={styles.whereNow} testID="vehicle-sheet-where">{whereNow}</Text> : null}
              </View>
              {arrival ? <ArrivalTime color={accent} live={arrival.live} minutes={arrival.minutes} testID="vehicle-sheet-arrival" /> : null}
              <PressableScale accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={onClose} style={styles.close} testID="vehicle-sheet-close"><Icon name="close" size={26} /></PressableScale>
            </View>

            {onBoard && riders ? (
              <View style={styles.row} testID="vehicle-sheet-riders">
                <View style={styles.avatars}>
                  {riders.avatars.map((avatar, index) => (
                    <View key={index} style={[styles.avatarDisc, index > 0 && styles.avatarStacked, { zIndex: riders.avatars.length - index }]}>
                      <BeanAvatar config={avatar} size={28} />
                    </View>
                  ))}
                </View>
                <Text style={styles.rowText}>{onBoard}</Text>
              </View>
            ) : null}
            {vehicle.reports?.length ? (
              <View style={styles.row} testID="vehicle-sheet-reports">
                <Icon name="people" size={20} />
                <Text style={styles.rowText}>{vehicle.reports.map((report) => (report.count > 1 ? `${rideReportLabel(report.kind)} (${report.count})` : rideReportLabel(report.kind))).join(', ')}</Text>
              </View>
            ) : null}

            {reportSource && (riding || vehicle.tripId === onBoardTripId) ? <RideReportBar fix={reportFix} key={vehicle.tripId} source={reportSource} tripId={vehicle.tripId} /> : null}
            {riding ? (
              <PressableScale accessibilityRole="button" onPress={() => { onDismiss(vehicle.tripId); onClose(); }} style={[styles.button, styles.secondaryButton]} testID="vehicle-sheet-not-on">
                <Text style={styles.secondaryButtonText}>{`I’m not on this ${NOUNS[mode]}`}</Text>
              </PressableScale>
            ) : canClaim ? (
              <PressableScale accessibilityRole="button" onPress={() => { onClaim(vehicle.tripId); onClose(); }} style={[styles.button, { backgroundColor: color }]} testID="vehicle-sheet-on">
                <Text style={[styles.primaryButtonText, onColor ? { color: onColor } : null]}>{`I’m on this ${NOUNS[mode]}`}</Text>
              </PressableScale>
            ) : null}
            {isAdmin && liveSource ? (
              <PressableScale
                accessibilityHint="Admin testing: your mock location follows this vehicle's feed position"
                accessibilityRole="button"
                onPress={() => {
                  if (ridingAlong) setMockLocation(undefined);
                  else {
                    const { lat, lon } = feedVehicles([vehicle])[0]!;
                    startRideAlong({ source: liveSource, tripId: vehicle.tripId, label: `Riding along on the ${lineName} ${NOUNS[mode]}` }, { lat, lon });
                  }
                  onClose();
                }}
                style={[styles.button, styles.secondaryButton]}
                testID="vehicle-sheet-ride-along"
              >
                <Text style={styles.secondaryButtonText}>{ridingAlong ? 'Stop riding along' : 'Ride along (admin)'}</Text>
              </PressableScale>
            ) : null}
            <Text style={styles.note} testID="vehicle-sheet-note">
              {sharingEnabled
                ? 'Other riders see your avatar here, never your name. Your location is erased soon after you get off.'
                : 'Turn on Share my rides in Settings, Privacy to help place vehicles for other riders.'}
            </Text>
          </SheetPanel>
        ) : null}
      </View>
    </Modal>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  viewport: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    width: '100%',
    maxWidth: 540,
    alignSelf: 'center',
    gap: 14,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 30,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    backgroundColor: colors.surface,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  headerCopy: { flex: 1, minWidth: 0, gap: 2 },
  title: { color: colors.ink, ...typography.screenHeading, fontSize: 22 },
  stopsAway: { fontFamily: fontFamilies.extraBold, fontSize: 17, lineHeight: 22 },
  whereNow: { marginTop: 2, color: colors.mutedInk, ...typography.bodyStrong },
  close: { marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowText: { flex: 1, color: colors.ink, ...typography.bodyStrong },
  avatars: { flexDirection: 'row' },
  avatarDisc: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: '#FFFFFF' },
  avatarStacked: { marginLeft: -12 },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: radii.pill },
  secondaryButton: { backgroundColor: colors.surfaceMuted },
  primaryButtonText: { color: '#FFFFFF', fontFamily: fontFamilies.extraBold, fontSize: 15 },
  secondaryButtonText: { color: colors.ink, fontFamily: fontFamilies.extraBold, fontSize: 15 },
  note: { color: colors.mutedInk, ...typography.metadata },
});
