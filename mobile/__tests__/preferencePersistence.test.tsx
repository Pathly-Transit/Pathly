import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { preferencesKey, UserPreferencesProvider, useUserPreferences } from '../src/data/userPreferences';

let mockUser = { uid: 'alice' };
jest.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));
const wrapper = ({ children }: { children: ReactNode }) => <UserPreferencesProvider>{children}</UserPreferencesProvider>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { mockUser = { uid: 'alice' }; (AsyncStorage.setItem as jest.Mock).mockClear(); });
afterEach(() => { jest.restoreAllMocks(); });

it('persists rapid same-account patches in order without dropping either intent', async () => {
  const hook = renderHook(() => useUserPreferences(), { wrapper });
  const pending = deferred();
  const original = (AsyncStorage.setItem as jest.Mock).getMockImplementation()!;
  const write = jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce((key, value) => pending.promise.then(() => original(key, value)));
  let first!: Promise<void>;
  let last!: Promise<void>;
  act(() => {
    first = hook.result.current.savePreferences({ notifications: { enabled: false } });
    last = hook.result.current.savePreferences({ notifications: { serviceAlerts: false } });
  });
  await act(async () => { await Promise.resolve(); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(hook.result.current.preferences.notifications).toMatchObject({ enabled: false, serviceAlerts: false });
  await act(async () => { pending.resolve(); await Promise.all([first, last]); });
  const saved = JSON.parse((await AsyncStorage.getItem(preferencesKey('alice')))!);
  expect(saved.notifications).toMatchObject({ enabled: false, serviceAlerts: false });
  hook.unmount();
});

it('rejects failed writes and cancels queued/late writes after an account switch', async () => {
  const hook = renderHook(() => useUserPreferences(), { wrapper });
  const pending = deferred();
  const write = jest.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(() => pending.promise);
  let first!: Promise<void>;
  let queued!: Promise<void>;
  act(() => {
    first = hook.result.current.savePreferences({ notifications: { enabled: false } });
    queued = hook.result.current.savePreferences({ stepFree: true });
  });
  const firstRejected = expect(first).rejects.toThrow('Account changed');
  const queuedRejected = expect(queued).rejects.toThrow('Account changed');
  await act(async () => { await Promise.resolve(); });
  mockUser = { uid: 'bob' };
  hook.rerender({});
  await act(async () => { pending.resolve(); await Promise.all([firstRejected, queuedRejected]); });
  expect(write).toHaveBeenCalledTimes(1);
  expect(write.mock.calls[0]![0]).toBe(preferencesKey('alice'));
  await act(async () => { await hook.result.current.savePreferences({ stepFree: true }); });
  expect(write.mock.calls[1]![0]).toBe(preferencesKey('bob'));
  expect(hook.result.current.preferences.notifications.enabled).toBe(true);
  hook.unmount();
});

it('does not let a retained prior-account callback change the new account state or storage', async () => {
  const hook = renderHook(() => useUserPreferences(), { wrapper });
  const saveAsAlice = hook.result.current.savePreferences;
  mockUser = { uid: 'bob' };
  hook.rerender({});
  await act(async () => {
    await expect(saveAsAlice({ notifications: { enabled: false } })).rejects.toThrow('Account changed');
  });
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(hook.result.current.preferences.notifications.enabled).toBe(true);
  await act(async () => { await hook.result.current.savePreferences({ stepFree: true }); });
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  expect((AsyncStorage.setItem as jest.Mock).mock.calls[0]![0]).toBe(preferencesKey('bob'));
  expect(hook.result.current.preferences.notifications.enabled).toBe(true);
  mockUser = { uid: 'alice' };
  hook.rerender({});
  await act(async () => { await expect(saveAsAlice({ stepFree: false })).rejects.toThrow('Account changed'); });
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  hook.unmount();
});
