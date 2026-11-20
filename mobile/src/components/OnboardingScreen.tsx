import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../auth/AuthContext';
import { findLabeledLocation, saveLabeledLocation, subscribeToSavedLocations, type SavedLocation } from '../data/userData';
import { ThemedStatusBar, useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { fontFamilies, typography } from '../theme/typography';
import { radii } from '../theme/shape';
import { Icon } from './Icon';
import { Mascot } from './Mascot';
import { PressableScale } from './PressableScale';
import { SearchView } from './SearchView';

const ROWS = [
  { label: 'Home', icon: 'home' },
  { label: 'Work', icon: 'work' },
  { label: 'School', icon: 'school' },
] as const;
type PlaceLabel = (typeof ROWS)[number]['label'];

/** Enough to find Home, Work and School among them. */
const MAX_SAVED_LOCATIONS = 50;

/**
 * A new account's first page, between sign-up and the app: its usual places, each optional. Asked
 * once; after that, Favorites are added from Settings or the star, with no reminders.
 */
export function OnboardingScreen({ onDone }: { onDone: () => void }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const { user } = useAuth();
  const uid = user?.uid;
  const [places, setPlaces] = useState<readonly SavedLocation[]>([]);
  const [picking, setPicking] = useState<PlaceLabel | null>(null);

  useEffect(() => {
    if (!uid) return undefined;
    return subscribeToSavedLocations(uid, MAX_SAVED_LOCATIONS, setPlaces);
  }, [uid]);

  if (picking) {
    return (
      <SearchView
        key={`onboarding-${picking}`}
        onCancel={() => setPicking(null)}
        onSelect={(place) => {
          // The listener shows the saved place on its row; a rejected write leaves the row unset.
          if (uid) saveLabeledLocation(uid, place, picking, places).catch(() => undefined);
          setPicking(null);
        }}
        placeholder={`Search for your ${picking.toLowerCase()} address`}
      />
    );
  }

  const anySet = ROWS.some((row) => findLabeledLocation(places, row.label));
  return (
    <View style={styles.viewport}>
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen} testID="onboarding-screen">
        <ThemedStatusBar />
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Mascot mood="happy" size={76} style={styles.mascot} />
          <Text style={styles.heading}>Where do you usually go?</Text>
          <Text style={styles.body}>Add your places to Favorites and they&apos;re one tap from a trip. You can change them anytime in Settings.</Text>
          <View style={styles.rows}>
            {ROWS.map((row) => {
              const saved = findLabeledLocation(places, row.label);
              return (
                <PressableScale
                  accessibilityHint={saved ? `Changes your ${row.label.toLowerCase()} address` : `Searches for your ${row.label.toLowerCase()} address`}
                  accessibilityLabel={saved ? `${row.label}, ${saved.address.name}` : `Set ${row.label.toLowerCase()}`}
                  accessibilityRole="button"
                  key={row.label}
                  onPress={() => setPicking(row.label)}
                  style={styles.row}
                  testID={`onboarding-${row.label.toLowerCase()}`}
                >
                  <View style={styles.rowIcon}><Icon color={colors.primary} name={row.icon} size={19} /></View>
                  <View style={styles.rowCopy}>
                    <Text style={styles.rowTitle}>{row.label}</Text>
                    <Text numberOfLines={1} style={styles.rowDetail}>{saved ? saved.address.name : `Set your ${row.label.toLowerCase()} address`}</Text>
                  </View>
                  <Icon color={saved ? colors.primary : colors.mutedInk} name={saved ? 'check' : 'forward'} size={20} />
                </PressableScale>
              );
            })}
          </View>
          <PressableScale accessibilityRole="button" onPress={onDone} style={[styles.done, anySet && styles.doneFilled]} testID="onboarding-done">
            <Text style={anySet ? styles.doneFilledText : styles.doneText}>{anySet ? 'Continue' : 'Skip for now'}</Text>
          </PressableScale>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  viewport: { flex: 1, alignItems: 'center', backgroundColor: colors.background },
  screen: { width: '100%', maxWidth: 540, flex: 1, paddingHorizontal: 24, backgroundColor: colors.background },
  content: { flexGrow: 1, justifyContent: 'center', paddingVertical: 32 },
  mascot: { marginBottom: 18 },
  heading: { marginBottom: 12, color: colors.ink, ...typography.screenHeading },
  body: { color: colors.mutedInk, ...typography.body },
  rows: { marginTop: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: colors.blueSoft },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, ...typography.bodyStrong, fontSize: 15 },
  rowDetail: { color: colors.mutedInk, ...typography.metadata, fontSize: 13 },
  done: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 24, borderRadius: radii.pill },
  doneFilled: { backgroundColor: colors.primary },
  doneText: { color: colors.mutedInk, ...typography.bodyStrong, fontSize: 15 },
  doneFilledText: { color: colors.onPrimary, fontFamily: fontFamilies.extraBold, fontSize: 15 },
});
