import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import * as Speech from 'expo-speech';
import { AppState } from 'react-native';

import { deliverTripApproach } from '../src/background/tripAlertStorage';
import type { NavigationGuidance } from '../src/data/enrouteNavigation';
import { useTripGuidanceAlerts } from '../src/hooks/useTripGuidanceAlerts';

jest.mock('../src/background/tripAlertStorage', () => ({ deliverTripApproach: jest.fn() }));
const claim = deliverTripApproach as jest.Mock;
const guidance = (phase: NavigationGuidance['phase'], changes: Partial<NavigationGuidance> = {}): NavigationGuidance => ({
  phase, currentAction: 'Board at Penn Station', nextAction: 'Ride toward Jamaica', currentStopName: null,
  nextStopName: null, remainingStops: null, line: null, headsign: null,
  departureTime: null, arrivalTime: '2026-11-21T18:00:00-05:00', distanceMeters: null, durationSeconds: null, ...changes,
});
const boarding = guidance('waiting-to-board');
const approach = guidance('riding', { currentAction: 'Ride toward Jamaica', nextAction: 'Get off at Jamaica', nextStopName: 'Jamaica', remainingStops: 1 });
const walking = guidance('walking', { currentAction: 'Walk to your destination', nextAction: 'Arrive at your destination' });
type Props = { uid: string; sessionId: string; stepIndex: number; guidance: NavigationGuidance };
const render = (settings = { notification: true, voice: true, haptics: true }) => renderHook((props: Props) => useTripGuidanceAlerts({ ...props, arrivedDestination: null,
  settings, notificationsEnabled: true }), {
  initialProps: { uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: boarding },
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  claim.mockReset().mockImplementation(async (_owner, _step, deliver) => ({ firstWarning: true, accepted: await deliver(true) }));
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.clearAllMocks();
});

it('does not repeat the background-claimed warning as foreground speech or warning haptics', async () => {
  claim.mockImplementation(async (_owner, _step, deliver) => ({ firstWarning: false, accepted: await deliver(false) }));
  const hook = render();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledWith({ uid: 'alice', sessionId: 'trip-a' }, 1, expect.any(Function)));
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  hook.unmount();
});

it('does not let a delayed A claim announce after switching to B', async () => {
  const pending = deferred<boolean>();
  claim.mockImplementationOnce(async (_owner, _step, deliver) => { const firstWarning = await pending.promise; return { firstWarning, accepted: await deliver(firstWarning) }; });
  const hook = render();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
  hook.rerender({ uid: 'bob', sessionId: 'trip-b', stepIndex: 0, guidance: boarding });
  await act(async () => { pending.resolve(true); });
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  hook.unmount();
});

it('does not announce an old approach after the same trip has advanced to walking', async () => {
  const pending = deferred<boolean>();
  claim.mockImplementationOnce(async (_owner, _step, deliver) => { const firstWarning = await pending.promise; return { firstWarning, accepted: await deliver(firstWarning) }; });
  const hook = render();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 2, guidance: walking });
  (Speech.speak as jest.Mock).mockClear();
  (Haptics.notificationAsync as jest.Mock).mockClear();
  await act(async () => { pending.resolve(true); });
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  hook.unmount();
});

it('still delivers a warning when an in-flight claim sees an equivalent fresh guidance object', async () => {
  const pending = deferred<boolean>();
  claim.mockImplementationOnce(async (_owner, _step, deliver) => { const firstWarning = await pending.promise; return { firstWarning, accepted: await deliver(firstWarning) }; });
  const hook = render();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: { ...approach } });
  await act(async () => { pending.resolve(true); });
  expect(Speech.speak).toHaveBeenCalledTimes(1);
  expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Warning);
  hook.unmount();
});

it('does not speak or repost a deferred claim after the trip owner unmounts', async () => {
  const pending = deferred<boolean>();
  claim.mockImplementationOnce(async (_owner, _step, deliver) => { const firstWarning = await pending.promise; return { firstWarning, accepted: await deliver(firstWarning) }; });
  const hook = render();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
  hook.unmount();
  (Speech.speak as jest.Mock).mockClear();
  (Haptics.notificationAsync as jest.Mock).mockClear();
  (Notifications.scheduleNotificationAsync as jest.Mock).mockClear();
  await act(async () => { pending.resolve(true); });
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

it('retries a failed notification-only warning on the next fresh equivalent guidance', async () => {
  const hook = render({ notification: true, voice: false, haptics: false });
  await waitFor(() => expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled());
  (Notifications.scheduleNotificationAsync as jest.Mock).mockClear().mockRejectedValueOnce(new Error('OS post failed'));
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach });
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(1));
  expect(await claim.mock.results[0]!.value).toEqual({ firstWarning: true, accepted: false });
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: { ...approach } });
  await waitFor(() => expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(2));
  expect(await claim.mock.results[1]!.value).toEqual({ firstWarning: true, accepted: true });
  expect(Notifications.scheduleNotificationAsync).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.objectContaining({ sound: 'default' }) }));
  expect(Speech.speak).not.toHaveBeenCalled();
  expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  hook.unmount();
});

const permissionRender = () => renderHook((props: Props & { enabled: boolean }) => useTripGuidanceAlerts({ ...props,
  arrivedDestination: null, settings: { notification: props.enabled, voice: false, haptics: false }, notificationsEnabled: true }), {
  initialProps: { uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: boarding, enabled: false },
});

it('preflights first approach permission outside the ledger when notifications were previously off', async () => {
  const permission = Notifications.getPermissionsAsync as jest.Mock;
  permission.mockResolvedValue({ granted: false, canAskAgain: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockImplementationOnce(async () => {
    permission.mockResolvedValue({ granted: true });
    return { granted: true };
  });
  const hook = permissionRender();
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach, enabled: true });
  await waitFor(() => expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({ sound: 'default' }) })));
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  expect(claim).toHaveBeenCalledTimes(1);
  expect((Notifications.requestPermissionsAsync as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(claim.mock.invocationCallOrder[0]!);
  hook.unmount();
});

it('allows end cleanup while permission is pending and discards the late grant before ledger delivery', async () => {
  const pending = deferred<{ granted: boolean }>();
  (Notifications.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false, canAskAgain: true });
  (Notifications.requestPermissionsAsync as jest.Mock).mockReturnValueOnce(pending.promise);
  const hook = permissionRender();
  hook.rerender({ uid: 'alice', sessionId: 'trip-a', stepIndex: 1, guidance: approach, enabled: true });
  await waitFor(() => expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1));
  (Notifications.dismissNotificationAsync as jest.Mock).mockClear();
  hook.unmount();
  await waitFor(() => expect(Notifications.dismissNotificationAsync).toHaveBeenCalled());
  await act(async () => { pending.resolve({ granted: true }); });
  expect(claim).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});
