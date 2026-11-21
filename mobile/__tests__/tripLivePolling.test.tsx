import { act, renderHook } from '@testing-library/react-native';

import { clearRouteLiveReads } from '../src/data/transitLive';
import type { Itinerary, TransitStep } from '../src/data/tripPlanning';
import { useTripRide } from '../src/hooks/useTripRide';
import { useTripVehicles } from '../src/hooks/useTripVehicles';

const mockAuth = { currentUser: { uid: 'alice', isAnonymous: false } };
const mockCall = jest.fn();
const mockGeometry = jest.fn();
let mockAppActive = true;
jest.mock('../src/auth/AuthContext', () => ({ useAuth: () => ({ user: mockAuth.currentUser }) }));
jest.mock('../src/lib/firebase', () => ({ get auth() { return mockAuth; }, callable: (name: string) => (request: unknown) => mockCall(name, request) }));
jest.mock('../src/hooks/useAppActive', () => ({ useAppActive: () => mockAppActive }));
jest.mock('../src/data/userPreferences', () => ({ useUserPreferences: () => ({ preferences: { shareRides: true } }) }));
jest.mock('../src/data/routeGeometry', () => ({ fetchRouteGeometry: (...args: unknown[]) => mockGeometry(...args) }));

const step = {
  kind: 'transit', mode: 'bus', line: { name: '51', color: '#ff0000' },
  liveRoute: { agencyId: 'suffolk', routeId: '51', boardStopId: 'first', directionId: 0 },
  to: { location: { lat: 40.9, lng: -73.1 } },
} as TransitStep;
const itinerary = { steps: [step] } as Itinerary;

beforeEach(() => {
  jest.useFakeTimers();
  mockAppActive = true;
  mockAuth.currentUser = { uid: 'alice', isAnonymous: false };
  clearRouteLiveReads();
  mockGeometry.mockReset().mockResolvedValue(null);
  mockCall.mockReset().mockImplementation(async (_name, request) => ({ data: {
    routeId: request.routeId, vehicles: [], stopPredictions: { towardDirection1: [], towardDirection0: [] },
  } }));
});
afterEach(() => { jest.useRealTimers(); });

it('shares one request per 15-second tick, pauses both consumers, resumes, and cleans up', async () => {
  const hook = renderHook(() => {
    useTripRide(step, null);
    return useTripVehicles(itinerary, '#ff0000');
  });
  await act(async () => { await Promise.resolve(); });
  expect(mockCall.mock.calls.filter(([name]) => name === 'getRouteLiveStatus')).toHaveLength(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(5 * 60_000); });
  expect(mockCall.mock.calls.filter(([name]) => name === 'getRouteLiveStatus')).toHaveLength(21);
  mockAppActive = false;
  hook.rerender({});
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
  expect(mockCall.mock.calls.filter(([name]) => name === 'getRouteLiveStatus')).toHaveLength(21);
  mockAppActive = true;
  hook.rerender({});
  await act(async () => { await Promise.resolve(); });
  expect(mockCall.mock.calls.filter(([name]) => name === 'getRouteLiveStatus')).toHaveLength(22);
  hook.unmount();
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
  expect(mockCall.mock.calls.filter(([name]) => name === 'getRouteLiveStatus')).toHaveLength(22);
});

it('does not reuse the previous owner overlay or boarding-stop read after rerender', async () => {
  const hook = renderHook(({ current }: { current: TransitStep }) => useTripVehicles({ steps: [current] } as Itinerary, '#ff0000'), { initialProps: { current: step } });
  await act(async () => { await Promise.resolve(); });
  mockAuth.currentUser = { uid: 'bob', isAnonymous: false };
  hook.rerender({ current: step });
  expect(hook.result.current.vehicles).toEqual([]);
  await act(async () => { await Promise.resolve(); });
  expect(mockCall).toHaveBeenCalledTimes(2);
  hook.rerender({ current: { ...step, liveRoute: { ...step.liveRoute!, boardStopId: 'second' } } });
  await act(async () => { await Promise.resolve(); });
  expect(mockCall).toHaveBeenCalledTimes(3);
  expect(mockCall.mock.calls[2]![1]).toMatchObject({ direction1StopId: 'second', direction0StopId: 'second' });
  hook.unmount();
});

it('recomputes the visible stretch when the same line and boarding stop have a different exit', async () => {
  const stops = [
    { stopId: 'first', lat: 40.8, lon: -73.1 },
    { stopId: 'middle', lat: 40.81, lon: -73.1 },
    { stopId: 'last', lat: 40.82, lon: -73.1 },
  ];
  mockGeometry.mockResolvedValue({ stops, path: stops });
  mockCall.mockImplementation(async (_name, request) => ({ data: {
    routeId: request.routeId,
    vehicles: [{ tripId: 'last-bus', directionId: 0, lat: 40.82, lon: -73.1, timestamp: Date.now() / 1000 }],
    stopPredictions: { towardDirection1: [], towardDirection0: [] },
  } }));
  const hook = renderHook(({ lat }: { lat: number }) => useTripVehicles({ steps: [{ ...step, to: { location: { lat, lng: -73.1 } } }] } as Itinerary, '#ff0000'), { initialProps: { lat: 40.81 } });
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current.vehicles).toEqual([]);
  hook.rerender({ lat: 40.82 });
  await act(async () => { await Promise.resolve(); });
  expect(hook.result.current.vehicles.map((vehicle) => vehicle.tripId)).toEqual(['last-bus']);
  expect(mockCall).toHaveBeenCalledTimes(1);
  hook.unmount();
});
