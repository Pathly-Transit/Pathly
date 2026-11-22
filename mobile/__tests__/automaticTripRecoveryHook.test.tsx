import { act, renderHook } from '@testing-library/react-native';

import { createActiveTripRuntime } from '../src/hooks/useActiveTrip';
import { useAutomaticTripRecovery } from '../src/hooks/useAutomaticTripRecovery';
import { findTripRecovery, recoveryReason, type TripRecoveryPlan } from '../src/data/tripRecovery';
import { readNavigationDocument } from '../src/data/navigationStorage';
import type { ActiveTripRuntime, NavigationFix } from '../src/data/enrouteNavigation';
import type { TripLiveResponse } from '../src/data/tripLiveTypes';
import { ETA_NOW, etaAt, nativeJourney, nativeObservation, nativeResponse } from './fixtures/nativeJourney';

jest.mock('../src/data/tripRecovery', () => ({ ...jest.requireActual('../src/data/tripRecovery'), findTripRecovery: jest.fn(), recoveryReason: jest.fn() }));
jest.mock('../src/data/navigationStorage', () => ({ ...jest.requireActual('../src/data/navigationStorage'), readNavigationDocument: jest.fn() }));
jest.mock('../src/hooks/useAppActive', () => ({ useAppActive: () => true }));

const currentFix = (latitude = 40.799): NavigationFix => ({ point: { lat: latitude, lng: -73.1 }, source: 'real', accuracyMeters: 5, capturedAt: Date.now() });
function activeFor(uid: string): ActiveTripRuntime {
  return createActiveTripRuntime({ itinerary: nativeJourney(),
    origin: { kind: 'coordinate', label: 'Origin', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW },
    destination: { kind: 'coordinate', label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: ETA_NOW },
  }, uid, ETA_NOW, `${uid}-session`);
}
function prepared(active: ActiveTripRuntime, id = 'replacement'): TripRecoveryPlan {
  return { itinerary: { ...active.itinerary, id }, origin: active.origin,
    resumeRequest: { origin: active.origin, destination: active.destination, time: { mode: 'depart', at: active.itinerary.departureTime }, preference: 'fastest', modes: ['bus'] },
    prefixSteps: active.cursor.phase === 'riding' ? active.cursor.stepIndex + 1 : 0,
    keepCursor: active.cursor.phase === 'riding', ...(active.cursor.phase === 'riding' ? {} : { startPoint: { lat: 40.799, lng: -73.1 } }) };
}
function deferred() {
  let resolve!: (plan: TripRecoveryPlan | null) => void;
  const promise = new Promise<TripRecoveryPlan | null>((done) => { resolve = done; });
  return { promise, resolve };
}
type Props = { active: ActiveTripRuntime; statuses: TripLiveResponse | null; fix: NavigationFix | null };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const find = findTripRecovery as jest.Mock;
const reason = recoveryReason as jest.Mock;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(ETA_NOW);
  jest.clearAllMocks();
  reason.mockReturnValue({ kind: 'wrong-way', key: 'still-valid-proof', stepIndex: 0 });
  (readNavigationDocument as jest.Mock).mockImplementation(async (uid: string) => ({ active: { sessionId: `${uid}-session`, request: prepared(activeFor(uid)).resumeRequest } }));
});
afterEach(() => jest.useRealTimers());

it('starts the new owner recovery while the old owner network request is still pending', async () => {
  const alice = activeFor('alice');
  const bob = activeFor('bob');
  const old = deferred();
  const next = deferred();
  find.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  const apply = jest.fn(async () => true);
  const hook = renderHook((props: Props) => useAutomaticTripRecovery(props.active, props.statuses, props.fix, apply),
    { initialProps: { active: alice, statuses: null, fix: currentFix() } as Props });
  await flush();
  hook.rerender({ active: bob, statuses: null, fix: currentFix() });
  await flush();
  expect(find).toHaveBeenCalledTimes(2);
  expect(find.mock.calls[1]![0].uid).toBe('bob');
  await act(async () => { old.resolve(prepared(alice)); next.resolve(null); });
  expect(apply).not.toHaveBeenCalled();
  hook.unmount();
});

