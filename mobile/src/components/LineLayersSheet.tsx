import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LINE_LAYER_GROUPS, LINE_LAYER_MODES, lineLayerRouteKey, type LineLayerChoice, type LineLayerGroupId, type LineLayerRoute } from '../data/lineLayers';
import { useTheme, useThemedStyles } from '../theme/AppSettings';
import type { Palette } from '../theme/colors';
import { typography } from '../theme/typography';
import { SheetPanel } from './SheetPanel';
import { AnimatedSwitch } from './AnimatedSwitch';
import { Icon, type IconName } from './Icon';
import { PressableScale } from './PressableScale';
import { RouteBadge } from './RouteBadge';
import { radii } from '../theme/shape';

type LineLayersSheetProps = {
  visible: boolean;
  choice: LineLayerChoice;
  /** Lines to offer one by one: the rider's saved lines, then the ones nearby. */
  lines: readonly (LineLayerRoute & { agency: string })[];
  onChange: (choice: LineLayerChoice) => void;
  onClose: () => void;
};

/**
 * The home map's line layers: switch on every line an agency runs (sorted under Trains, Buses, and
 * Ferries, each with a switch-all), or single lines. Only the home map draws them; route view always shows just its own line.
 */
export function LineLayersSheet({ choice, lines, onChange, onClose, visible }: LineLayersSheetProps) {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const shownRoutes = new Set(choice.routes.map(lineLayerRouteKey));
  const setGroups = (ids: readonly LineLayerGroupId[], on: boolean) => onChange({
    ...choice,
    groups: on ? [...choice.groups, ...ids.filter((id) => !choice.groups.includes(id))] : choice.groups.filter((group) => !ids.includes(group)),
  });
  const toggleRoute = (route: LineLayerRoute, on: boolean) => onChange({
    ...choice,
    routes: on
      ? [...choice.routes, { agencyId: route.agencyId, routeId: route.routeId, shortName: route.shortName, color: route.color }]
      : choice.routes.filter((shown) => lineLayerRouteKey(shown) !== lineLayerRouteKey(route)),
  });
  // Lines switched on earlier stay listed, even once they're no longer nearby or saved.
  const offered = [...lines, ...choice.routes.filter((route) => !lines.some((line) => lineLayerRouteKey(line) === lineLayerRouteKey(route))).map((route) => ({ ...route, agency: '' }))];
  const anyOn = choice.groups.length > 0 || choice.routes.length > 0;
  return (
    <Modal animationType="fade" onRequestClose={onClose} statusBarTranslucent={true} transparent={true} visible={visible}>
      <View style={styles.viewport}>
        <Pressable accessibilityLabel="Close" onPress={onClose} style={styles.backdrop} testID="line-layers-backdrop" />
        <SheetPanel accessibilityViewIsModal={true} style={styles.sheet} testID="line-layers-sheet">
          <View style={styles.header}>
            <Text style={styles.title}>Map routes</Text>
            {anyOn ? (
              <PressableScale accessibilityRole="button" hitSlop={8} onPress={() => onChange({ groups: [], routes: [] })} testID="line-layers-clear">
                <Text style={styles.clear}>Hide all</Text>
              </PressableScale>
            ) : null}
            <PressableScale accessibilityLabel="Close" accessibilityRole="button" hitSlop={8} onPress={onClose} testID="line-layers-close"><Icon name="close" size={26} /></PressableScale>
          </View>
          <ScrollView bounces={false} style={styles.list}>
            {/* Every line an agency runs, switched on all at once; agencies sorted by mode. */}
            {LINE_LAYER_MODES.map((mode) => {
              const groups = LINE_LAYER_GROUPS.filter((group) => group.mode === mode.id);
              const ids = groups.map((group) => group.id);
              const allOn = ids.every((id) => choice.groups.includes(id));
              return (
                <View key={mode.id}>
                  <View style={styles.sectionHeader}>
                    <Text accessibilityRole="header" style={[styles.sectionLabel, styles.sectionTitle]} testID={`line-layers-mode-${mode.id}`}>{mode.label}</Text>
                    <PressableScale
                      accessibilityLabel={`${allOn ? 'Hide' : 'Show'} all ${mode.label.toLowerCase()}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => setGroups(ids, !allOn)}
                      testID={`line-layers-mode-${mode.id}-all`}
                    >
                      <Text style={styles.sectionAction}>{allOn ? 'Hide all' : 'Show all'}</Text>
                    </PressableScale>
                  </View>
                  {groups.map((group) => (
                    <View key={group.id} style={styles.row}>
                      <View style={styles.modeIcon}><Icon color={colors.primary} name={group.icon as IconName} size={18} /></View>
                      <Text style={styles.rowText}>{group.label}</Text>
                      <AnimatedSwitch accessibilityLabel={`Show every ${group.label} line`} onValueChange={(value) => setGroups([group.id], value)} testID={`line-layer-group-${group.id}`} value={choice.groups.includes(group.id)} />
                    </View>
                  ))}
                </View>
              );
            })}
            {/* One line at a time: the rider's saved lines and the ones near them. */}
            {offered.length > 0 ? <Text accessibilityRole="header" style={styles.sectionLabel} testID="line-layers-nearby-heading">Show nearby and saved lines</Text> : null}
            {offered.map((line) => {
              const key = lineLayerRouteKey(line);
              return (
                <View key={key} style={styles.row}>
                  <RouteBadge agency={line.agency} color={line.color} shortName={line.shortName} />
                  <Text numberOfLines={1} style={styles.rowText}>{line.agency}</Text>
                  <AnimatedSwitch accessibilityLabel={`Show the ${line.shortName} line`} onValueChange={(value) => toggleRoute(line, value)} testID={`line-layer-route-${key}`} value={shownRoutes.has(key)} />
                </View>
              );
            })}
          </ScrollView>
        </SheetPanel>
      </View>
    </Modal>
  );
}

const createStyles = (colors: Palette) => StyleSheet.create({
  viewport: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.scrim },
  sheet: { width: '100%', maxWidth: 540, maxHeight: '80%', alignSelf: 'center', paddingHorizontal: 18, paddingTop: 18, paddingBottom: 30, borderTopLeftRadius: radii.sheet, borderTopRightRadius: radii.sheet, backgroundColor: colors.surface },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { flex: 1, color: colors.ink, ...typography.sectionHeading, fontSize: 18 },
  clear: { color: colors.primary, ...typography.bodyStrong, fontSize: 14 },
  list: { flexGrow: 0, marginTop: 6 },
  sectionLabel: { marginTop: 16, marginBottom: 4, color: colors.mutedInk, ...typography.label },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 },
  sectionTitle: { flex: 1 },
  sectionAction: { marginBottom: 4, color: colors.primary, ...typography.bodyStrong, fontSize: 13 },
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modeIcon: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 17, backgroundColor: colors.blueSoft },
  rowText: { flex: 1, minWidth: 0, color: colors.ink, ...typography.bodyStrong, fontSize: 15 },
});
