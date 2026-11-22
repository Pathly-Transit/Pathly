import { StyleSheet, Text, View } from 'react-native';

import type { TripDisruption } from '../data/tripDisruptions';
import { formatTripClock } from '../data/tripPlanning';
import { useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { typography } from '../theme/typography';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

/** An active-trip incident, in the sheet rather than over the map or in a modal. */
export function TripDisruptionNotice({ notice, onDismiss }: { notice: TripDisruption; onDismiss: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityLiveRegion="polite" style={styles.card} testID="trip-disruption-notice">
      <View style={styles.accent} />
      <View style={styles.icon}><Text style={styles.iconText}>i</Text></View>
      <View style={styles.copy}>
        <Text style={styles.title}>{notice.title}</Text>
        <Text style={styles.body}>{notice.body}</Text>
        {notice.arrivalTime ? <Text style={styles.arrival}>New arrival {formatTripClock(notice.arrivalTime)}{notice.delaySeconds && notice.delaySeconds > 0 ? ` · +${Math.round(notice.delaySeconds / 60)} min` : ''}</Text> : null}
      </View>
      <PressableScale accessibilityLabel="Dismiss trip change notice" accessibilityRole="button" onPress={onDismiss} style={styles.dismiss} testID="trip-disruption-dismiss">
        <Icon name="close" size={18} />
      </PressableScale>
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, borderWidth: 1, borderColor: colors.border, borderRadius: radii.control,
    backgroundColor: colors.surface, paddingVertical: 12, paddingLeft: 16, paddingRight: 4, overflow: 'hidden', marginBottom: 12 },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, backgroundColor: colors.alertYellow },
  icon: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.alertYellow, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  iconText: { ...typography.bodyStrong, color: colors.onAlertYellow },
  copy: { flex: 1, gap: 3 },
  title: { ...typography.bodyStrong, color: colors.ink },
  body: { ...typography.body, color: colors.ink },
  arrival: { ...typography.metadata, color: colors.mutedInk, marginTop: 2 },
  dismiss: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: -8 },
});
