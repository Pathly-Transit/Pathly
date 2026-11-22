import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import * as RideGuide from '../src/data/rideGuide';
import type { Itinerary } from '../src/data/tripPlanning';
import { useActiveTrip, type StartActiveTripInput } from '../src/hooks/useActiveTrip';
import { ETA_NOW, nativeJourney } from './fixtures/nativeJourney';

function input(): StartActiveTripInput {
  const itinerary = nativeJourney();
  const origin = { kind: 'coordinate' as const, label: 'Origin', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW };
  const destination = { kind: 'coordinate' as const, label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: ETA_NOW };
  return { itinerary, origin, destination, resumeRequest: { origin, destination, time: { mode: 'depart', at: itinerary.departureTime }, preference: 'fastest', modes: ['bus'] } };
}

it('rejects a retained start callback after an account changes, including A to B to A', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(ETA_NOW);
  await AsyncStorage.clear();
  const hook = renderHook(({ uid }: { uid: string }) => useActiveTrip(uid), { initialProps: { uid: 'alice' } });
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  const oldStart = hook.result.current.start;
  hook.rerender({ uid: 'bob' });
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  await act(async () => { expect(await oldStart(input())).toBe('not-ready'); });
  hook.rerender({ uid: 'alice' });
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  await act(async () => { expect(await oldStart(input())).toBe('not-ready'); });
  expect(hook.result.current.active).toBeNull();
  hook.unmount(); jest.restoreAllMocks();
});

it('does not let an old account queued End action end the next account trip during run resolution', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(ETA_NOW);
  await AsyncStorage.clear();
  const bob = renderHook(() => useActiveTrip('bob'));
  await waitFor(() => expect(bob.result.current.status).toBe('idle'));
  await act(async () => { await bob.result.current.start(input()); });
  const bobSession = bob.result.current.active!.sessionId;
  bob.unmount();
  let resolve!: (value: Itinerary | null) => void;
  const pending = new Promise<Itinerary | null>((done) => { resolve = done; });
  const enrich = jest.spyOn(RideGuide, 'enrichRideGuideItinerary').mockReturnValueOnce(pending);
  const hook = renderHook(({ uid }: { uid: string }) => useActiveTrip(uid), { initialProps: { uid: 'alice' } });
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  let start!: ReturnType<typeof hook.result.current.start>;
  act(() => { start = hook.result.current.start({ ...input(), resumeSource: 'ride-guide' }); });
  await waitFor(() => expect(enrich).toHaveBeenCalledTimes(1));
  const oldEnd = hook.result.current.end();
  hook.rerender({ uid: 'bob' });
  await waitFor(() => expect(hook.result.current.active?.sessionId).toBe(bobSession));
  await act(async () => { resolve(nativeJourney()); expect(await start).toBe('not-ready'); expect(await oldEnd).toBe(false); });
  expect(hook.result.current.active?.sessionId).toBe(bobSession);
  hook.unmount(); jest.restoreAllMocks();
});
