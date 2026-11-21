import { act, render } from '@testing-library/react-native';
import { Text, View } from 'react-native';

import { TransitLiveProvider, useTransitLive } from '../src/data/TransitLiveContext';
import { routeById } from '../src/data/transit';

const mockAuth = { currentUser: { uid: 'alice' } };
const mockBatch = jest.fn();
jest.mock('../src/lib/firebase', () => ({ get auth() { return mockAuth; }, callable: (name: string) => (request: unknown) => name === 'getRoutesLiveStatus' ? mockBatch(request) : Promise.reject(new Error('unexpected individual read')) }));
const route = routeById.ronkonkoma;
function Probe() {
  const live = useTransitLive(route.id);
  return <Text testID="owner-vehicles">{live?.status === 'loaded' ? live.data.vehicles.map((vehicle) => vehicle.tripId).join(',') : live?.status ?? 'empty'}</Text>;
}
const view = (uid: string) => <View><TransitLiveProvider key={uid} activeRouteIds={[route.id]} location={{ latitude: 40.9, longitude: -73.1 }}><Probe /></TransitLiveProvider></View>;
const response = (tripId: string) => ({ data: { results: [{ ok: true, data: {
  routeId: route.liveSource!.routeId, vehicles: [{ tripId, directionId: 0, lat: 40.9, lon: -73.1, timestamp: Date.now() / 1000 }],
  nearestStop: null, stopPredictions: { towardDirection1: [], towardDirection0: [] },
} }] } });

it('does not publish an old owner batch over the replacement account provider', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  mockAuth.currentUser = { uid: 'alice' };
  mockBatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue(response('bob-ride'));
  const screen = render(view('alice'));
  mockAuth.currentUser = { uid: 'bob' };
  screen.rerender(view('bob'));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId('owner-vehicles').props.children).toBe('bob-ride');
  await act(async () => { resolve(response('alice-ride')); });
  expect(screen.getByTestId('owner-vehicles').props.children).toBe('bob-ride');
});
