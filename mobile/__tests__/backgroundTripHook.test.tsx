import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';

import { resumeBackgroundTripFixes, stopBackgroundTripAlerts, syncBackgroundTripAlerts } from '../src/background/tripAlerts';
import type { TripAlertOwner } from '../src/background/tripAlertState';
import type { ActiveTripRuntime, NavigationFix } from '../src/data/enrouteNavigation';
import { useBackgroundTripAlerts } from '../src/hooks/useBackgroundTripAlerts';

jest.mock('../src/background/tripAlerts', () => ({
  resumeBackgroundTripFixes: jest.fn(async () => []),
  stopBackgroundTripAlerts: jest.fn(async () => undefined),
  syncBackgroundTripAlerts: jest.fn(async () => 'active'),
}));
const sync = syncBackgroundTripAlerts as jest.Mock;
const resume = resumeBackgroundTripFixes as jest.Mock;
const stop = stopBackgroundTripAlerts as jest.Mock;
const listeners = new Set<(state: AppStateStatus) => void>();
const trip = (uid = 'alice', sessionId = 'trip-a', updatedAt = 1) => ({ uid, sessionId, updatedAt }) as ActiveTripRuntime;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
type Props = { runtime: ActiveTripRuntime | null; enabled: boolean; advance: (fix: NavigationFix) => Promise<unknown>; hydrating?: boolean; recovery?: TripAlertOwner | null };
const render = (initial: Props) => renderHook(({ runtime, enabled, advance, hydrating, recovery }: Props) => useBackgroundTripAlerts(runtime, enabled, advance, { hydrating, recovery }), { initialProps: initial });
const foreground = () => act(() => { listeners.forEach((listener) => listener('active')); });

beforeEach(() => {
  listeners.clear();
  sync.mockReset().mockResolvedValue('active'); resume.mockReset().mockResolvedValue([]); stop.mockClear();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
    listeners.add(listener);
    return { remove: () => { listeners.delete(listener); } };
  });
});
afterEach(() => jest.restoreAllMocks());

it('keeps permission prompting eligible while prerequisite notification permission is pending', async () => {
  const runtime = trip();
  sync.mockResolvedValueOnce('waiting-permission').mockResolvedValueOnce('waiting-permission').mockResolvedValue('active');
  const hook = render({ runtime, enabled: true, advance: jest.fn(async () => undefined) });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(sync).toHaveBeenLastCalledWith(runtime, true);
  foreground();
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
  expect(sync).toHaveBeenLastCalledWith(runtime, true);
  foreground();
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(3));
  expect(sync).toHaveBeenLastCalledWith(runtime, true);
  foreground();
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(4));
  expect(sync).toHaveBeenLastCalledWith(runtime, false);
  hook.unmount();
});

it('does not duplicate a permission request when runtime changes during an in-flight sync', async () => {
  const pending = deferred<'active'>();
  sync.mockReturnValueOnce(pending.promise);
  const advance = jest.fn(async () => undefined);
  const hook = render({ runtime: trip(), enabled: true, advance });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  const newer = trip('alice', 'trip-a', 2);
  hook.rerender({ runtime: newer, enabled: true, advance });
  expect(sync).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve('active'); });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
  expect(sync.mock.calls.filter(([, prompt]) => prompt)).toHaveLength(1);
  expect(sync).toHaveBeenLastCalledWith(newer, false);
  hook.unmount();
});

it('does not advance the old account after a deferred background-fix read resolves', async () => {
  const pending = deferred<NavigationFix[]>();
  resume.mockReturnValueOnce(pending.promise);
  const advanceA = jest.fn(async () => undefined);
  const advanceB = jest.fn(async () => undefined);
  const hook = render({ runtime: trip(), enabled: true, advance: advanceA });
  await waitFor(() => expect(resume).toHaveBeenCalledWith({ uid: 'alice', sessionId: 'trip-a' }));
  expect(sync).not.toHaveBeenCalled();
  hook.rerender({ runtime: trip('bob', 'trip-b'), enabled: true, advance: advanceB });
  const fix: NavigationFix = { point: { lat: 40.8, lng: -73.1 }, capturedAt: Date.now(), accuracyMeters: 5, source: 'real' };
  await act(async () => { pending.resolve([fix]); });
  expect(advanceA).not.toHaveBeenCalled();
  expect(advanceB).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledWith({ uid: 'alice', sessionId: 'trip-a' });
  await waitFor(() => expect(sync).toHaveBeenCalledWith(expect.objectContaining({ uid: 'bob' }), true));
  hook.unmount();
});

