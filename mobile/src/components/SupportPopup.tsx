import { StyleSheet, Text, View } from 'react-native';

import { STUDENT_DISCLAIMER } from '../data/supportPrompt';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { fontFamilies, typography } from '../theme/typography';
import { Icon } from './Icon';
import { Mascot } from './Mascot';
import { PressableScale } from './PressableScale';
import { SwipePopup } from './SwipePopup';

export { swipeDismissTarget } from './SwipePopup';

type SupportPopupProps = {
  /** Swiped away or closed: it asks again some weeks later. */
  onDismiss: () => void;
  onFeedback: () => void;
  onNeverAsk: () => void;
  onSupport: () => void;
};

/**
 * The home screen's occasional ask (useSupportPopup): support Pathly with a tip, or take a quick
 * survey. Centered over the screen; swipes away in any direction or closes from the overlay; "Don't ask again" turns it off for good (also in Settings).
 */
export function SupportPopup({ onDismiss, onFeedback, onNeverAsk, onSupport }: SupportPopupProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return (
    <SwipePopup onDismiss={onDismiss} testID="support-popup">
      <View style={styles.row}>
        <Mascot mood="happy" motion="pop" size={44} />
        <View style={styles.copy}>
          <Text style={styles.title}>Enjoying Pathly?</Text>
          <Text style={styles.body}>{`${STUDENT_DISCLAIMER} A tip, or a minute of feedback, helps a lot.`}</Text>
        </View>
        <PressableScale accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={onDismiss} style={styles.close} testID="support-popup-close">
          <Icon color={colors.mutedInk} name="close" size={16} />
        </PressableScale>
      </View>
      <View style={styles.actions}>
        <PressableScale accessibilityHint="Opens a short feedback survey" accessibilityRole="link" onPress={onFeedback} style={[styles.action, styles.feedback]} testID="support-popup-feedback">
          <Icon color={colors.primary} filled={true} name="edit" size={15} />
          <Text style={styles.feedbackText}>Quick survey</Text>
        </PressableScale>
        <PressableScale accessibilityHint="Opens Pathly's donation page" accessibilityRole="link" onPress={onSupport} style={[styles.action, styles.support]} testID="support-popup-support">
          <Icon color={colors.onHighlight} filled={true} name="heart" size={15} />
          <Text style={styles.supportText}>Support Pathly</Text>
        </PressableScale>
      </View>
      <PressableScale accessibilityHint="Turns these popups off. You can turn them back on in Settings, Notifications." accessibilityRole="button" hitSlop={6} onPress={onNeverAsk} style={styles.never} testID="support-popup-never">
        <Text style={styles.neverText}>{"Don't ask again"}</Text>
      </PressableScale>
    </SwipePopup>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  copy: { minWidth: 0, flex: 1 },
  title: { color: colors.ink, ...typography.bodyStrong },
  body: { marginTop: 3, color: colors.mutedInk, ...typography.metadata, lineHeight: 18 },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginTop: -4, marginRight: -4 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 12 },
  action: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, borderRadius: radii.pill },
  feedback: { backgroundColor: colors.blueSoft },
  feedbackText: { color: colors.primary, fontFamily: fontFamilies.extraBold, fontSize: 13 },
  support: { backgroundColor: colors.highlight },
  supportText: { color: colors.onHighlight, fontFamily: fontFamilies.extraBold, fontSize: 13 },
  never: { alignSelf: 'center', minHeight: 32, justifyContent: 'center', paddingHorizontal: 10, marginTop: 4 },
  neverText: { color: colors.mutedInk, fontFamily: fontFamilies.bold, fontSize: 12 },
});
