import AsyncStorage from '@react-native-async-storage/async-storage';

import { advanceTripAlerts, BACKGROUND_TRIP_MAX_AGE_MS, parseTripAlertState, tripAlertState, type TripAlertState } from '../src/background/tripAlertState';
import { claimTripApproach, deliverTripApproach, queueTripAlertWork, readTripAlertState, TRIP_ALERT_STATE_KEY, writeTripAlertState } from '../src/background/tripAlertStorage';
import { initialNavigationCursor, normalizeItinerary, type ActiveTripRuntime, type NavigationFix } from '../src/data/enrouteNavigation';
import type { Itinerary, LatLng, TransitStep } from '../src/data/tripPlanning';

const NOW = Date.UTC(2026, 10, 21, 15);
const p = (offset: number, lngOffset = 0): LatLng => ({ lat: 40.7 + offset, lng: -73.9 + lngOffset });
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const stop = (name: string, point: LatLng, minute: number) => ({ name, location: point, time: at(minute) });
const transit = (name: string, from: LatLng, middle: LatLng, to: LatLng, minute = 0): TransitStep => ({
  kind: 'transit', mode: 'rail', agency: { name: 'Fixture Transit' }, line: { name, shortName: name }, headsign: 'Terminal',
  from: stop(name + ' start', from, minute), to: stop(name + ' exit', to, minute + 20), durationSeconds: 1200,
  stops: [stop(name + ' middle', middle, minute + 10)], stopCount: 2,
  path: [from, p(from.lat - 40.7 + 0.001, 0.005), middle, p(to.lat - 40.7 - 0.001, 0.005), to],
});
const multi: Itinerary = {
  id: 'two-leg-fixture', departureTime: at(0), arrivalTime: at(60), durationSeconds: 3600, transfers: 1,
  steps: [
    { kind: 'walk', path: [p(0), p(0.001, 0.003), p(0.002)], toName: 'A start', durationSeconds: 300, distanceMeters: 200 },
    transit('A', p(0.002), p(0.01), p(0.02), 5),
    { kind: 'walk', path: [p(0.02), p(0.021, 0.003), p(0.022)], toName: 'B start', durationSeconds: 300, distanceMeters: 200 },
    transit('B', p(0.022), p(0.03), p(0.04), 30),
    { kind: 'walk', path: [p(0.04), p(0.041, 0.003), p(0.042)], toName: 'Destination', durationSeconds: 300, distanceMeters: 200 },
  ],
};
const single: Itinerary = {
  id: 'one-leg-fixture', departureTime: at(0), arrivalTime: at(20), durationSeconds: 1200, transfers: 0,
  steps: [transit('A', p(0), p(0.01), p(0.02))],
};
function runtime(itinerary = multi): ActiveTripRuntime {
  const plan = normalizeItinerary(itinerary);
  return {
    uid: 'rider-A', sessionId: 'session-A', itinerary, plan, selection: plan.selection,
    origin: { kind: 'coordinate', label: 'Start', point: p(0), savedAt: NOW },
    destination: { kind: 'coordinate', label: 'Destination', point: p(0.042), savedAt: NOW },
    startedAt: NOW, updatedAt: NOW, cursor: initialNavigationCursor(plan, NOW), evidence: null,
  };
}
const fix = (point: LatLng, capturedAt: number, extra: Partial<NavigationFix> = {}): NavigationFix => ({
  point, capturedAt, accuracyMeters: 5, source: 'real', ...extra,
});
const pair = (point: LatLng, timestamp: number) => [fix(point, timestamp), fix(point, timestamp + 1)];
const initial = (itinerary = multi) => tripAlertState(runtime(itinerary), null, NOW);
const move = (state: TripAlertState, point: LatLng, timestamp: number) => advanceTripAlerts(state, pair(point, timestamp), timestamp + 1);
const serialize = (state: TripAlertState) => JSON.stringify(state);

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  await AsyncStorage.clear();
});
afterEach(() => jest.restoreAllMocks());

it('persists only operational anchors and whitelisted metadata, never provider polylines or attached responses', () => {
  const live = runtime();
  (live.plan as unknown as { providerResponse: unknown }).providerResponse = { secretShape: 'discard-me' };
  const state = tripAlertState(live, null, NOW);
  const anchors = new Set(state.plan.checkpoints.map((point) => JSON.stringify(point.point)));
  expect(state.plan.checkpoints.every((point) => point.kind !== 'walk')).toBe(true);
  expect(state.plan.segments.every((segment) => segment.path.every((point) => anchors.has(JSON.stringify(point))))).toBe(true);
  expect(serialize(state)).not.toContain('discard-me');
  expect(serialize(state)).not.toContain('providerResponse');
  expect(state).not.toHaveProperty('itinerary');
  expect(parseTripAlertState(serialize(state), NOW)).not.toBeNull();
});