it('cleans up the scoped owner on disable, end and unmount', async () => {
  const advance = jest.fn(async () => undefined);
  const hook = render({ runtime: trip(), enabled: true, advance });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  hook.rerender({ runtime: trip(), enabled: false, advance });
  expect(stop).toHaveBeenCalledWith({ uid: 'alice', sessionId: 'trip-a' });
  expect(stop).toHaveBeenCalledWith();
  const count = sync.mock.calls.length;
  foreground();
  expect(sync).toHaveBeenCalledTimes(count);
  hook.rerender({ runtime: null, enabled: false, advance });
  hook.unmount();
  expect(listeners.size).toBe(0);
});

it('preserves an existing monitor during hydration and replays its fresh fixes before same-owner sync', async () => {
  const fix: NavigationFix = { point: { lat: 40.8, lng: -73.1 }, capturedAt: Date.now(), accuracyMeters: 5, source: 'real' };
  const second = { ...fix, capturedAt: fix.capturedAt + 1 };
  resume.mockResolvedValueOnce([fix, second]);
  const order: string[] = [];
  const advance = jest.fn(async (_fix: NavigationFix) => { order.push('advance'); });
  sync.mockImplementation(async () => { order.push('sync'); return 'active'; });
  const hook = render({ runtime: null, enabled: true, advance, hydrating: true });
  await act(async () => undefined);
  expect(stop).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  hook.rerender({ runtime: trip(), enabled: true, advance, hydrating: false });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(resume).toHaveBeenCalledWith({ uid: 'alice', sessionId: 'trip-a' });
  expect(advance.mock.calls.map(([value]) => value)).toEqual([fix, second]);
  expect(order).toEqual(['advance', 'advance', 'sync']);
  expect(stop).not.toHaveBeenCalled();
  hook.unmount();
});

it('preserves recovery ownership and replays its monitor when the exact runtime becomes available', async () => {
  const fix: NavigationFix = { point: { lat: 40.81, lng: -73.1 }, capturedAt: Date.now(), accuracyMeters: 5, source: 'real' };
  resume.mockResolvedValueOnce([fix]);
  const advance = jest.fn(async (_fix: NavigationFix) => undefined);
  const recovery = { uid: 'alice', sessionId: 'trip-a' };
  const hook = render({ runtime: null, enabled: true, advance, recovery });
  await act(async () => undefined);
  expect(stop).not.toHaveBeenCalled();
  expect(sync).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  hook.rerender({ runtime: trip(), enabled: true, advance, recovery: null });
  await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
  expect(resume).toHaveBeenCalledWith(recovery);
  expect(advance).toHaveBeenCalledWith(fix);
  expect(stop).not.toHaveBeenCalled();
  hook.unmount();
});

it('stops a retained recovery monitor once idle is confirmed or notification tracking is off', async () => {
  const advance = jest.fn(async () => undefined);
  const recovery = { uid: 'alice', sessionId: 'trip-a' };
  const hook = render({ runtime: null, enabled: true, advance, recovery });
  await act(async () => undefined);
  expect(stop).not.toHaveBeenCalled();
  hook.rerender({ runtime: null, enabled: true, advance, recovery: null, hydrating: false });
  expect(stop).toHaveBeenCalledWith(recovery);
  expect(stop).toHaveBeenCalledWith();
  stop.mockClear();
  hook.rerender({ runtime: null, enabled: true, advance, recovery });
  hook.rerender({ runtime: null, enabled: false, advance, recovery });
  expect(stop).toHaveBeenCalledWith(recovery);
  expect(stop).toHaveBeenCalledWith();
  hook.unmount();
});
