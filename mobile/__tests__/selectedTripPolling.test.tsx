import { act, renderHook } from '@testing-library/react-native';

import { matchedTripStatus, useTripLiveStatus } from '../src/hooks/useTripLiveStatus';
import { tripLiveRequests } from '../src/data/tripTiming';
import type { Itinerary } from '../src/data/tripPlanning';
import { ETA_NOW, nativeJourney, nativeObservation, nativeResponse, nativeRun } from './fixtures/nativeJourney';

const mockAuth = { currentUser: { uid: 'alice' } };
const mockCall = jest.fn();
let mockActive = true;
jest.mock('../src/lib/firebase', () => ({ get auth() { return mockAuth; }, callable: (name: string) => (request: unknown) => mockCall(name, request) }));
jest.mock('../src/hooks/useAppActive', () => ({ useAppActive: () => mockActive }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
type Props = { uid: string; sessionId: string; itinerary: Itinerary };
const props = (): Props => ({ uid: 'alice', sessionId: 'trip-a', itinerary: nativeJourney() });
const render = () => renderHook((current: Props) => useTripLiveStatus(current), { initialProps: props() });

beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(ETA_NOW); mockActive = true; mockAuth.currentUser = { uid: 'alice' };
  mockCall.mockReset().mockResolvedValue({ data: nativeResponse([nativeObservation(1), nativeObservation(3)]) });
});
afterEach(() => jest.useRealTimers());

it('polls exact selected runs, pauses, resumes immediately and never replans for GPS rerenders', async () => {
  const hook = render();
  await act(async () => {});
  expect(mockCall).toHaveBeenCalledTimes(1);
  expect(mockCall).toHaveBeenCalledWith('getTripLiveStatus', { version: 1, legs: tripLiveRequests(hook.result.current.statuses ? props().itinerary : nativeJourney()) });
  hook.rerender(props());
  await act(async () => { await jest.advanceTimersByTimeAsync(30_000); });
  expect(mockCall).toHaveBeenCalledTimes(2);
  mockActive = false; hook.rerender(props());
  await act(async () => { await jest.advanceTimersByTimeAsync(120_000); });
  expect(mockCall).toHaveBeenCalledTimes(2);
  mockActive = true; hook.rerender(props());
  await act(async () => {});
  expect(mockCall).toHaveBeenCalledTimes(3);
  expect(hook.result.current.now).toBe(ETA_NOW + 150_000);
  hook.unmount();
});

it('coalesces manual and timed refreshes while a request is pending', async () => {
  const pending = deferred<{ data: ReturnType<typeof nativeResponse> }>();
  mockCall.mockReturnValue(pending.promise);
  const hook = render();
  await act(async () => { hook.result.current.refresh(); await jest.advanceTimersByTimeAsync(120_000); });
  expect(mockCall).toHaveBeenCalledTimes(1);
  await act(async () => { pending.resolve({ data: nativeResponse([nativeObservation(1)]) }); });
  expect(hook.result.current.refreshing).toBe(false);
  hook.unmount();
});

it('rejects a late account/session reply, including A to B to A', async () => {
  const first = deferred<{ data: ReturnType<typeof nativeResponse> }>();
  mockCall.mockReturnValueOnce(first.promise);
  const hook = render();
  mockAuth.currentUser = { uid: 'bob' };
  hook.rerender({ ...props(), uid: 'bob', sessionId: 'trip-b' });
  await act(async () => {});
  mockAuth.currentUser = { uid: 'alice' };
  hook.rerender({ ...props(), sessionId: 'trip-new-a' });
  await act(async () => {});
  await act(async () => { first.resolve({ data: nativeResponse([nativeObservation(1, { status: 'cancelled' })]) }); });
  expect(hook.result.current.statuses?.legs.every((leg) => leg.status === 'predicted')).toBe(true);
  hook.unmount();
});

it('does not renew source timestamps on repeated responses and drops duplicate/wrong-run observations', () => {
  const request = { version: 1 as const, legs: tripLiveRequests(nativeJourney()) };
  const original = nativeObservation(1);
  expect(matchedTripStatus(nativeResponse([original, original]), request)?.legs).toEqual([]);
  expect(matchedTripStatus(nativeResponse([nativeObservation(1, { runRef: nativeRun({ tripId: 'another-bus' }) })]), request)?.legs).toEqual([]);
  const response = matchedTripStatus({ ...nativeResponse([original]), fetchedAt: ETA_NOW + 60_000 }, request)!;
  expect(response.legs[0]!.observedAt).toBe(ETA_NOW);
  expect(response.legs[0]!.expiresAt).toBe(ETA_NOW + 90_000);
});
