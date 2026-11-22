import type { Itinerary, TransitStep } from '../../src/data/tripPlanning';
import type { TripLegObservation, TripLiveResponse, TripRunRef } from '../../src/data/tripLiveTypes';

export const ETA_NOW = Date.parse('2026-11-22T15:00:00Z');
export const etaAt = (minutes: number) => new Date(ETA_NOW + minutes * 60_000).toISOString();
export const nativeRun = (overrides: Partial<TripRunRef> = {}): TripRunRef => ({
  version: 1, agencyId: 'suffolk', routeId: '51', tripId: 'bus-a', serviceDate: '20261122',
  scheduleVersion: 'routing-v1:test', startTime: '09:30:00', boardStopId: 'a', alightStopId: 'b',
  boardOccurrence: 0, alightOccurrence: 0, boardStopSequence: 1, alightStopSequence: 3, directionId: 0, ...overrides,
});
export function nativeJourney(): Itinerary {
  const leg = (from: number, to: number, runRef: TripRunRef, latitude: number): TransitStep => ({
    kind: 'transit', mode: 'bus', agency: { name: 'Suffolk County Transit' }, line: { name: runRef.routeId, shortName: runRef.routeId },
    from: { name: runRef.boardStopId, time: etaAt(from), location: { lat: latitude, lng: -73.1 } },
    to: { name: runRef.alightStopId, time: etaAt(to), location: { lat: latitude + 0.01, lng: -73.1 } },
    durationSeconds: (to - from) * 60, stopCount: 2, path: [{ lat: latitude, lng: -73.1 }, { lat: latitude + 0.01, lng: -73.1 }],
    tripId: runRef.tripId, runRef, minimumTransferSeconds: 0,
    liveRoute: { agencyId: runRef.agencyId, routeId: runRef.routeId, boardStopId: runRef.boardStopId, alightStopId: runRef.alightStopId, directionId: 0 },
  });
  return { id: 'native-original-result', departureTime: etaAt(8), arrivalTime: etaAt(43), durationSeconds: 35 * 60, transfers: 1, steps: [
    { kind: 'walk', durationSeconds: 120, distanceMeters: 150, toName: 'a', path: [{ lat: 40.799, lng: -73.1 }, { lat: 40.8, lng: -73.1 }] },
    leg(10, 20, nativeRun(), 40.8),
    { kind: 'walk', durationSeconds: 180, distanceMeters: 220, toName: 'c', path: [{ lat: 40.81, lng: -73.1 }, { lat: 40.812, lng: -73.1 }] },
    leg(25, 40, nativeRun({ routeId: '62', tripId: 'bus-b', boardStopId: 'c', alightStopId: 'd' }), 40.812),
    { kind: 'walk', durationSeconds: 180, distanceMeters: 220, toName: 'Meeting', path: [{ lat: 40.822, lng: -73.1 }, { lat: 40.823, lng: -73.1 }] },
  ] };
}
export function nativeObservation(stepIndex: number, overrides: Partial<TripLegObservation> = {}, itinerary = nativeJourney()): TripLegObservation {
  const step = itinerary.steps[stepIndex] as TransitStep;
  return { legKey: String(stepIndex), runRef: step.runRef!, state: 'fresh', status: 'predicted', observedAt: ETA_NOW, expiresAt: ETA_NOW + 90_000,
    departs: step.from.time, arrives: step.to.time, ...overrides };
}
export const nativeResponse = (legs: TripLegObservation[]): TripLiveResponse => ({ version: 1, fetchedAt: ETA_NOW, legs });
