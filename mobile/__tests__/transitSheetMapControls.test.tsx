import { Children, isValidElement, type ReactNode } from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { Animated, Platform, ScrollView, StyleSheet, View } from 'react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { CurrentLocationButton } from '../src/components/CurrentLocationButton';
import { SHEET_LOWER_DROP } from '../src/components/mapSheetLayout';
import { TransitSheet } from '../src/components/TransitSheet';
import { AppSettingsProvider } from '../src/theme/AppSettings';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

function containsTestId(node: ReactNode, testID: string): boolean {
  return Children.toArray(node).some((child) => isValidElement<{ children?: ReactNode; testID?: string }>(child)
    && (child.props.testID === testID || containsTestId(child.props.children, testID)));
}

describe('native Home map controls', () => {
  const originalPlatform = Platform.OS;

  afterEach(() => {
    Platform.OS = originalPlatform;
  });

  it.each(['ios', 'android'] as const)('keeps Locate outside the sticky map header on %s', async (platform) => {
    Platform.OS = platform;
    const onLocate = jest.fn();
    const mapHeight = 450;
    const screen = render(
      <AppSettingsProvider>
        <TransitSheet
          activeTab="nearby"
          findRoute={() => undefined}
          mapButtons={<View testID="fixture-map-controls"><CurrentLocationButton onPress={onLocate} /></View>}
          mapHeight={mapHeight}
          nearbyRoutes={[]}
          nearbyStatus="loaded"
          onOpenRoute={jest.fn()}
          onOpenSavedLocation={jest.fn()}
          onTabChange={jest.fn()}
          savedLocations={[]}
          savedRouteIds={[]}
          scrollY={new Animated.Value(SHEET_LOWER_DROP)}
          webMap={<View testID="fixture-home-map" />}
        />
      </AppSettingsProvider>,
    );
    await act(async () => undefined);

    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.props.stickyHeaderIndices).toEqual([0]);
    // Native ScrollView uses Children.toArray before applying stickyHeaderIndices. A Fragment
    // remains one child, so wrapping the map and controls together makes both stick: Locate
    // then sits below the sheet at the initial 208 pt scroll offset.
    const directChildren = Children.toArray(scroll.props.children);
    const stickyMap = directChildren[scroll.props.stickyHeaderIndices[0]];
    expect(containsTestId(stickyMap, 'fixture-home-map')).toBe(true);
    expect(containsTestId(stickyMap, 'fixture-map-controls')).toBe(false);
    expect(isValidElement<{ testID?: string }>(stickyMap) && stickyMap.props.testID).toBe('transit-map-window');

    const overlay = directChildren[1];
    expect(containsTestId(overlay, 'fixture-map-controls')).toBe(true);
    expect(isValidElement<{ style?: object }>(overlay) && StyleSheet.flatten(overlay.props.style)).toMatchObject({
      height: mapHeight + SHEET_LOWER_DROP,
      marginTop: -(mapHeight + SHEET_LOWER_DROP),
      paddingTop: SHEET_LOWER_DROP,
      zIndex: 11,
    });
    expect(scroll.props.contentOffset).toEqual({ x: 0, y: SHEET_LOWER_DROP });
    fireEvent.press(screen.getByLabelText('Center on current location'));
    expect(onLocate).toHaveBeenCalledTimes(1);
  });
});
