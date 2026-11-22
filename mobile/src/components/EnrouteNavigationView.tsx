import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { NavigationCheckpoint } from '../data/enrouteNavigation';
import { ThemedStatusBar, useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { typography } from '../theme/typography';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { MapControlButton } from './MapControlButton';
import { PressableScale } from './PressableScale';
import { radii } from '../theme/shape';

/**
 * A trip under way is followed on its own Trip Details page (PlannedTripDetailView, or
 * RideGuideView for Route View's GO). What's left here: the page for a saved trip whose exact
 * route can't be restored yet, and the admin's checkpoint stepper shown on the live trip page.
 */

export type EnrouteLocationState = 'located' | 'loading' | 'unavailable' | 'stale' | 'poor-accuracy' | 'off-route';

type EnrouteRecoveryViewProps = {
  destination: string;
  loading?: boolean;
  onBack: () => void;
  onEnd: () => void;
  onRetry: () => void;
};

type TripDemoControlsProps = {
  checkpoints: readonly NavigationCheckpoint[];
  /** Where the trip is now, so the stepper starts there. */
  initialIndex: number;
  onCheckpoint: (checkpoint: NavigationCheckpoint, index: number) => void;
  onReset: () => void;
};

/** Admin only: moves the mock location through the trip's checkpoints, to walk a trip without walking it. */
export function TripDemoControls({ checkpoints, initialIndex, onCheckpoint, onReset }: TripDemoControlsProps) {
  const styles = useThemedStyles(createStyles);
  const [demoIndex, setDemoIndex] = useState(Math.max(0, initialIndex));
  const moveDemo = (index: number) => {
    const bounded = Math.max(0, Math.min(checkpoints.length - 1, index));
    const checkpoint = checkpoints[bounded];
    if (!checkpoint) return;
    setDemoIndex(bounded);
    onCheckpoint(checkpoint, bounded);
  };
  return (
    <View style={styles.demoPanel} testID="trip-demo-controls">
      <View style={styles.demoHeadingRow}>
        <Text style={styles.demoTitle}>Admin trip checkpoints</Text>
        <PressableScale accessibilityLabel="Reset trip simulation" accessibilityRole="button" onPress={() => {
          setDemoIndex(0);
          onReset();
        }} style={styles.demoReset} testID="trip-demo-reset">
          <Icon name="refresh" size={16} />
          <Text style={styles.demoResetText}>Reset</Text>
        </PressableScale>
      </View>
      <ScrollView contentContainerStyle={styles.checkpointList} horizontal={true} showsHorizontalScrollIndicator={false}>
        {checkpoints.map((checkpoint, index) => (
          <PressableScale
            key={checkpoint.key}
            accessibilityLabel={`Move mock location to ${checkpoint.label}`}
            accessibilityRole="button"
            accessibilityState={{ selected: index === demoIndex }}
            onPress={() => moveDemo(index)}
            style={[styles.checkpoint, index === demoIndex && styles.selectedCheckpoint]}
            testID={`trip-demo-checkpoint-${index}`}
          >
            <Text style={[styles.checkpointText, index === demoIndex && styles.selectedCheckpointText]}>{checkpoint.label}</Text>
          </PressableScale>
        ))}
      </ScrollView>
      <View style={styles.demoActions}>
        <PressableScale accessibilityLabel="Previous demo checkpoint" accessibilityRole="button" disabled={demoIndex === 0} onPress={() => moveDemo(demoIndex - 1)} style={[styles.demoStep, demoIndex === 0 && styles.disabled]} testID="trip-demo-previous">
          <Icon name="back" size={18} /><Text style={styles.demoStepText}>Previous</Text>
        </PressableScale>
        <Text style={styles.demoCount}>{`${demoIndex + 1} / ${checkpoints.length}`}</Text>
        <PressableScale accessibilityLabel="Next demo checkpoint" accessibilityRole="button" disabled={demoIndex >= checkpoints.length - 1} onPress={() => moveDemo(demoIndex + 1)} style={[styles.demoStep, demoIndex >= checkpoints.length - 1 && styles.disabled]} testID="trip-demo-next">
          <Text style={styles.demoStepText}>Next</Text><Icon name="forward" size={18} />
        </PressableScale>
      </View>
    </View>
  );
}

/** Safe relaunch state when the exact selected itinerary cannot currently be reproduced. */
export function EnrouteRecoveryView({ destination, loading = false, onBack, onEnd, onRetry }: EnrouteRecoveryViewProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  return (
    <View style={styles.recoveryViewport} testID="enroute-recovery-view">
      <ThemedStatusBar />
      <SafeAreaView edges={['top', 'bottom']} style={styles.recoverySafeArea}>
        <MapControlButton accessibilityLabel="Back to Home; trip recovery will stay available" icon="back" onPress={onBack} testID="enroute-recovery-back" />
        <View accessibilityLiveRegion="polite" style={styles.recoveryCard}>
          <View style={styles.recoveryIcon}><Icon color={colors.warning} name="alert" size={30} /></View>
          <Text style={styles.recoveryTitle}>We can’t restore the exact route yet</Text>
          <Text style={styles.recoveryBody}>{`Your trip to ${destination} is still saved. Retry when you’re online, or end it without switching you to a different route.`}</Text>
          <PressableScale
            accessibilityLabel="Retry restoring the exact route"
            accessibilityRole="button"
            disabled={loading}
            onPress={onRetry}
            style={[styles.recoveryPrimary, loading && styles.disabled]}
            testID="enroute-recovery-retry"
          >
            {loading ? <ActivityIndicator color={colors.onPrimary} /> : <Icon color={colors.onPrimary} name="refresh" size={19} />}
            <Text style={styles.recoveryPrimaryText}>{loading ? 'Retrying…' : 'Retry exact route'}</Text>
          </PressableScale>
          <PressableScale accessibilityRole="button" onPress={() => setConfirmingEnd(true)} style={styles.recoveryEnd} testID="enroute-recovery-end">
            <Text style={styles.recoveryEndText}>End this trip</Text>
          </PressableScale>
        </View>
      </SafeAreaView>
      <ConfirmDialog
        body="This saved trip will end."
        confirmLabel="End trip"
        destructive={true}
        onCancel={() => setConfirmingEnd(false)}
        onConfirm={() => {
          setConfirmingEnd(false);
          onEnd();
        }}
        testID="enroute-recovery-end-confirm"
        title="End this trip?"
        visible={confirmingEnd}
      />
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  recoveryViewport: { flex: 1, alignItems: 'center', backgroundColor: colors.background },
  recoverySafeArea: { width: '100%', maxWidth: 540, flex: 1, padding: 16, backgroundColor: colors.canvas },
  recoveryCard: { marginTop: 80, alignItems: 'center', padding: 24, borderWidth: 1, borderColor: colors.border, borderRadius: radii.card, backgroundColor: colors.surface },
  recoveryIcon: { width: 60, height: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 30, backgroundColor: colors.amberSoft },
  recoveryTitle: { marginTop: 18, color: colors.ink, ...typography.sectionHeading, fontSize: 22, textAlign: 'center' },
  recoveryBody: { marginTop: 10, color: colors.mutedInk, ...typography.body, lineHeight: 22, textAlign: 'center' },
  recoveryPrimary: { minHeight: 50, alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 22, borderRadius: radii.pill, backgroundColor: colors.primary },
  recoveryPrimaryText: { color: colors.onPrimary, ...typography.bodyStrong },
  recoveryEnd: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8, paddingHorizontal: 20 },
  recoveryEndText: { color: colors.red, ...typography.bodyStrong },
  demoPanel: { marginBottom: 12, padding: 15, borderWidth: 1, borderColor: colors.accent, borderRadius: radii.card, backgroundColor: colors.blueSoft },
  demoHeadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  demoTitle: { color: colors.ink, ...typography.bodyStrong, fontSize: 16 },
  demoReset: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 7, borderRadius: radii.pill, backgroundColor: colors.surface },
  demoResetText: { color: colors.primary, ...typography.metadata },
  checkpointList: { gap: 8, paddingVertical: 12 },
  checkpoint: { maxWidth: 170, paddingHorizontal: 11, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: radii.control, backgroundColor: colors.surface },
  selectedCheckpoint: { borderColor: colors.primary, backgroundColor: colors.primary },
  checkpointText: { color: colors.ink, ...typography.metadata },
  selectedCheckpointText: { color: colors.onPrimary },
  demoActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  demoStep: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 11, borderRadius: radii.control, backgroundColor: colors.surface },
  demoStepText: { color: colors.primary, ...typography.bodyStrong, fontSize: 13 },
  demoCount: { color: colors.mutedInk, ...typography.metadata },
  disabled: { opacity: 0.4 },
});
