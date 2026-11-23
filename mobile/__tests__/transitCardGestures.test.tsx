import { fireEvent, render } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { PressableScale } from '../src/components/PressableScale';
import { TransitCard } from '../src/components/TransitCard';
import { routeById } from '../src/data/transit';
import { AppSettingsProvider } from '../src/theme/AppSettings';

afterEach(() => jest.restoreAllMocks());

it.each(['ios', 'android', 'web'] as const)('keeps %s presses immediate and suppresses the drag click without losing the next tap', (platform) => {
  jest.replaceProperty(Platform, 'OS', platform);
  const onPress = jest.fn();
  const route = routeById.ronkonkoma;
  const screen = render(<AppSettingsProvider initialReducedMotion={true}><TransitCard onPress={onPress} route={route} /></AppSettingsProvider>);
  const page = screen.getByTestId(`route-card-${route.id}-primary`);
  const timing = screen.UNSAFE_getAllByType(PressableScale)[0]!.props;
  expect(platform === 'web' ? timing.delayPressIn : timing.unstable_pressDelay).toBe(0);
  expect(platform === 'web' ? timing.unstable_pressDelay : timing.delayPressIn).toBeUndefined();
  // A quick drag can still end in a web click after the outer pager captures it.
  fireEvent(page, 'pressIn', { nativeEvent: { pageX: 100, pageY: 100 } });
  fireEvent(page, 'pressOut', { nativeEvent: { pageX: 125, pageY: 102 } });
  fireEvent.press(page);
  expect(onPress).not.toHaveBeenCalled();
  // The following stationary tap must not inherit the canceled press.
  fireEvent(page, 'pressIn', { nativeEvent: { pageX: 125, pageY: 102 } });
  fireEvent(page, 'pressOut', { nativeEvent: { pageX: 125, pageY: 102 } });
  fireEvent.press(page);
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(onPress).toHaveBeenLastCalledWith(0);
  fireEvent.press(page); // Keyboard activation has no pointer events.
  expect(onPress).toHaveBeenCalledTimes(2);
});
