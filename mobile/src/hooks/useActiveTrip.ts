import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  advanceNavigation,
  createTripSelectionIdentity,
  distanceMeters,
  initialNavigationCursor,
  normalizeItinerary,
  resetNavigation,
  sameTripSelection,
  type ActiveTripRuntime,
  type NavigationAdvanceResult,
  type NavigationCursor,
  type NavigationFix,
  type NavigationLocationState,
  type StartTripInput,
  type TripEndpointReference,
} from '../data/enrouteNavigation';
import {
  NAVIGATION_STORAGE_VERSION,
  completeNavigationSession,
  readNavigationDocument,
  recentFromActive,
  updateNavigationDocument,
  type ActiveTripResumeV1,
  type NavigationDocumentV1,
  type NavigationProgressAnchorV1,
  type PersistedLineSummaryV1,
  type RecentTripV1,
} from '../data/navigationStorage';
import {
  planTripForResume,
  recordTripRestoreDiagnostic,
  type Itinerary,
  type ResumePlanRequest,
  type TransitStep,
} from '../data/tripPlanning';
import { parseRideSnapshot } from '../data/rideSnapshot';
import { parseNativeSnapshot } from '../data/nativeSnapshot';
import type { TripRecoveryPlan } from '../data/tripRecovery';
import { enrichRideGuideItinerary } from '../data/rideGuide';
import { parseRideRunSeed, rideRunSeedKey } from '../data/tripRunRef';

export type StartActiveTripInput = StartTripInput & {
  resumeRequest: ResumePlanRequest;
  /** Line rides are assembled from Pathly's own route data, outside the trip planner. */
  resumeSource?: 'ride-guide';
};
export type StartActiveTripResult = 'started' | 'replacement-required' | 'not-ready' | 'failed';
export type ActiveTripStatus = 'hydrating' | 'idle' | 'active' | 'recovery';

export type ActiveTripState = {
  uid: string | null;
  status: ActiveTripStatus;
  active: ActiveTripRuntime | null;
  /** Persisted metadata remains usable by Home and End trip when fresh planning cannot recover. */
  recovery: ActiveTripResumeV1 | null;
  recoveryError: 'unavailable' | 'no-exact-match' | null;
  retrying: boolean;
  recents: RecentTripV1[];
  pendingReplacement: StartActiveTripInput | null;
  locationState: NavigationLocationState | null;
};

export type ActiveTripCoordinator = ActiveTripState & {
  start: (input: StartActiveTripInput) => Promise<StartActiveTripResult>;
  confirmReplacement: () => Promise<boolean>;
  cancelReplacement: () => void;
  retry: () => Promise<boolean>;
  advance: (fix: NavigationFix) => Promise<NavigationAdvanceResult | null>;
  end: () => Promise<boolean>;
  resetForAdmin: () => Promise<boolean>;
  applyRecovery: (input: { sessionId: string; selectionFingerprint: string; stepIndex: number;
    phase: NavigationCursor['phase']; plan: TripRecoveryPlan; isCurrent?: () => boolean; beforePublish?: () => void }) => Promise<boolean>;
};

const RESUME_ANCHOR_MATCH_METERS = 20;

function initialState(uid: string | null): ActiveTripState {
  return {
    uid,
    status: uid ? 'hydrating' : 'idle',
    active: null,
    recovery: null,
    recoveryError: null,
    retrying: false,
    recents: [],
    pendingReplacement: null,
    locationState: null,
  };
}

function endpointPoint(endpoint: TripEndpointReference) {
  return endpoint.kind === 'coordinate' ? endpoint.point : null;
}

/** Runtime itineraries keep the selected trip, but not mutable alternative-departure menus. */
function freezeSelectedItinerary(itinerary: Itinerary): Itinerary {
  return {
    ...itinerary,
    steps: itinerary.steps.map((step) => {
      if (step.kind === 'walk') return { ...step, path: [...step.path] };
      const { departures: _departures, ...selected } = step;
      return {
        ...selected,
        agency: { ...step.agency },
        line: { ...step.line },
        from: { ...step.from, location: { ...step.from.location } },
        to: { ...step.to, location: { ...step.to.location } },
        path: [...step.path],
        ...(step.stops ? { stops: step.stops.map((stop) => ({ ...stop, location: { ...stop.location } })) } : {}),
      };
    }),
  };
}

