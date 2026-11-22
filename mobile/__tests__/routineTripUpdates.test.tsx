import { renderHook } from '@testing-library/react-native';

import { createActiveTripRuntime } from '../src/hooks/useActiveTrip';
import { useHurryUp } from '../src/hooks/useHurryUp';
import { notifyNow } from '../src/lib/notifications';
import { ETA_NOW, nativeJourney } from './fixtures/nativeJourney';

jest.mock('../src/lib/notifications', () => ({ notifyNow: jest.fn() }));

it('keeps a routine boarding-time warning in the trip screen without notifying', () => {
  const now = ETA_NOW + 9 * 60_000;
  jest.useFakeTimers(); jest.setSystemTime(now);
  const runtime = createActiveTripRuntime({ itinerary: nativeJourney(), origin: { kind: 'coordinate', label: 'Start', point: { lat: 40.799, lng: -73.1 }, savedAt: now },
    destination: { kind: 'coordinate', label: 'Meeting', point: { lat: 40.823, lng: -73.1 }, savedAt: now } }, 'alice', now);
  const hook = renderHook(() => useHurryUp(runtime, { point: { lat: 40.795, lng: -73.1 }, capturedAt: now, source: 'real', accuracyMeters: 5 }, true));
  expect(hook.result.current?.title).toBe('Pick up the pace');
  expect(notifyNow).not.toHaveBeenCalled();
  hook.unmount(); jest.useRealTimers();
});