it('does not let an old request finalizer unlock a newer request after the retry interval', async () => {
  const alice = activeFor('alice');
  const bob = activeFor('bob');
  const old = deferred();
  const next = deferred();
  find.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => next.promise);
  const hook = renderHook((props: Props) => useAutomaticTripRecovery(props.active, props.statuses, props.fix, jest.fn(async () => true)),
    { initialProps: { active: alice, statuses: null, fix: currentFix() } as Props });
  await flush();
  hook.rerender({ active: bob, statuses: null, fix: currentFix() });
  await flush();
  await act(async () => { jest.advanceTimersByTime(35_000); old.resolve(null); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(find).toHaveBeenCalledTimes(2);
  await act(async () => { next.resolve(null); });
  hook.unmount();
});

it('rejects a retained A result after A to B to A while allowing the newest A request', async () => {
  const alice = activeFor('alice');
  const bob = activeFor('bob');
  const first = deferred();
  const middle = deferred();
  const last = deferred();
  find.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => middle.promise).mockImplementationOnce(() => last.promise);
  const apply = jest.fn(async () => true);
  const hook = renderHook((props: Props) => useAutomaticTripRecovery(props.active, props.statuses, props.fix, apply),
    { initialProps: { active: alice, statuses: null, fix: currentFix() } as Props });
  await flush();
  hook.rerender({ active: bob, statuses: null, fix: currentFix() });
  await flush();
  hook.rerender({ active: alice, statuses: null, fix: currentFix() });
  await flush();
  await act(async () => { first.resolve(prepared(alice, 'old-A')); });
  expect(apply).not.toHaveBeenCalled();
  await act(async () => { last.resolve(prepared(alice, 'latest-A')); });
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ plan: expect.objectContaining({ itinerary: expect.objectContaining({ id: 'latest-A' }) }) }));
  await act(async () => { middle.resolve(null); });
  hook.unmount();
});

it('rejects an on-foot plan whose origin is now more than 75 metres behind the latest real GPS', async () => {
  const active = activeFor('alice');
  const pending = deferred();
  find.mockImplementationOnce(() => pending.promise);
  const apply = jest.fn(async () => true);
  const hook = renderHook((props: Props) => useAutomaticTripRecovery(props.active, props.statuses, props.fix, apply),
    { initialProps: { active, statuses: null, fix: currentFix() } as Props });
  await flush();
  hook.rerender({ active, statuses: null, fix: currentFix(40.801) });
  await act(async () => { pending.resolve(prepared(active)); });
  expect(apply).not.toHaveBeenCalled();
  hook.unmount();
});

it('invalidates an onboard onward plan when the current legal alighting forecast changes', async () => {
  const active = activeFor('alice');
  active.cursor = { ...active.cursor, stepIndex: 1, phase: 'riding' };
  const pending = deferred();
  find.mockImplementationOnce(() => pending.promise);
  const apply = jest.fn(async () => true);
  const hook = renderHook((props: Props) => useAutomaticTripRecovery(props.active, props.statuses, props.fix, apply),
    { initialProps: { active, statuses: nativeResponse([nativeObservation(1)]), fix: null } as Props });
  await flush();
  hook.rerender({ active, statuses: nativeResponse([nativeObservation(1, { arrives: etaAt(30) })]), fix: null });
  await act(async () => { pending.resolve(prepared(active)); });
  expect(apply).not.toHaveBeenCalled();
  hook.unmount();
});

it('rechecks the latest reason before publishing after asynchronous planning', async () => {
  const active = activeFor('alice');
  const pending = deferred();
  find.mockImplementationOnce(() => pending.promise);
  const apply = jest.fn(async () => true);
  const hook = renderHook(() => useAutomaticTripRecovery(active, null, currentFix(), apply));
  await flush();
  reason.mockReturnValue(null);
  await act(async () => { pending.resolve(prepared(active)); });
  expect(apply).not.toHaveBeenCalled();
  hook.unmount();
});