it('needs two fresh real fixes and retains the first confirmation across same-owner sync', () => {
  const live = runtime(single);
  const first = advanceTripAlerts(tripAlertState(live, null, NOW), [fix(p(0.01), NOW + 1000)], NOW + 1000);
  expect(first.state.cursor.checkpointOrdinal).toBe(0);
  expect(first.state.evidence?.confirmations).toBe(1);
  const synced = tripAlertState(live, first.state, NOW + 1000);
  expect(synced.evidence?.confirmations).toBe(1);
  const second = advanceTripAlerts(synced, [fix(p(0.01), NOW + 2000)], NOW + 2000);
  expect(second.state.cursor.checkpointOrdinal).toBe(1);
  expect(second.approachStep).toBe(0);
  expect(second.state.alertedSteps).toEqual([]);
});

it('does not rewind a proven background checkpoint or riding phase when an older foreground sync arrives', () => {
  const live = runtime(single);
  const reached = move(initial(single), p(0.01), NOW + 1000).state;
  const synced = tripAlertState(live, reached, NOW + 2000);
  expect(synced.cursor).toEqual(reached.cursor);
  const oneStop = { ...single, steps: [{ ...(single.steps[0] as TransitStep), stops: [], stopCount: 1 }] };
  const aboard = move(initial(oneStop), p(0.005), NOW + 1000).state;
  expect(aboard.cursor.phase).toBe('riding');
  expect(aboard.cursor.checkpointOrdinal).toBe(0);
  expect(tripAlertState(runtime(oneStop), aboard, NOW + 2000).cursor.phase).toBe('riding');
});

it('clears the old ledger/evidence on account, session, or selected departure replacement', () => {
  const live = runtime(single);
  const prior = { ...move(initial(single), p(0.01), NOW + 1000).state, alertedSteps: [0] };
  for (const replacement of [
    { ...live, uid: 'rider-B' }, { ...live, sessionId: 'session-B' },
    runtime({ ...single, id: 'different-selected-departure' }),
  ]) {
    const state = tripAlertState(replacement, prior, NOW + 2000);
    expect(state.cursor.checkpointOrdinal).toBe(0);
    expect(state.alertedSteps).toEqual([]);
    expect(state.latestFixes).toEqual([]);
    expect(state.evidence).toBeNull();
  }
});

it.each([
  ['poor accuracy', { accuracyMeters: 121 }],
  ['missing accuracy', { accuracyMeters: null }],
  ['invalid coordinates', { point: { lat: 100, lng: 0 } }],
] as const)('a newer %s fix breaks the confirmation chain', (_label, bad) => {
  const first = advanceTripAlerts(initial(single), [fix(p(0.01), NOW + 1000)], NOW + 1000);
  const interrupted = advanceTripAlerts(first.state, [fix(p(0.01), NOW + 2000, bad)], NOW + 2000);
  expect(interrupted.state.evidence).toBeNull();
  const next = advanceTripAlerts(interrupted.state, [fix(p(0.01), NOW + 3000)], NOW + 3000);
  expect(next.state.cursor.checkpointOrdinal).toBe(0);
  expect(next.approachStep).toBeNull();
});

it('cannot combine an old confirmation with one fresh fix after a gap', () => {
  const first = advanceTripAlerts(initial(single), [fix(p(0.01), NOW)], NOW);
  const later = advanceTripAlerts(first.state, [fix(p(0.01), NOW + 3_600_000)], NOW + 3_600_000);
  expect(later.state.cursor.checkpointOrdinal).toBe(0);
  expect(later.state.evidence?.confirmations).toBe(1);
  const parsed = parseTripAlertState(serialize(first.state), NOW + 61_000)!;
  expect(parsed.latestFixes).toEqual([]);
  expect(parsed.evidence).toBeNull();
});

it('ignores duplicates, old batches, future timestamps, stale fixes, and admin mocks', () => {
  const first = advanceTripAlerts(initial(single), [fix(p(0.01), NOW + 1000)], NOW + 1000);
  const ignored = [
    fix(p(0.01), NOW + 1000), fix(p(0.01), NOW + 500),
    fix(p(0.01), NOW + 10_000), fix(p(0.01), NOW - 61_000),
    fix(p(0.01), NOW + 2000, { source: 'mock' }),
  ];
  const result = advanceTripAlerts(first.state, ignored, NOW + 2000);
  expect(result.state.cursor.checkpointOrdinal).toBe(0);
  expect(result.approachStep).toBeNull();
  expect(result.state.latestFixes).toHaveLength(1);
});

