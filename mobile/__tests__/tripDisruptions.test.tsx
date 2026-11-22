import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render } from '@testing-library/react-native';

import { TripDisruptionNotice } from '../src/components/TripDisruptionNotice';
import { initialNavigationCursor, normalizeItinerary } from '../src/data/enrouteNavigation';
import { dismissTripDisruption, presentTripDisruption, tripDisruptionDismissed } from '../src/data/tripDisruptionStorage';
import { tripDisruptionFor } from '../src/data/tripDisruptions';
import { ETA_NOW, etaAt, nativeJourney, nativeObservation, nativeResponse } from './fixtures/nativeJourney';

const trip = nativeJourney();
const riding = { ...initialNavigationCursor(normalizeItinerary(trip), ETA_NOW), stepIndex: 1, phase: 'riding' as const };
const owner = { uid: 'alice', sessionId: 'active-trip' };
beforeEach(async () => { await AsyncStorage.clear(); });

it('keeps routine delays silent and identifies a significant delay without changing the selected run', () => {
  expect(tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { arrives: etaAt(25) })]), riding, ETA_NOW)).toBeNull();
  const notice = tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { arrives: etaAt(40) })]), riding, ETA_NOW, etaAt(63));
  expect(notice).toMatchObject({ kind: 'major-delay', delaySeconds: 1200 });
  expect(trip.steps[1]).toMatchObject({ tripId: 'bus-a' });
});

it('never interrupts for completed, stale, unmatched or already-boarded skipped boarding stops', () => {
  expect(tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { status: 'skips-stop', boardSkipped: true })]), riding, ETA_NOW)).toBeNull();
  expect(tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { status: 'cancelled' })]), riding, ETA_NOW + 90_000)).toBeNull();
  expect(tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { status: 'cancelled' })]), { ...riding, stepIndex: 3 }, ETA_NOW)).toBeNull();
  expect(tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { status: 'skips-stop', alightSkipped: true })]), riding, ETA_NOW)?.kind).toBe('skips-stop');
});

it('shares one incident claim across foreground/background and persists dismissal', async () => {
  const deliver = jest.fn(async () => true);
  await Promise.all([presentTripDisruption(owner, 'incident', deliver), presentTripDisruption(owner, 'incident', deliver)]);
  expect(deliver).toHaveBeenCalledTimes(1);
  await dismissTripDisruption(owner, 'incident');
  expect(await tripDisruptionDismissed(owner, 'incident')).toBe(true);
  expect(await tripDisruptionDismissed({ ...owner, sessionId: 'another-trip' }, 'incident')).toBe(false);
});

it('retries an unaccepted notification instead of claiming delivery', async () => {
  const deliver = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await presentTripDisruption(owner, 'incident', deliver);
  await presentTripDisruption(owner, 'incident', deliver);
  expect(deliver).toHaveBeenCalledTimes(2);
});

it('renders an inline dismissible notice with no route decision buttons', () => {
  const notice = tripDisruptionFor(trip, nativeResponse([nativeObservation(1, { status: 'cancelled' })]), riding, ETA_NOW, etaAt(63))!;
  const dismiss = jest.fn();
  const screen = render(<TripDisruptionNotice notice={notice} onDismiss={dismiss} />);
  expect(screen.getByTestId('trip-disruption-notice')).toBeTruthy();
  expect(screen.getByText('New arrival 11:03 AM')).toBeTruthy();
  fireEvent.press(screen.getByTestId('trip-disruption-dismiss'));
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Accept')).toBeNull();
});