function lineSummaries(itinerary: Itinerary): PersistedLineSummaryV1[] {
  return itinerary.steps.filter((step): step is TransitStep => step.kind === 'transit').map((step) => ({
    mode: step.mode,
    name: step.line.name,
    ...(step.line.shortName ? { shortName: step.line.shortName } : {}),
    ...(step.line.color ? { color: step.line.color } : {}),
    ...(step.tripId ? { tripId: step.tripId } : {}),
  }));
}

function sessionId(): string {
  const randomUUID = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  return randomUUID ? randomUUID.call(globalThis.crypto) : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function progressAnchor(
  plan: ReturnType<typeof normalizeItinerary>,
  cursor: NavigationCursor,
): NavigationProgressAnchorV1 | undefined {
  const checkpoint = plan.checkpoints[cursor.checkpointOrdinal];
  if (!checkpoint || checkpoint.stepIndex !== cursor.stepIndex) return undefined;
  return {
    kind: checkpoint.kind,
    stepIndex: checkpoint.stepIndex,
    phase: cursor.phase,
    point: { ...checkpoint.point },
  };
}

export function createActiveTripRuntime(
  input: StartTripInput,
  uid: string,
  at = Date.now(),
  id = sessionId(),
): ActiveTripRuntime {
  const itinerary = freezeSelectedItinerary(input.itinerary);
  const plan = normalizeItinerary(itinerary, { origin: endpointPoint(input.origin), destination: endpointPoint(input.destination) });
  return {
    itinerary,
    origin: input.origin,
    destination: input.destination,
    sessionId: id,
    uid,
    plan,
    startedAt: at,
    updatedAt: at,
    cursor: initialNavigationCursor(plan, at),
    evidence: null,
    selection: createTripSelectionIdentity(itinerary),
  };
}

function resumeRecord(runtime: ActiveTripRuntime, request: ResumePlanRequest, snapshotRide = false): ActiveTripResumeV1 {
  const record: ActiveTripResumeV1 = {
    version: NAVIGATION_STORAGE_VERSION,
    sessionId: runtime.sessionId,
    uid: runtime.uid,
    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,
    origin: runtime.origin,
    destination: runtime.destination,
    request: { ...request, origin: runtime.origin, destination: runtime.destination },
    selection: runtime.selection,
    cursor: runtime.cursor,
    progressAnchor: progressAnchor(runtime.plan, runtime.cursor),
    lines: lineSummaries(runtime.itinerary),
  };
  if (!snapshotRide) {
    const nativeSnapshot = parseNativeSnapshot({ version: 1, kind: 'native', itinerary: runtime.itinerary }, record);
    return nativeSnapshot ? { ...record, nativeSnapshot } : record;
  }
  // Reject an invalid new ride before any write can replace or archive the current session.
  const rideSnapshot = parseRideSnapshot({ version: 1, itinerary: runtime.itinerary }, record);
  if (!rideSnapshot) throw new Error('Selected line ride could not be saved');
  return { ...record, rideSnapshot };
}

function resumeCheckpoint(
  plan: ReturnType<typeof normalizeItinerary>,
  cursor: NavigationCursor,
  itinerary: Itinerary,
  anchor: NavigationProgressAnchorV1 | undefined,
) {
  const step = itinerary.steps[cursor.stepIndex];
  if (!step) return null;
  if (cursor.phase === 'arrived') {
    return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'destination' && checkpoint.stepIndex === cursor.stepIndex) ?? null;
  }
  if (cursor.phase === 'waiting-to-board') {
    return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'board' && checkpoint.stepIndex === cursor.stepIndex) ?? null;
  }
  if (cursor.phase === 'riding') {
    if (anchor) {
      if (anchor.stepIndex !== cursor.stepIndex
        || anchor.phase !== cursor.phase
        || (anchor.kind !== 'board' && anchor.kind !== 'transit-stop')) return null;
      // Stop lists are optional provider enrichment, so their indexes may shift between calls.
      // Re-identify the confirmed physical stop and reject ambiguous nearby matches. A riding
      // board checkpoint itself has phase `waiting-to-board`, while its saved cursor phase is
      // `riding`, so kind/step/point are the stable evidence here.
      const matches = plan.checkpoints.filter((checkpoint) => checkpoint.kind === anchor.kind
        && checkpoint.stepIndex === anchor.stepIndex
        && distanceMeters(checkpoint.point, anchor.point) <= RESUME_ANCHOR_MATCH_METERS);
      return matches.length === 1 ? matches[0]! : null;
    }
    // Records written before progress anchors used the provider stop index. Keep that fallback
    // only for those legacy records; applying it to a newly enriched stop list can move the rider.
    const nextStopIndex = cursor.nextStopIndex;
    if (nextStopIndex === undefined) {
      return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'board' && checkpoint.stepIndex === cursor.stepIndex) ?? null;
    }
    return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'transit-stop'
      && checkpoint.stepIndex === cursor.stepIndex
      && checkpoint.transitStopIndex === nextStopIndex - 1) ?? null;
  }
  // Transit boundaries are structural and can be rebased even if earlier walking geometry added
  // checkpoints.
  if (step.kind === 'transit') {
    return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'alight'
      && checkpoint.stepIndex === cursor.stepIndex
      && checkpoint.phase === cursor.phase) ?? null;
  }
  // The first shipped record format had no anchor. Its untouched start cursor is still safe:
  // unlike a mid-walk ordinal, "start of the first walking step" has one structural meaning.
  if (!anchor && cursor.phase === 'walking' && cursor.checkpointOrdinal === 0) {
    return plan.checkpoints.find((checkpoint) => checkpoint.kind === 'start'
      && checkpoint.stepIndex === cursor.stepIndex) ?? null;
  }
  // Walking geometry is provider-owned and may gain or lose generated checkpoints between calls.
  // Match the one small persisted anchor, never the old ordinal, and require a unique nearby point.
  if (!anchor
    || anchor.stepIndex !== cursor.stepIndex
    || anchor.phase !== cursor.phase
    || (cursor.phase !== 'walking' && cursor.phase !== 'transferring')) return null;
  const matches = plan.checkpoints.filter((checkpoint) => checkpoint.kind === anchor.kind
    && checkpoint.stepIndex === anchor.stepIndex
    && checkpoint.phase === anchor.phase
    && distanceMeters(checkpoint.point, anchor.point) <= RESUME_ANCHOR_MATCH_METERS);
  return matches.length === 1 ? matches[0]! : null;
}

