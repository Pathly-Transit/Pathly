import * as Notifications from 'expo-notifications';
import { AppState } from 'react-native';

import { notifyTripDisruptionAccepted, TRIP_DISRUPTION_ID_PREFIX } from '../src/lib/notifications';

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});

it('uses ordinary OS sound configuration for a major change and never asks for permission mid-trip', async () => {
  expect(await notifyTripDisruptionAccepted('alice:trip:incident', 'Train interrupted', 'Follow the updated route.', () => true)).toBe(true);
  expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
    identifier: expect.stringContaining(TRIP_DISRUPTION_ID_PREFIX),
    content: expect.objectContaining({ sound: 'default', interruptionLevel: 'active', data: { kind: 'active-trip-change' } }),
  }));
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
});

it('honors denied permission and a trip that ends while permission is checked', async () => {
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false, canAskAgain: true });
  expect(await notifyTripDisruptionAccepted('incident', 'Train interrupted', 'Updated route', () => true)).toBe(false);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  let current = true;
  (Notifications.getPermissionsAsync as jest.Mock).mockImplementationOnce(async () => { current = false; return { granted: true }; });
  expect(await notifyTripDisruptionAccepted('incident', 'Train interrupted', 'Updated route', () => current)).toBe(false);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});
