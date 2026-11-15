import { StyleSheet, Text, View } from 'react-native';

import { useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { fontFamilies, typography } from '../theme/typography';
import { STUDENT_DISCLAIMER } from '../data/supportPrompt';
import { Mascot } from './Mascot';
import { PressableScale } from './PressableScale';
import { radii } from '../theme/shape';
import { SwipePopup } from './SwipePopup';

/** The arrival's small donation ask (see useSupportPrompt): centered over the screen, swiped away or closed from the overlay. */
export function SupportCard({ onDismiss, onDonate }: { onDismiss: () => void; onDonate: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <SwipePopup onDismiss={onDismiss} testID="support-card">
      <View style={styles.row}>
        <Mascot mood="happy" motion="pop" size={44} />
        <View style={styles.copy}>
          <Text style={styles.title}>Glad you made it!</Text>
          <Text style={styles.body}>{`${STUDENT_DISCLAIMER} If Pathly got you here, a small tip keeps it running.`}</Text>
        </View>
      </View>
      <View style={styles.actions}>
        <PressableScale accessibilityRole="button" onPress={onDismiss} style={styles.secondary} testID="support-dismiss"><Text style={styles.secondaryText}>Not now</Text></PressableScale>
        <PressableScale accessibilityRole="link" onPress={onDonate} style={styles.primary} testID="support-donate"><Text style={styles.primaryText}>Support Pathly</Text></PressableScale>
      </View>
    </SwipePopup>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  copy: { minWidth: 0, flex: 1 },
  title: { color: colors.ink, ...typography.bodyStrong },
  body: { marginTop: 3, color: colors.mutedInk, ...typography.metadata, lineHeight: 18 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  secondary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 14 },
  secondaryText: { color: colors.mutedInk, fontFamily: fontFamilies.extraBold, fontSize: 13 },
  primary: { minHeight: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: radii.pill, backgroundColor: colors.highlight },
  primaryText: { color: colors.onHighlight, fontFamily: fontFamilies.extraBold, fontSize: 13 },
});