function runtimeFromResume(resume: ActiveTripResumeV1, itinerary: Itinerary): ActiveTripRuntime | null {
  const selected = freezeSelectedItinerary(itinerary);
  const selection = createTripSelectionIdentity(selected);
  if (!sameTripSelection(resume.selection, selection)) return null;
  const plan = normalizeItinerary(selected, { origin: endpointPoint(resume.origin), destination: endpointPoint(resume.destination) });
  // A local snapshot keeps identical checkpoint geometry/order. Its ordinal can distinguish
  // stops on a loop that share a location; fresh provider responses still need semantic rebasing.
  const checkpoint = (resume.rideSnapshot || resume.nativeSnapshot) && resume.progressAnchor
    ? snapshotCheckpoint(plan, resume.cursor, resume.progressAnchor)
    : resumeCheckpoint(plan, resume.cursor, selected, resume.progressAnchor);
  // The exact schedule identity intentionally excludes provider geometry. A fresh response can
  // therefore add/remove generated walk checkpoints. Never apply a raw ordinal to a different
  // semantic step; recovery is safer than silently moving the rider forward or backward.
  if (!checkpoint) return null;
  const segment = plan.segments.find((candidate) => candidate.stepIndex === checkpoint.stepIndex
    && checkpoint.ordinal >= candidate.startCheckpointOrdinal
    && checkpoint.ordinal <= candidate.endCheckpointOrdinal);
  const nextStopIndex = resume.cursor.phase === 'riding'
    && checkpoint.kind === 'transit-stop'
    && checkpoint.transitStopIndex !== undefined
    ? checkpoint.transitStopIndex + 1
    : resume.cursor.phase === 'waiting-to-board'
      && segment?.kind === 'transit'
      && segment.knownStopCount !== undefined
      && segment.knownStopCount > 0
      ? 0
      : undefined;
  const { nextStopIndex: _staleNextStopIndex, ...savedCursor } = resume.cursor;
  const cursor = {
    ...savedCursor,
    checkpointOrdinal: checkpoint.ordinal,
    stepIndex: checkpoint.stepIndex,
    ...(nextStopIndex === undefined ? {} : { nextStopIndex }),
  };
  return {
    itinerary: selected,
    origin: resume.origin,
    destination: resume.destination,
    sessionId: resume.sessionId,
    uid: resume.uid,
    plan,
    startedAt: resume.startedAt,
    updatedAt: resume.updatedAt,
    cursor,
    evidence: null,
    selection,
  };
}

