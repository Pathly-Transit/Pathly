import AsyncStorage from '@react-native-async-storage/async-storage';
import { waitFor } from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import { httpsCallable } from 'firebase/functions';
import { signOut } from 'firebase/auth';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { signOutUser } from '../src/auth/authService';
import { functions } from '../src/lib/firebase';
import { observeRouteAlertRegistration, registerForRouteAlerts, resetRouteAlertRegistrationForTests, setRouteAlertOwner, unregisterRouteAlerts } from '../src/lib/routeAlertRegistration';

jest.mock('expo-crypto', () => ({ randomUUID: () => 'installation-1234567890', getRandomBytesAsync: async () => new Uint8Array(32).fill(7) }));

const update = httpsCallable(functions, 'updatePushInstallation') as unknown as jest.Mock;
const permissions = Notifications.getPermissionsAsync as jest.Mock;
const token = Notifications.getExpoPushTokenAsync as jest.Mock;
const read = async () => JSON.parse((await AsyncStorage.getItem('pathly.pushInstallation.v1')) ?? 'null');
const registered = async (uid: string) => waitFor(async () => expect(await read()).toMatchObject({ ownerUid: uid, pending: false }));

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  update.mockReset().mockResolvedValue({ data: { applied: true } });
  permissions.mockReset().mockResolvedValue({ granted: true, canAskAgain: true });
  token.mockReset().mockResolvedValue({ data: 'ExponentPushToken[token-A]' });
  (Notifications.addPushTokenListener as jest.Mock).mockClear();
});
afterEach(() => { resetRouteAlertRegistrationForTests(); jest.restoreAllMocks(); });

it('journals revocation before sign-out without waiting for offline network cleanup', async () => {
  await setRouteAlertOwner({ uid: 'A' });
  await registered('A');
  update.mockRejectedValue(new Error('offline'));
  (signOut as jest.Mock).mockImplementationOnce(async () => {
    expect(await read()).toMatchObject({ ownerUid: null, token: null, pending: true });
  });
  await signOutUser();
  await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ ownerUid: null, token: null })));
  expect(Notifications.unregisterForNotificationsAsync).toHaveBeenCalled();
});

it('retries durable signed-out cleanup after restart with the same private installation capability', async () => {
  await setRouteAlertOwner({ uid: 'A' });
  await registered('A');
  const first = await read();
  update.mockRejectedValue(new Error('offline'));
  await unregisterRouteAlerts();
  await waitFor(() => expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ token: null })));
  resetRouteAlertRegistrationForTests();
  update.mockResolvedValue({ data: { applied: true } });
  await setRouteAlertOwner(null);
  await waitFor(async () => expect(await read()).toMatchObject({ ownerUid: null, pending: false, capability: first.capability, installationId: first.installationId }));
});

it('ignores token lookup finishing for A after switching to B', async () => {
  let finishA!: (value: { data: string }) => void;
  token.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }));
  await setRouteAlertOwner({ uid: 'A' });
  await waitFor(() => expect(token).toHaveBeenCalledTimes(1));
  token.mockResolvedValue({ data: 'ExponentPushToken[token-B]' });
  await setRouteAlertOwner({ uid: 'B' });
  await registered('B');
  finishA({ data: 'ExponentPushToken[token-A]' });
  await Promise.resolve();
  expect(update.mock.calls.some(([request]) => request.ownerUid === 'A')).toBe(false);
  expect(await read()).toMatchObject({ ownerUid: 'B', token: 'ExponentPushToken[token-B]' });
});

it('does not overwrite B pending intent with a late A server acknowledgement', async () => {
  let finishA!: (value: { data: { applied: boolean } }) => void;
  update.mockImplementationOnce(() => new Promise((resolve) => { finishA = resolve; }));
  await setRouteAlertOwner({ uid: 'A' });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  const firstRevision = (await read()).revision;
  await setRouteAlertOwner({ uid: 'B' });
  await waitFor(async () => expect(await read()).toMatchObject({ ownerUid: 'B', pending: true }));
  finishA({ data: { applied: true } });
  await registered('B');
  expect((await read()).revision).toBeGreaterThan(firstRevision);
  expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ ownerUid: 'B' }));
});

it('refreshes a rotated token and revokes when permission is later withdrawn', async () => {
  let onActive!: (state: AppStateStatus) => void;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { onActive = listener; return { remove: jest.fn() }; });
  const stop = observeRouteAlertRegistration();
  await setRouteAlertOwner({ uid: 'A' });
  await registered('A');
  token.mockResolvedValue({ data: 'ExponentPushToken[token-B]' });
  const onToken = (Notifications.addPushTokenListener as jest.Mock).mock.calls[0]![0];
  onToken();
  await waitFor(async () => expect(await read()).toMatchObject({ token: 'ExponentPushToken[token-B]', pending: false }));
  permissions.mockResolvedValue({ granted: false, canAskAgain: false });
  onActive('active');
  await waitFor(async () => expect(await read()).toMatchObject({ ownerUid: null, token: null, pending: false }));
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  stop();
});

it('rejects stale caller UID and never registers anonymous sessions', async () => {
  await setRouteAlertOwner({ uid: 'B' });
  await registered('B');
  const count = token.mock.calls.length;
  expect(await registerForRouteAlerts('A')).toBe(false);
  expect(token).toHaveBeenCalledTimes(count);
  await setRouteAlertOwner({ uid: 'guest', isAnonymous: true });
  await waitFor(async () => expect(await read()).toMatchObject({ ownerUid: null, pending: false }));
  expect(await registerForRouteAlerts('guest')).toBe(false);
});

it('waits for delayed native unregister before acquiring the new account token', async () => {
  await setRouteAlertOwner({ uid: 'A' });
  await registered('A');
  let finish!: () => void;
  (Notifications.unregisterForNotificationsAsync as jest.Mock).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const previous = token.mock.calls.length;
  await setRouteAlertOwner({ uid: 'B' });
  await waitFor(() => expect(finish).toBeDefined());
  expect(token).toHaveBeenCalledTimes(previous);
  finish();
  await registered('B');
  expect(token).toHaveBeenCalledTimes(previous + 1);
});

it('does not claim push readiness after the server rejects a stale revision', async () => {
  update.mockResolvedValue({ data: { applied: false } });
  await setRouteAlertOwner({ uid: 'A' });
  await waitFor(() => expect(update).toHaveBeenCalled());
  expect(await registerForRouteAlerts('A')).toBe(false);
  expect(await read()).toMatchObject({ ownerUid: 'A', pending: true });
});
