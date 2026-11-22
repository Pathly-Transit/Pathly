import { act, renderHook, waitFor } from '@testing-library/react-native';
import { httpsCallable } from 'firebase/functions';

import { clearTripPlanCache, CURRENT_LOCATION_LABEL } from '../src/data/tripPlanning';
import { useTripPlan } from '../src/hooks/useTripPlan';

const planTripMock = () => (httpsCallable as jest.Mock)({}, 'planTrip') as jest.Mock;
const savedOrigin = {
  id: 'name:Current location',
  title: CURRENT_LOCATION_LABEL,
  subtitle: '',
  location: { latitude: 40.6934, longitude: -74.0038 },
};
const destination = {
  id: 'ChIJhRwB-yFawokR5Phil-QQ3zM',
  title: 'Penn Station',
  subtitle: 'New York, NY',
  location: { latitude: 40.7506, longitude: -73.9935 },
};
type HookProps = {
  location: { latitude: number; longitude: number } | null;
  locationPending: boolean;
};

beforeEach(() => {
  clearTripPlanCache();
  planTripMock().mockClear();
});

it('plans a Recent with a saved Current location coordinate without waiting for a fresh fix', async () => {
  const hook = renderHook(
    ({ location, locationPending }: HookProps) => useTripPlan({
      endpoints: {
        origin: CURRENT_LOCATION_LABEL,
        originPlace: savedOrigin,
        destination: destination.title,
        destinationPlace: destination,
      },
      time: { mode: 'now' },
      preference: 'fastest',
      modes: ['subway', 'bus', 'rail'],
      location,
      locationPending,
    }),
    { initialProps: { location: null, locationPending: true } as HookProps },
  );

  await waitFor(() => expect(hook.result.current.state.status).toBe('loaded'));
  expect(planTripMock()).toHaveBeenCalledTimes(1);
  expect(planTripMock()).toHaveBeenCalledWith(expect.objectContaining({
    origin: { label: CURRENT_LOCATION_LABEL, lat: savedOrigin.location.latitude, lng: savedOrigin.location.longitude },
  }));

  hook.rerender({ location: { latitude: 40.9, longitude: -73.1 }, locationPending: false });
  await waitFor(() => expect(hook.result.current.state.status).toBe('loaded'));
  expect(planTripMock()).toHaveBeenCalledTimes(1);
});

it('does not start overlapping route searches when refresh is pressed while planning is pending', async () => {
  let resolve!: (value: { data: { itineraries: [] } }) => void;
  planTripMock().mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const hook = renderHook(() => useTripPlan({ endpoints: { origin: CURRENT_LOCATION_LABEL, originPlace: savedOrigin, destination: destination.title, destinationPlace: destination },
    time: { mode: 'now' }, preference: 'fastest', modes: ['bus'], location: null, locationPending: false }));
  await waitFor(() => expect(planTripMock()).toHaveBeenCalledTimes(1));
  act(() => { hook.result.current.refresh(); hook.result.current.refresh(); });
  expect(planTripMock()).toHaveBeenCalledTimes(1);
  await act(async () => { resolve({ data: { itineraries: [] } }); });
  expect(hook.result.current.state.status).toBe('loaded');
  hook.unmount();
});