function snapshotCheckpoint(
  plan: ReturnType<typeof normalizeItinerary>,
  cursor: NavigationCursor,
  anchor: NavigationProgressAnchorV1,
) {
  const checkpoint = plan.checkpoints[cursor.checkpointOrdinal];
  if (!checkpoint
    || checkpoint.stepIndex !== cursor.stepIndex
    || anchor.stepIndex !== cursor.stepIndex
    || anchor.phase !== cursor.phase
    || anchor.kind !== checkpoint.kind
    || distanceMeters(checkpoint.point, anchor.point) > 1
    || (cursor.phase === 'riding' && checkpoint.transitStopIndex !== undefined
      && cursor.nextStopIndex !== undefined && cursor.nextStopIndex !== checkpoint.transitStopIndex + 1)
    || (checkpoint.phase !== cursor.phase && !(checkpoint.kind === 'board' && cursor.phase === 'riding'))) return null;
  return checkpoint;
}

function activeSessionId(state: ActiveTripState): string | null {
  return state.active?.sessionId ?? state.recovery?.sessionId ?? null;
}

function sameEndpoint(left: TripEndpointReference, right: TripEndpointReference): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'place' && right.kind === 'place') return left.placeId === right.placeId;
  return left.kind === 'coordinate' && right.kind === 'coordinate'
    && left.point.lat === right.point.lat
    && left.point.lng === right.point.lng
    && left.savedAt === right.savedAt;
}

function isSameActiveTrip(active: ActiveTripRuntime, input: StartActiveTripInput): boolean {
  const selection = createTripSelectionIdentity(input.itinerary);
  const previousRide = active.itinerary.steps.find((step): step is TransitStep => step.kind === 'transit');
  const nextRide = input.itinerary.steps.find((step): step is TransitStep => step.kind === 'transit');
  const previousSeed = parseRideRunSeed(previousRide?.runSeed);
  const nextSeed = parseRideRunSeed(nextRide?.runSeed);
  const sameChosenRide = input.resumeSource === 'ride-guide' && active.itinerary.id === input.itinerary.id
    && Boolean(previousRide?.runRef || nextRide?.runRef)
    && previousSeed && nextSeed && rideRunSeedKey(previousSeed) === rideRunSeedKey(nextSeed);
  return (sameTripSelection(active.selection, selection) || Boolean(sameChosenRide))
    && sameEndpoint(active.origin, input.origin)
    && sameEndpoint(active.destination, input.destination);
}

async function prepareStart(input: StartActiveTripInput, isCurrent: () => boolean): Promise<StartActiveTripInput | null> {
  if (input.resumeSource !== 'ride-guide') return isCurrent() ? input : null;
  const itinerary = await enrichRideGuideItinerary(input.itinerary, { isCurrent });
  return itinerary && isCurrent() ? { ...input, itinerary,
    resumeRequest: { ...input.resumeRequest, time: { mode: 'depart', at: itinerary.departureTime } } } : null;
}

