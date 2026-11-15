import { StyleSheet, Text, View } from 'react-native';

import type { SystemNotice } from '../data/systemNotices';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { fontFamilies, typography } from '../theme/typography';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';
import { SwipePopup } from './SwipePopup';

/**
 * A reminder for a holiday that changes service on every line (see useSystemNotice): centered over
 * the screen, swiped away in any direction or closed from the overlay.
 */
export function SystemNoticeBanner({ notice, onDismiss }: { notice: SystemNotice; onDismiss: () => void }) {
  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);
  return (
    <SwipePopup onDismiss={onDismiss} testID="system-notice">
      <View accessibilityLabel={notice.accessibilityLabel} accessible={true} style={styles.copy}>
        <View style={styles.icon}><Icon color={colors.primary} name="calendar" size={20} /></View>
        <Text style={styles.text}>{notice.text}</Text>
      </View>
      <PressableScale accessibilityLabel="Dismiss reminder" accessibilityRole="button" onPress={onDismiss} style={styles.button} testID="system-notice-close">
        <Text style={styles.buttonText}>Got it</Text>
      </PressableScale>
    </SwipePopup>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  copy: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: colors.blueSoft },
  text: { minWidth: 0, flex: 1, color: colors.ink, ...typography.bodyStrong },
  button: { alignSelf: 'flex-end', minHeight: 40, justifyContent: 'center', marginTop: 12, paddingHorizontal: 16, borderRadius: radii.pill, backgroundColor: colors.primary },
  buttonText: { color: colors.onPrimary, fontFamily: fontFamilies.extraBold, fontSize: 13 },
});