it('does not apply an old native task batch captured before the new trip began', () => {
  const result = advanceTripAlerts(initial(single), pair(p(0.01), NOW - 1000), NOW);
  expect(result.state.cursor.checkpointOrdinal).toBe(0);
  expect(result.state.latestFixes).toEqual([]);
  expect(result.approachStep).toBeNull();
});

it('posts no obsolete approach when one batched delivery has already confirmed the exit', () => {
  const result = advanceTripAlerts(initial(single), [...pair(p(0.01), NOW + 1000), ...pair(p(0.02), NOW + 2000)], NOW + 2001);
  expect(result.finished).toBe(true);
  expect(result.approachStep).toBeNull();
  expect(result.notification?.alert).toBe(false);
  expect(result.notification?.body).toBe('Trip complete');
});

it('suppresses a passed transfer alert and offers the next leg separately', () => {
  const batch = [p(0.002), p(0.01), p(0.02), p(0.022)].flatMap((point, index) => pair(point, NOW + 1000 + index * 1000));
  const atTransfer = advanceTripAlerts(initial(), batch, NOW + 4001);
  expect(atTransfer.state.cursor.phase).toBe('waiting-to-board');
  expect(atTransfer.state.cursor.stepIndex).toBe(3);
  expect(atTransfer.approachStep).toBeNull();
  const next = move({ ...atTransfer.state, alertedSteps: [1] }, p(0.03), NOW + 5000);
  expect(next.approachStep).toBe(3);
});

it('retries an unposted approach only with fresh usable evidence, and respects the committed claim', () => {
  const first = move(initial(single), p(0.01), NOW + 1000);
  expect(first.approachStep).toBe(0);
  expect(first.state.alertedSteps).toEqual([]);
  expect(advanceTripAlerts(first.state, [], NOW + 2000).approachStep).toBeNull();
  expect(advanceTripAlerts(first.state, [fix(p(0.01), NOW + 2000)], NOW + 2000).approachStep).toBe(0);
  const committed = { ...first.state, alertedSteps: [0] };
  expect(advanceTripAlerts(committed, [fix(p(0.01), NOW + 2000)], NOW + 2000).approachStep).toBeNull();
  expect(advanceTripAlerts(first.state, [fix(p(0.01, 0.02), NOW + 2000)], NOW + 2000).approachStep).toBeNull();
});

it.each([{ stops: undefined }, { stops: [] }])('never invents a remaining-stop warning for an incomplete stop sequence $stops', ({ stops }) => {
  const sparse = { ...single, steps: [{ ...(single.steps[0] as TransitStep), stops, stopCount: 5 }] };
  expect(move(initial(sparse), p(0.005), NOW + 1000).approachStep).toBeNull();
});

it('expires the operational monitor without extending its lifetime on sync', () => {
  const live = runtime(single);
  const state = tripAlertState(live, null, NOW);
  expect(parseTripAlertState(serialize(state), NOW + BACKGROUND_TRIP_MAX_AGE_MS)).toBeNull();
  expect(advanceTripAlerts(state, pair(p(0.01), NOW + BACKGROUND_TRIP_MAX_AGE_MS), NOW + BACKGROUND_TRIP_MAX_AGE_MS).finished).toBe(true);
  const resynced = tripAlertState({ ...live, startedAt: NOW + 1000 }, state, NOW + 1000);
  expect(resynced.expiresAt).toBe(state.expiresAt);
});

it('rejects corrupt or oversized state rather than trusting fields used by navigation', () => {
  const mutations: ((state: any) => void)[] = [
    (s) => { s.cursor.phase = 'invalid'; }, (s) => { s.cursor.stepIndex = -1; },
    (s) => { s.cursor.lastAdvancedAt = NOW + 60_000; }, (s) => { s.plan.checkpoints[0].key = null; },
    (s) => { s.plan.checkpoints[0].kind = 'walk'; }, (s) => { s.plan.checkpoints[0].pathIndex = 999; },
    (s) => { s.plan.segments[0].path = []; }, (s) => { s.plan.segments[0].endCheckpointOrdinal = 999; },
    (s) => { s.plan.segments[0].path.push(p(0.003, 0.002)); }, (s) => { s.plan.segments[0].knownStopCount = 50; },
    (s) => { s.latestFixes = [fix(p(0.01), NOW + 60_000)]; },
    (s) => { s.alertedSteps = [0, 0]; }, (s) => { s.alertedSteps = [99]; },
    (s) => { s.expiresAt = NOW + BACKGROUND_TRIP_MAX_AGE_MS + 1; },
  ];
  for (const mutate of mutations) {
    const state = JSON.parse(serialize(initial(single)));
    mutate(state);
    expect(parseTripAlertState(JSON.stringify(state), NOW)).toBeNull();
  }
  expect(parseTripAlertState(' '.repeat(1_500_001), NOW)).toBeNull();
});