/** Per-UID active-trip lifecycle; Home owns one instance and passes its state to child views. */
export function useActiveTrip(uid: string | undefined): ActiveTripCoordinator {
  const normalizedUid = uid ?? null;
  const ownerScope = useMemo(() => ({ uid: normalizedUid }), [normalizedUid]);
  const ownerRef = useRef<typeof ownerScope | null>(ownerScope);
  useLayoutEffect(() => {
    ownerRef.current = ownerScope;
    return () => { if (ownerRef.current === ownerScope) ownerRef.current = null; };
  }, [ownerScope]);
  const [state, setState] = useState<ActiveTripState>(() => initialState(normalizedUid));
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const actionQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const replacementConfirmationRef = useRef<Promise<boolean> | null>(null);

  const commit = useCallback((next: ActiveTripState | ((current: ActiveTripState) => ActiveTripState)) => {
    const resolved = typeof next === 'function' ? next(stateRef.current) : next;
    stateRef.current = resolved;
    setState(resolved);
  }, []);

  const enqueue = useCallback(<Result,>(action: () => Promise<Result>, stale: Result): Promise<Result> => {
    if (ownerRef.current !== ownerScope) return Promise.resolve(stale);
    const generation = generationRef.current;
    const next = actionQueueRef.current.catch(() => undefined).then(() => ownerRef.current === ownerScope && generationRef.current === generation ? action() : stale);
    actionQueueRef.current = next;
    return next;
  }, [ownerScope]);

  const recover = useCallback(async (resume: ActiveTripResumeV1, recents: RecentTripV1[]): Promise<boolean> => {
    const generation = generationRef.current;
    const isCurrent = () => generationRef.current === generation && stateRef.current.uid === resume.uid;
    const snapshot = resume.nativeSnapshot ?? resume.rideSnapshot;
    const result = snapshot
      ? { ok: true as const, itinerary: snapshot.itinerary }
      : await planTripForResume(resume.request, resume.selection, { isCurrent });
    // UID alone can match again after A -> B -> A. Only the owning mounted account epoch may
    // publish a runtime or migrate its saved metadata after a pending network/storage request.
    if (!isCurrent()) return false;
    if (!result.ok) {
      commit({
        uid: resume.uid,
        status: 'recovery',
        active: null,
        recovery: resume,
        recoveryError: result.problem,
        retrying: false,
        recents,
        pendingReplacement: null,
        locationState: null,
      });
      return false;
    }
    const active = runtimeFromResume(resume, result.itinerary);
    if (!active) {
      recordTripRestoreDiagnostic({ category: 'progress-anchor-mismatch' });
      commit({
        uid: resume.uid,
        status: 'recovery',
        active: null,
        recovery: resume,
        recoveryError: 'no-exact-match',
        retrying: false,
        recents,
        pendingReplacement: null,
        locationState: null,
      });
      return false;
    }
    let recoveredRecents = recents;
    if (resume.selection.version === 1) {
      try {
        let migrated = false;
        const document = await updateNavigationDocument(resume.uid, (stored) => {
          if (!isCurrent() || stored.active?.sessionId !== resume.sessionId) return stored;
          migrated = true;
          return {
            ...stored,
            // Migration refreshes selection/progress evidence, not the user-visible route
            // summary. Fresh responses may omit optional timetable enrichment used to build it.
            active: { ...resumeRecord(active, resume.request, Boolean(resume.rideSnapshot)), lines: stored.active.lines },
          };
        });
        if (!isCurrent()) return false;
        if (!migrated) {
          commit({ ...initialState(resume.uid), status: 'idle', recents: document.recents });
          return false;
        }
        recoveredRecents = document.recents;
      } catch {
        if (!isCurrent()) return false;
        commit({
          uid: resume.uid,
          status: 'recovery',
          active: null,
          recovery: resume,
          recoveryError: 'unavailable',
          retrying: false,
          recents,
          pendingReplacement: null,
          locationState: null,
        });
        return false;
      }
    }
    commit({
      uid: resume.uid,
      status: 'active',
      active,
      recovery: null,
      recoveryError: null,
      retrying: false,
      recents: recoveredRecents,
      pendingReplacement: null,
      locationState: null,
    });
    return true;
  }, [commit]);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    actionQueueRef.current = Promise.resolve();
    replacementConfirmationRef.current = null;
    commit(initialState(normalizedUid));
    if (!normalizedUid) return undefined;
    let cancelled = false;
    void readNavigationDocument(normalizedUid).then(async (document) => {
      if (cancelled || generationRef.current !== generation) return;
      if (!document.active) {
        commit({ ...initialState(normalizedUid), status: 'idle', recents: document.recents });
        return;
      }
      await recover(document.active, document.recents);
    }, () => {
      if (!cancelled && generationRef.current === generation) commit({ ...initialState(normalizedUid), status: 'idle' });
    });
    return () => {
      cancelled = true;
      generationRef.current += 1;
    };
  }, [commit, normalizedUid, recover]);

  const install = useCallback(async (accountUid: string, input: StartActiveTripInput, now = Date.now()): Promise<boolean> => {
    const generation = generationRef.current;
    const owner = ownerRef.current;
    const isCurrent = () => ownerRef.current === owner && generationRef.current === generation && stateRef.current.uid === accountUid;
    try {
      const runtime = createActiveTripRuntime(input, accountUid, now);
      const persisted = resumeRecord(runtime, input.resumeRequest, input.resumeSource === 'ride-guide');
      const document = await updateNavigationDocument(accountUid, (current) => isCurrent() ? { ...current, active: persisted } : current, now);
      if (document.active?.sessionId !== runtime.sessionId || !isCurrent()) return false;
      commit({
        uid: accountUid,
        status: 'active',
        active: runtime,
        recovery: null,
        recoveryError: null,
        retrying: false,
        recents: document.recents,
        pendingReplacement: null,
        locationState: null,
      });
      return true;
    } catch {
      return false;
    }
  }, [commit]);

  const start = useCallback((input: StartActiveTripInput) => enqueue(async () => {
    const generation = generationRef.current;
    const owner = ownerRef.current;
    const current = stateRef.current;
    if (!current.uid || current.status === 'hydrating') return 'not-ready' as const;
    const prepared = await prepareStart(input, () => ownerRef.current === owner && generationRef.current === generation && stateRef.current.uid === current.uid);
    if (!prepared || ownerRef.current !== owner || generationRef.current !== generation || stateRef.current.uid !== current.uid) return 'not-ready' as const;
    // A double tap can enqueue the same GO action twice before the first storage write finishes.
    // Once that first action succeeds, treat the matching second action as the same start rather
    // than asking the rider to replace the trip that action just created.
    if (current.active && isSameActiveTrip(current.active, prepared)) return 'started' as const;
    if (current.active || current.recovery) {
      commit({ ...current, pendingReplacement: prepared });
      return 'replacement-required' as const;
    }
    return await install(current.uid, prepared) ? 'started' as const : 'failed' as const;
  }, 'not-ready' as const), [commit, enqueue, install]);

  const cancelReplacement = useCallback(() => {
    const current = stateRef.current;
    if (ownerRef.current === ownerScope && current.uid === normalizedUid && current.pendingReplacement) commit({ ...current, pendingReplacement: null });
  }, [commit, normalizedUid, ownerScope]);

  const confirmReplacement = useCallback(() => {
    if (replacementConfirmationRef.current) return replacementConfirmationRef.current;
    const confirmation = enqueue(async () => {
      const current = stateRef.current;
      const pending = current.pendingReplacement;
      const id = activeSessionId(current);
      if (!current.uid || !pending || !id) return false;
      const at = Date.now();
      try {
        const generation = generationRef.current;
        const prepared = await prepareStart(pending, () => generationRef.current === generation && stateRef.current.uid === current.uid);
        if (!prepared) return false;
        const runtime = createActiveTripRuntime(prepared, current.uid, at);
        const replacement = resumeRecord(runtime, prepared.resumeRequest, prepared.resumeSource === 'ride-guide');
        let replaced = false;
        const document = await updateNavigationDocument(current.uid, (stored) => {
          const previous = generationRef.current === generation && stateRef.current.uid === current.uid && stored.active?.sessionId === id ? stored.active : null;
          if (!previous) return stored;
          replaced = true;
          const recents = stored.recents.some((recent) => recent.sessionId === id)
            ? stored.recents
            : [recentFromActive(previous, 'ended-early', at), ...stored.recents];
          return { ...stored, active: replacement, recents };
        }, at);
        if (!replaced || document.active?.sessionId !== runtime.sessionId || stateRef.current.uid !== current.uid || generationRef.current !== generation) return false;
        commit({
          uid: current.uid,
          status: 'active',
          active: runtime,
          recovery: null,
          recoveryError: null,
          retrying: false,
          recents: document.recents,
          pendingReplacement: null,
          locationState: null,
        });
        return true;
      } catch {
        return false;
      }
    }, false);
    const tracked = confirmation.finally(() => {
      if (replacementConfirmationRef.current === tracked) replacementConfirmationRef.current = null;
    });
    replacementConfirmationRef.current = tracked;
    return tracked;
  }, [commit, enqueue]);

  const retry = useCallback(() => enqueue(async () => {
    const current = stateRef.current;
    if (!current.recovery) return false;
    commit({ ...current, retrying: true });
    return recover(current.recovery, current.recents);
  }, false), [commit, enqueue, recover]);

  const finish = useCallback(async (current: ActiveTripState, outcome: 'arrived' | 'ended-early', endedAt = Date.now()): Promise<boolean> => {
    const owner = ownerRef.current;
    const generation = generationRef.current;
    const id = activeSessionId(current);
    if (!current.uid || !id) return false;
    try {
      const completed = await completeNavigationSession(current.uid, id, outcome, endedAt);
      if (ownerRef.current !== owner || generationRef.current !== generation || stateRef.current.uid !== current.uid) return false;
      commit({
        uid: current.uid,
        status: 'idle',
        active: null,
        recovery: null,
        recoveryError: null,
        retrying: false,
        recents: completed.document.recents,
        pendingReplacement: null,
        locationState: null,
      });
      return true;
    } catch {
      return false;
    }
  }, [commit]);

  const end = useCallback(() => enqueue(async () => finish(stateRef.current, 'ended-early'), false), [enqueue, finish]);

  const advance = useCallback((fix: NavigationFix) => enqueue(async () => {
    const current = stateRef.current;
    const active = current.active;
    if (!current.uid || !active) return null;
    // Storage age is measured on the device clock. GPS timestamps can be a few milliseconds
    // ahead, and must not make a freshly written session look like future/corrupt data on read.
    const now = Date.now();
    const result = advanceNavigation(active.plan, active.cursor, fix, active.evidence, now);
    if (result.arrived) {
      return await finish(current, 'arrived', now) ? result : null;
    }
    const runtime = { ...active, cursor: result.cursor, evidence: result.evidence, updatedAt: result.advanced ? now : active.updatedAt };
    if (result.advanced) {
      try {
        let persisted = false;
        await updateNavigationDocument(current.uid, (stored) => {
          if (stored.active?.sessionId !== active.sessionId) return stored;
          // This hook serializes actions, and the runtime cursor is already monotonic. A fresh
          // itinerary can have different ordinals, so never compare its ordinal to a stored one.
          if (stored.active.updatedAt > active.updatedAt) return stored;
          persisted = true;
          return {
            ...stored,
            active: {
              ...stored.active,
              cursor: result.cursor,
              progressAnchor: progressAnchor(active.plan, result.cursor),
              updatedAt: now,
            },
          };
        }, now);
        if (!persisted || stateRef.current.uid !== current.uid) return null;
      } catch {
        return null;
      }
    }
    commit({ ...current, active: runtime, locationState: result.locationState });
    return result;
  }, null), [commit, enqueue, finish]);

  const resetForAdmin = useCallback(() => enqueue(async () => {
    const current = stateRef.current;
    const active = current.active;
    if (!current.uid || !active) return false;
    const at = Date.now();
    const result = resetNavigation(active.plan, at);
    try {
      const document = await updateNavigationDocument(current.uid, (stored): NavigationDocumentV1 => (
        stored.active?.sessionId === active.sessionId
          ? {
            ...stored,
            active: {
              ...stored.active,
              cursor: result.cursor,
              progressAnchor: progressAnchor(active.plan, result.cursor),
              updatedAt: at,
            },
          }
          : stored
      ), at);
      if (document.active?.sessionId !== active.sessionId || stateRef.current.uid !== current.uid) return false;
      commit({ ...current, active: { ...active, cursor: result.cursor, evidence: null, updatedAt: at }, locationState: 'current' });
      return true;
    } catch {
      return false;
    }
  }, false), [commit, enqueue]);

  const applyRecovery = useCallback((input: { sessionId: string; selectionFingerprint: string; stepIndex: number;
    phase: NavigationCursor['phase']; plan: TripRecoveryPlan; isCurrent?: () => boolean; beforePublish?: () => void }) => {
    const generation = generationRef.current;
    return enqueue(async () => {
      const current = stateRef.current;
      const previous = current.active;
      const isCurrent = () => generationRef.current === generation && stateRef.current.uid === current.uid
        && stateRef.current.active?.sessionId === input.sessionId
        && stateRef.current.active.selection.fingerprint === input.selectionFingerprint
        && stateRef.current.active.cursor.stepIndex === input.stepIndex
        && stateRef.current.active.cursor.phase === input.phase && input.isCurrent?.() !== false;
      if (!previous || !current.uid || current.pendingReplacement || !isCurrent()
        || !sameEndpoint(previous.destination, input.plan.resumeRequest.destination)) return false;
      try {
        const at = Date.now();
        const next = createActiveTripRuntime({ itinerary: input.plan.itinerary, origin: input.plan.origin, destination: previous.destination }, current.uid, at, previous.sessionId);
        const segment = next.plan.segments.find((item) => item.stepIndex === input.plan.prefixSteps);
        let checkpoint = segment ? next.plan.checkpoints[segment.startCheckpointOrdinal] : null;
        if (!input.plan.keepCursor && segment?.kind === 'walk' && input.plan.startPoint) {
          const anchor = next.plan.checkpoints.find((point) => point.ordinal >= segment.startCheckpointOrdinal
            && point.ordinal < segment.endCheckpointOrdinal && point.stepIndex === segment.stepIndex
            && distanceMeters(point.point, input.plan.startPoint!) <= 1);
          if (anchor) checkpoint = anchor;
          else if (checkpoint && distanceMeters(checkpoint.point, input.plan.startPoint) > 50) return false;
        }
        if (!checkpoint) return false;
        let cursor: NavigationCursor;
        if (input.plan.keepCursor) {
          const oldAnchor = previous.plan.checkpoints[previous.cursor.checkpointOrdinal];
          const retained = next.plan.checkpoints[previous.cursor.checkpointOrdinal];
          if (!oldAnchor || !retained || oldAnchor.kind !== retained.kind || oldAnchor.stepIndex !== retained.stepIndex
            || distanceMeters(oldAnchor.point, retained.point) > 1) return false;
          cursor = { ...previous.cursor };
        } else {
          cursor = { checkpointOrdinal: checkpoint.ordinal, stepIndex: checkpoint.stepIndex, phase: checkpoint.phase, lastAdvancedAt: at };
        }
        const runtime = { ...next, startedAt: previous.startedAt, cursor, evidence: null };
        const replacement = resumeRecord(runtime, input.plan.resumeRequest);
        let replaced = false;
        const document = await updateNavigationDocument(current.uid, (stored) => {
          if (!isCurrent() || stored.active?.sessionId !== previous.sessionId
            || stored.active.selection.fingerprint !== input.selectionFingerprint
            || stored.active.updatedAt > previous.updatedAt) return stored;
          replaced = true;
          return { ...stored, active: replacement };
        }, at);
        if (!replaced || !isCurrent() || document.active?.selection.fingerprint !== runtime.selection.fingerprint) return false;
        input.beforePublish?.();
        commit({ ...current, active: runtime, recents: document.recents, locationState: null });
        return true;
      } catch { return false; }
    }, false);
  }, [commit, enqueue]);

  // Never expose one account's previous render while the auth UID is switching.
  const visible = state.uid === normalizedUid ? state : initialState(normalizedUid);
  return {
    ...visible,
    start,
    confirmReplacement,
    cancelReplacement,
    retry,
    advance,
    end,
    resetForAdmin,
    applyRecovery,
  };
}
