import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { readNavigationDocument } from '../src/data/navigationStorage';
import type { Itinerary, TransitStep } from '../src/data/tripPlanning';
import { useActiveTrip, type StartActiveTripInput } from '../src/hooks/useActiveTrip';
import { ETA_NOW, nativeJourney } from './fixtures/nativeJourney';

function input(itinerary = nativeJourney()): StartActiveTripInput {
  const origin = { kind: 'coordinate' as const, label: 'Origin', point: { lat: 40.799, lng: -73.1 }, savedAt: ETA_NOW };
  const destination = { kind: 'coordinate' as const, label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: ETA_NOW };
  return { itinerary, origin, destination, resumeRequest: { origin, destination, time: { mode: 'depart', at: itinerary.departureTime }, preference: 'fastest', modes: ['bus'] } };
}
function nextJourney(): Itinerary {
  const trip = nativeJourney();
  const shift = (time: string) => new Date(Date.parse(time) + 15 * 60_000).toISOString();
  return { ...trip, id: 'next-reachable-bus', departureTime: shift(trip.departureTime), arrivalTime: shift(trip.arrivalTime),
    steps: trip.steps.map((step) => step.kind === 'walk' ? step : { ...step, tripId: `${step.tripId}-next`, runRef: { ...step.runRef!, tripId: `${step.tripId}-next` },
      from: { ...step.from, time: shift(step.from.time) }, to: { ...step.to, time: shift(step.to.time) } }) };
}
beforeEach(async () => { jest.useFakeTimers(); jest.setSystemTime(ETA_NOW); await AsyncStorage.clear(); });
afterEach(() => jest.useRealTimers());

it('silently installs the next reachable journey within the same active trip and persists its exact baseline', async () => {
  const hook = renderHook(() => useActiveTrip('alice'));
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  await act(async () => { expect(await hook.result.current.start(input())).toBe('started'); });
  const previous = hook.result.current.active!;
  const replacement = input(nextJourney());
  await act(async () => { expect(await hook.result.current.applyRecovery({ sessionId: previous.sessionId, selectionFingerprint: previous.selection.fingerprint,
    stepIndex: previous.cursor.stepIndex, phase: previous.cursor.phase,
    plan: { itinerary: replacement.itinerary, origin: replacement.origin, resumeRequest: replacement.resumeRequest, prefixSteps: 0, keepCursor: false } })).toBe(true); });
  expect(hook.result.current.pendingReplacement).toBeNull();
  expect(hook.result.current.active?.sessionId).toBe(previous.sessionId);
  expect(hook.result.current.active?.startedAt).toBe(previous.startedAt);
  expect((hook.result.current.active?.itinerary.steps[1] as TransitStep).tripId).toBe('bus-a-next');
  expect((await readNavigationDocument('alice')).active?.nativeSnapshot?.itinerary.id).toBe('next-reachable-bus');
  expect(hook.result.current.recents).toHaveLength(0);
  hook.unmount();
  const resumed = renderHook(() => useActiveTrip('alice'));
  await waitFor(() => expect(resumed.result.current.status).toBe('active'));
  expect(resumed.result.current.active?.itinerary.id).toBe('next-reachable-bus');
  resumed.unmount();
});

it('discards recovery after a trip ends or its evidence becomes invalid', async () => {
  const hook = renderHook(() => useActiveTrip('alice'));
  await waitFor(() => expect(hook.result.current.status).toBe('idle'));
  await act(async () => { await hook.result.current.start(input()); });
  const active = hook.result.current.active!;
  const replacement = input(nextJourney());
  const request = { sessionId: active.sessionId, selectionFingerprint: active.selection.fingerprint, stepIndex: active.cursor.stepIndex,
    phase: active.cursor.phase, plan: { itinerary: replacement.itinerary, origin: replacement.origin, resumeRequest: replacement.resumeRequest, prefixSteps: 0, keepCursor: false } };
  await act(async () => { expect(await hook.result.current.applyRecovery({ ...request, isCurrent: () => false })).toBe(false); });
  expect(hook.result.current.active?.itinerary.id).toBe(active.itinerary.id);
  await act(async () => { await hook.result.current.end(); });
  await act(async () => { expect(await hook.result.current.applyRecovery(request)).toBe(false); });
  expect(hook.result.current.active).toBeNull();
  hook.unmount();
});
