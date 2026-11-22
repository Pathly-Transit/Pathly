import { httpsCallable } from 'firebase/functions';

import { routeById, type LiveSource } from '../src/data/transit';
import { applyRouteLive } from '../src/data/applyRouteLive';
import { rideGuideItinerary } from '../src/data/rideGuide';
import { clearRouteLiveReads, fetchRouteLiveData, fetchRoutesLiveData } from '../src/data/transitLive';
import { auth } from '../src/lib/firebase';

const getRouteLiveStatus = httpsCallable({} as never, 'getRouteLiveStatus') as unknown as jest.Mock;
const getRoutesLiveStatus = httpsCallable({} as never, 'getRoutesLiveStatus') as unknown as jest.Mock;
const source: LiveSource = { agencyId: 'subway', routeId: '1', direction1StopId: '127N', direction0StopId: '127S', direction1Index: 0 };

describe('fetchRouteLiveData', () => {
  beforeEach(() => {
    clearRouteLiveReads();
    getRouteLiveStatus.mockClear();
    getRoutesLiveStatus.mockReset();
    Object.defineProperty(auth, 'currentUser', { configurable: true, value: { uid: 'alice' }, writable: true });
  });

  it("keeps the nearest stop's position, so the walk to it needs no timetable", async () => {
    getRouteLiveStatus.mockResolvedValue({
      data: {
        routeId: '1',
        routeName: '1',
        vehicles: [],
        stopPredictions: { towardDirection1: [], towardDirection0: [] },
        nearestStop: {
          distanceMeters: 120,
          direction1: { stopId: '127', name: 'Times Sq-42 St', headsign: 'Van Cortlandt Park', lat: 40.7553, lon: -73.9868 },
          direction0: { stopId: '127', name: 'Times Sq-42 St', headsign: 'South Ferry', lat: 40.7553, lon: -73.9868 },
        },
      },
    });
    const live = await fetchRouteLiveData(source, { latitude: 40.7549, longitude: -73.984 });
    expect(live.nearestStop?.direction1).toEqual({ stopId: '127', name: 'Times Sq-42 St', lat: 40.7553, lon: -73.9868 });
    expect(live.nearestStop?.direction0).toEqual({ stopId: '127', name: 'Times Sq-42 St', lat: 40.7553, lon: -73.9868 });
  });

  it('retains exact run/date/stop evidence through live normalization and countdown aging into GO', async () => {
    const fetchedAt = Date.parse('2026-11-22T15:00:00Z');
    const prediction = { minutes: 6, live: true, peakOffpeak: null, tripId: 'run-exact', serviceDate: '20261122', startTime: '09:00:00',
      stopId: 'a', stopSequence: 12, directionId: 1, departureTime: '2026-11-22T15:06:25.000Z' };
    getRouteLiveStatus.mockResolvedValue({ data: { routeId: '1', routeName: '1', vehicles: [], stopPredictions: { towardDirection1: [prediction], towardDirection0: [] } } });
    const data = { ...await fetchRouteLiveData(source), fetchedAt };
    const route = applyRouteLive({ ...routeById.e, liveSource: source }, { status: 'loaded', nearestStop: null, data }, fetchedAt + 60_000);
    expect(route.predictions[0]).toEqual({ ...prediction, minutes: 5 });
    const itinerary = rideGuideItinerary({ routeId: 'subway:1', directionIndex: 0, agency: 'Subway', agencyId: 'subway', routeIdAtAgency: '1',
      mode: 'subway', routeName: '1', shortName: '1', color: '#ee0000', headsign: 'Uptown',
      stops: [{ name: 'Board', stopId: 'a', lat: 40.7, lon: -73.9, offsetMinutes: 0 }, { name: 'Alight', stopId: 'b', lat: 40.71, lon: -73.9, offsetMinutes: 5 }],
      departures: route.predictions, selectedDeparture: 0, notices: [], capturedAt: fetchedAt + 60_000 }, 1)!;
    const leg = itinerary.steps.find((step) => step.kind === 'transit')!;
    expect(leg.kind === 'transit' && leg.runSeed).toMatchObject({ tripId: 'run-exact', serviceDate: '20261122', boardStopSequence: 12, boardStopId: 'a', alightStopId: 'b' });
    expect(itinerary.departureTime).toBe(prediction.departureTime);
  });

  it('shares identical pending reads and a short fresh result, but refreshes at the next poll', async () => {
    jest.useFakeTimers();
    const response = { data: { routeId: '1', routeName: '1', vehicles: [], stopPredictions: { towardDirection1: [], towardDirection0: [] } } };
    let resolve!: (value: typeof response) => void;
    getRouteLiveStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = fetchRouteLiveData(source);
    const second = fetchRouteLiveData(source);
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(1);
    resolve(response);
    expect(await first).toBe(await second);
    await fetchRouteLiveData(source);
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15_000);
    getRouteLiveStatus.mockResolvedValue(response);
    await fetchRouteLiveData(source);
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });

  it('separates stop/location requests, retries failures, and never applies a previous account response', async () => {
    const response = { data: { routeId: '1', routeName: '1', vehicles: [], stopPredictions: { towardDirection1: [], towardDirection0: [] } } };
    getRouteLiveStatus.mockResolvedValue(response);
    await fetchRouteLiveData(source);
    await fetchRouteLiveData({ ...source, direction1StopId: 'different-stop' });
    await fetchRouteLiveData(source, { latitude: 40.7, longitude: -73.9 });
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(3);
    clearRouteLiveReads();
    getRouteLiveStatus.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchRouteLiveData(source)).rejects.toThrow('offline');
    await fetchRouteLiveData(source);
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(5);

    clearRouteLiveReads();
    let resolve!: (value: typeof response) => void;
    getRouteLiveStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const alice = fetchRouteLiveData(source);
    const rejected = expect(alice).rejects.toThrow('account changed');
    Object.assign(auth, { currentUser: { uid: 'bob' } });
    await fetchRouteLiveData(source);
    resolve(response);
    await rejected;
    await fetchRouteLiveData(source);
    expect(getRouteLiveStatus).toHaveBeenCalledTimes(7);
  });

  it('rejects a late batch owner and never assigns a mismatched route response by array position', async () => {
    const data = { routeId: '1', routeName: '1', vehicles: [], stopPredictions: { towardDirection1: [], towardDirection0: [] } };
    getRoutesLiveStatus.mockResolvedValueOnce({ data: { results: [{ ok: true, data: { ...data, routeId: 'wrong-route' } }] } });
    expect(await fetchRoutesLiveData([source])).toEqual([null]);
    let resolve!: (value: unknown) => void;
    getRoutesLiveStatus.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = fetchRoutesLiveData([source]);
    const rejected = expect(pending).rejects.toThrow('account changed');
    Object.assign(auth, { currentUser: { uid: 'bob' } });
    resolve({ data: { results: [{ ok: true, data }] } });
    await rejected;
  });
});
