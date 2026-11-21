import { waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { clearTripNotification, showTripNotificationAccepted } from '../src/lib/notifications';

const ownerA = { uid: 'alice', sessionId: 'trip-a' };
const ownerB = { uid: 'bob', sessionId: 'trip-b' };
const schedule = Notifications.scheduleNotificationAsync as jest.Mock;
const permission = Notifications.getPermissionsAsync as jest.Mock;
const dismiss = Notifications.dismissNotificationAsync as jest.Mock;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(async () => {
  jest.replaceProperty(Platform, 'OS', 'ios');
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  await clearTripNotification();
  jest.clearAllMocks();
  schedule.mockResolvedValue('notification');
  permission.mockResolvedValue({ granted: true, canAskAgain: true });
});
afterEach(async () => { await clearTripNotification(); jest.restoreAllMocks(); });

it('returns false for rejected OS scheduling and never prompts from a no-prompt sender', async () => {
  permission.mockResolvedValue({ granted: false, canAskAgain: true });
  expect(await showTripNotificationAccepted('Warning', 'Next stop', true, { owner: ownerA, requestPermission: false })).toBe(false);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  permission.mockResolvedValue({ granted: true });
  schedule.mockRejectedValueOnce(new Error('OS failure'));
  expect(await showTripNotificationAccepted('Warning', 'Next stop', true, { owner: ownerA, requestPermission: false })).toBe(false);
});

it('keeps newer foreground progress after an older background OS post resolves late', async () => {
  const pending = deferred<string>();
  const events: string[] = [];
  schedule.mockImplementationOnce(async () => { events.push('old-start'); await pending.promise; events.push('old-finish'); return 'old'; })
    .mockImplementationOnce(async () => { events.push('new'); return 'new'; });
  const background = showTripNotificationAccepted('Old background instruction', 'Old', false, { owner: ownerA, requestPermission: false });
  await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  const foreground = showTripNotificationAccepted('New foreground instruction', 'New', false, { owner: ownerA });
  pending.resolve('old');
  expect(await background).toBe(true);
  expect(await foreground).toBe(true);
  expect(events).toEqual(['old-start', 'old-finish', 'new']);
  expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.objectContaining({ title: 'New foreground instruction' }) }));
});

it('does not let A cleanup invalidate or dismiss a new B post still preparing permissions', async () => {
  expect(await showTripNotificationAccepted('A', 'A', false, { owner: ownerA })).toBe(true);
  const permissionB = deferred<{ granted: boolean }>();
  permission.mockReturnValueOnce(permissionB.promise);
  const next = showTripNotificationAccepted('B', 'B', false, { owner: ownerB });
  await waitFor(() => expect(permission).toHaveBeenCalledTimes(2));
  await clearTripNotification(ownerA);
  permissionB.resolve({ granted: true });
  expect(await next).toBe(true);
  const count = dismiss.mock.calls.length;
  await clearTripNotification(ownerA);
  expect(dismiss).toHaveBeenCalledTimes(count);
  expect(schedule).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.objectContaining({ title: 'B' }) }));
});

it('checks current owner/instruction immediately before a queued native post', async () => {
  const pending = deferred<string>();
  schedule.mockReturnValueOnce(pending.promise);
  const first = showTripNotificationAccepted('Old', 'Old', false, { owner: ownerA });
  await waitFor(() => expect(schedule).toHaveBeenCalledTimes(1));
  let valid = true;
  const next = showTripNotificationAccepted('Stale', 'Stale', true, { owner: ownerA, isCurrent: () => valid, requestPermission: false });
  valid = false;
  pending.resolve('old');
  await first;
  expect(await next).toBe(false);
  expect(schedule).toHaveBeenCalledTimes(1);
});
