import { StyleSheet, Text, View } from 'react-native';

import { departureDisplay } from '../data/transit';
import { fontFamilies } from '../theme/typography';
import { LIVE_SIGNAL_WIDTH, LiveSignal } from './LiveSignal';

type ArrivalTimeProps = {
  color: string;
  live: boolean;
  minutes: number;
  testID?: string;
};

/**
 * A big "5" over a small "minutes" (or a clock time past an hour), with the live signal beside
 * live times: the same look as Route View's departure tiles and the home cards.
 */
export function ArrivalTime({ color, live, minutes, testID }: ArrivalTimeProps) {
  const timing = departureDisplay(minutes);
  const isClockTime = timing.value.includes(':');
  return (
    <View accessibilityLabel={`Arrives in ${timing.accessibility}${live ? ', live' : ''}`} accessible={true} style={styles.timing} testID={testID}>
      <View style={styles.row}>
        {/* The spacer mirrors the signal so the number stays centered over its unit. */}
        {live && !isClockTime ? <View style={styles.signalSpacer} /> : null}
        <Text numberOfLines={1} style={[styles.value, isClockTime && styles.clockValue, { color }]}>{timing.value}</Text>
        {live ? <LiveSignal color={color} style={styles.signal} /> : null}
      </View>
      <Text numberOfLines={1} style={[styles.unit, { color }]}>{timing.unit}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  timing: { alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center' },
  signalSpacer: { width: LIVE_SIGNAL_WIDTH },
  signal: { marginLeft: 2, marginTop: 6 },
  value: { fontFamily: fontFamilies.extraBold, fontSize: 38, lineHeight: 44 },
  clockValue: { fontSize: 24, lineHeight: 44 },
  unit: { marginTop: -4, fontFamily: fontFamilies.bold, fontSize: 12 },
});