it('serializes per-leg claims and prevents another account/session from claiming or mutating the ledger', async () => {
  const state = initial();
  await writeTripAlertState(state);
  const owner = { uid: state.uid, sessionId: state.sessionId };
  expect(await Promise.all([claimTripApproach(owner, 1), claimTripApproach(owner, 1)])).toEqual([true, false]);
  expect(await claimTripApproach({ ...owner, uid: 'other-rider' }, 3)).toBe(false);
  expect(await claimTripApproach({ ...owner, sessionId: 'other-session' }, 3)).toBe(false);
  expect(await claimTripApproach(owner, 2)).toBe(false);
  expect(await claimTripApproach(owner, -1)).toBe(false);
  expect((await readTripAlertState())?.alertedSteps).toEqual([1]);
});

it('a foreground claim waits for a pending native post commit instead of sounding twice', async () => {
  const state = initial();
  await writeTripAlertState(state);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const posting = queueTripAlertWork(async () => {
    await gate;
    await writeTripAlertState({ ...state, alertedSteps: [1] });
  });
  const foreground = claimTripApproach(state, 1);
  release();
  await posting;
  expect(await foreground).toBe(false);
});

it('rechecks the saved owner after queued account replacement and retains foreground fallback on storage failure', async () => {
  const state = initial();
  await writeTripAlertState(state);
  const replacing = queueTripAlertWork(() => writeTripAlertState({ ...state, uid: 'rider-B', sessionId: 'session-B' }));
  const oldClaim = claimTripApproach(state, 1);
  await replacing;
  expect(await oldClaim).toBe(false);
  await AsyncStorage.removeItem(TRIP_ALERT_STATE_KEY);
  expect(await claimTripApproach(state, 1)).toBe(true);
  await writeTripAlertState(state);
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('fixture disk unavailable'));
  expect(await claimTripApproach(state, 1)).toBe(true);
  expect((await readTripAlertState())?.alertedSteps).toEqual([]);
});

it('commits a foreground approach only after delivery is accepted and retries failed notification-only attempts', async () => {
  const state = initial();
  await writeTripAlertState(state);
  const failed = jest.fn(async () => false);
  expect(await deliverTripApproach(state, 1, failed)).toEqual({ firstWarning: true, accepted: false });
  expect((await readTripAlertState())?.alertedSteps).toEqual([]);
  const succeeds = jest.fn(async () => true);
  expect(await deliverTripApproach(state, 1, succeeds)).toEqual({ firstWarning: true, accepted: true });
  expect((await readTripAlertState())?.alertedSteps).toEqual([1]);
  await deliverTripApproach(state, 1, succeeds);
  expect(succeeds).toHaveBeenLastCalledWith(false);
});

it('serializes foreground delivery with background claims and never invokes another owner callback', async () => {
  const state = initial();
  await writeTripAlertState(state);
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => { complete = resolve; });
  const deliver = jest.fn(async () => { await pending; return true; });
  const first = deliverTripApproach(state, 1, deliver);
  await Promise.resolve();
  const background = claimTripApproach(state, 1);
  complete();
  await first;
  expect(await background).toBe(false);
  const wrongOwner = jest.fn(async () => true);
  expect(await deliverTripApproach({ ...state, uid: 'other' }, 1, wrongOwner)).toBeNull();
  expect(wrongOwner).not.toHaveBeenCalled();
});

it('does not repeat a delivered warning if persisting its acceptance fails', async () => {
  const state = initial();
  await writeTripAlertState(state);
  (AsyncStorage.setItem as jest.Mock).mockRejectedValueOnce(new Error('disk-full'));
  const deliver = jest.fn(async () => true);
  expect(await deliverTripApproach(state, 1, deliver)).toEqual({ firstWarning: true, accepted: true });
  expect(deliver).toHaveBeenCalledTimes(1);
});
