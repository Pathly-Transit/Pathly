import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { radii } from '../theme/shape';
import { fontFamilies, typography } from '../theme/typography';
import { AnimatedSwitch } from './AnimatedSwitch';
import { Icon } from './Icon';
import { PressableScale } from './PressableScale';

/**
 * The settings screens' shared pieces (ProfileView, SettingsPages, and the admin tools): the page
 * header, cards, rows, and their styles.
 */

export function Header({ onBack, testID = 'settings-back', title }: { onBack: () => void; testID?: string; title: string }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.header}><PressableScale accessibilityLabel="Back" accessibilityRole="button" onPress={onBack} style={styles.backButton} testID={testID}><Icon name="back" size={26} /></PressableScale><Text numberOfLines={1} style={styles.title}>{title}</Text></View>;
}

export function Card({ children }: { children: ReactNode }) { const styles = useThemedStyles(createStyles); return <View style={styles.card}>{children}</View>; }

export function SettingRow({ detail, label, onPress, testID }: { detail?: string; label: string; onPress?: () => void; testID?: string }) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  return <PressableScale accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress} style={styles.settingRow} testID={testID}><View style={styles.rowCopy}><Text style={styles.settingText}>{label}</Text>{detail ? <Text style={styles.settingDetail}>{detail}</Text> : null}</View>{onPress ? <Icon color={colors.mutedInk} name="forward" size={20} /> : null}</PressableScale>;
}

export function ToggleRow({ detail, label, onChange, testID, value }: { detail?: string; label: string; onChange: (value: boolean) => void; testID: string; value: boolean }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.settingRow}><View style={styles.rowCopy}><Text style={styles.settingText}>{label}</Text>{detail ? <Text style={styles.settingDetail}>{detail}</Text> : null}</View><AnimatedSwitch accessibilityLabel={label} onValueChange={onChange} testID={testID} value={value} /></View>;
}

export function ChoiceRow({ label, onSelect, options, selected, testPrefix }: { label: string; onSelect: (value: string) => void; options: readonly string[]; selected: string; testPrefix: string }) {
  const styles = useThemedStyles(createStyles);
  return <View style={styles.choiceBlock}><Text style={styles.settingText}>{label}</Text><View style={styles.choices}>{options.map((option) => <Pressable accessibilityRole="button" accessibilityState={{ selected: selected === option }} key={option} onPress={() => onSelect(option)} style={[styles.choice, selected === option && styles.choiceSelected]} testID={`${testPrefix}-${option.toLowerCase().replaceAll(' ', '-')}`}><Text style={[styles.choiceText, selected === option && styles.choiceTextSelected]}>{option}</Text></Pressable>)}</View></View>;
}

export const createStyles = (colors: Palette) => StyleSheet.create({
  viewport: { flex: 1, alignItems: 'center', backgroundColor: colors.background }, screen: { width: '100%', maxWidth: 540, flex: 1, paddingHorizontal: 18, backgroundColor: colors.background }, header: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12 }, backButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: colors.surface, shadowColor: colors.shadow, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 6, elevation: 2 }, title: { minWidth: 0, flex: 1, color: colors.ink, ...typography.screenHeading, fontSize: 24 }, pageContent: { paddingBottom: 34 },
  hero: { alignItems: 'center', marginTop: 10, marginBottom: 6 }, heroName: { marginTop: 12, color: colors.ink, textAlign: 'center', ...typography.screenHeading }, heroDetail: { marginTop: 4, color: colors.mutedInk, textAlign: 'center', ...typography.metadata },
  intro: { marginTop: 4, marginBottom: 16, color: colors.mutedInk, ...typography.body }, accountCard: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 10, padding: 18, borderRadius: radii.card, backgroundColor: colors.surface }, avatar: { width: 58, height: 58, alignItems: 'center', justifyContent: 'center', borderRadius: 29, backgroundColor: colors.primary }, name: { color: colors.ink, ...typography.sectionHeading, fontSize: 18 }, guest: { marginTop: 3, color: colors.mutedInk, ...typography.metadata }, sectionLabel: { marginTop: 24, marginBottom: 9, color: colors.mutedInk, ...typography.label }, card: { overflow: 'hidden', borderWidth: 1, borderColor: colors.border, borderRadius: 18, backgroundColor: colors.surface }, settingRow: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 15, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }, rowCopy: { minWidth: 0, flex: 1 }, rowIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 11, backgroundColor: colors.blueSoft }, settingText: { color: colors.ink, ...typography.bodyStrong, fontSize: 15 }, settingDetail: { marginTop: 2, color: colors.mutedInk, ...typography.metadata, fontSize: 10 },
  choiceBlock: { padding: 15, borderBottomWidth: 1, borderBottomColor: colors.border }, swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 }, swatch: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, borderWidth: 3, borderColor: 'transparent' }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 }, choice: { minHeight: 36, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 13, borderWidth: 1, borderColor: colors.border, borderRadius: radii.card, backgroundColor: colors.background }, choiceSelected: { borderColor: colors.primary, backgroundColor: colors.blueSoft }, choiceText: { color: colors.mutedInk, ...typography.metadata }, choiceTextSelected: { color: colors.primary, fontFamily: fontFamilies.extraBold }, note: { marginTop: 12, color: colors.mutedInk, ...typography.metadata }, primaryAction: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 16, borderRadius: 16, backgroundColor: colors.primary }, primaryActionText: { color: colors.onPrimary, fontFamily: fontFamilies.extraBold, fontSize: 15 }, supportIcon: { backgroundColor: colors.highlightSoft }, aboutMascot: { marginBottom: 10 }, aboutNote: { maxWidth: 320, marginTop: 12, color: colors.mutedInk, ...typography.metadata, lineHeight: 18, textAlign: 'center' }, versionCard: { alignItems: 'center', marginTop: 22, padding: 18 }, versionName: { color: colors.ink, ...typography.bodyStrong }, version: { marginTop: 3, color: colors.mutedInk, ...typography.metadata }, hubCard: { marginTop: 16 },
  sheetViewport: { flex: 1, justifyContent: 'flex-end' }, sheetBackdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim }, sheet: { width: '100%', maxWidth: 540, alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 30, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, backgroundColor: colors.background }, sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }, sheetTitle: { color: colors.ink, ...typography.sectionHeading, fontSize: 20 },
  signOut: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 22, borderWidth: 1, borderColor: colors.red, borderRadius: 16, backgroundColor: colors.surface }, signOutText: { color: colors.red, fontFamily: fontFamilies.extraBold, fontSize: 15 },
});
