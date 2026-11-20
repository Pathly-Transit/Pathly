import { StyleSheet, Text, View } from 'react-native';

import type { RideFix } from '../data/rideDetection';
import type { RideTracking } from '../data/rideTracking';
import { legSource } from '../hooks/useTripVehicles';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { typography } from '../theme/typography';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { RideReportBar } from './RideReportBar';

type ActiveTripNoticesProps = {
  /** Walking to a stop with too little time to spare (useHurryUp). */
  hurry: { title: string; body: string } | null;
  /** The ride the trip is sharing, if Settings -> Privacy allows it (HomeScreen's useTripRide). */
  ride?: RideTracking;
  /** The vehicle the rider is on, for "how's this ride" reports. */
  reportTripId: string | null;
  reportRoute?: { agencyId: string; routeId: string; boardStopId: string };
  rideFix: RideFix | null;
  /** The trip started itself because the rider was already on their way. */
  startedAutomatically?: boolean;
};

/** What a trip in progress needs to say above its steps on Trip Details: hurry up, sharing, reports. */
export function ActiveTripNotices({ hurry, reportRoute, reportTripId, ride, rideFix, startedAutomatically = false }: ActiveTripNoticesProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  if (!startedAutomatically && !hurry && !ride?.ridingTripId && !(reportTripId && reportRoute)) return null;
  return (
    <View style={styles.notices} testID="active-trip-notices">
      {startedAutomatically ? (
        <View accessibilityLiveRegion="polite" style={styles.started} testID="active-trip-started-automatically">
          <Icon color={colors.primary} name="go" size={20} />
          <Text style={styles.noticeText}>You&apos;re on your way, so Pathly is following this trip. Not taking it? Tap END.</Text>
        </View>
      ) : null}
      {hurry ? (
        <View accessibilityLiveRegion="assertive" style={styles.hurry} testID="active-trip-hurry-up">
          <Icon color={colors.highlightInk} name="travel" size={20} />
          <View style={styles.hurryCopy}>
            <Text style={styles.hurryTitle}>{hurry.title}</Text>
            <Text style={styles.noticeText}>{hurry.body}</Text>
          </View>
        </View>
      ) : null}
      {ride?.ridingTripId ? (
        <View style={styles.sharing} testID="active-trip-ride-sharing">
          <Icon color={colors.primary} name="people" size={20} />
          <Text style={styles.noticeText}>Sharing this ride. Other riders see your avatar, never your name.</Text>
          <PressableScale
            accessibilityLabel="I'm not on this vehicle; stop sharing"
            accessibilityRole="button"
            onPress={() => { if (ride.ridingTripId) ride.dismiss(ride.ridingTripId); }}
            style={styles.dismiss}
            testID="active-trip-ride-not-on"
          >
            <Text style={styles.dismissText}>Not on this</Text>
          </PressableScale>
        </View>
      ) : null}
      {reportTripId && reportRoute ? <RideReportBar fix={rideFix} key={reportTripId} source={legSource(reportRoute)} tripId={reportTripId} /> : null}
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  notices: { gap: 10, marginBottom: 12 },
  noticeText: { flex: 1, color: colors.ink, ...typography.metadata },
  hurry: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radii.control, backgroundColor: colors.highlightSoft },
  hurryCopy: { flex: 1, gap: 2 },
  hurryTitle: { color: colors.ink, ...typography.bodyStrong },
  started: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radii.control, backgroundColor: colors.blueSoft },
  sharing: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: radii.control, backgroundColor: colors.blueSoft },
  dismiss: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  dismissText: { color: colors.primary, ...typography.bodyStrong, fontSize: 13 },
});
