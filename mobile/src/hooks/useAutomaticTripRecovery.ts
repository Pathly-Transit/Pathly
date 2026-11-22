import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { distanceMeters, type ActiveTripRuntime, type NavigationFix } from '../data/enrouteNavigation';
import { readNavigationDocument } from '../data/navigationStorage';
import { findTripRecovery, recoveryReason, type TripRecoveryPlan } from '../data/tripRecovery';
import { projectTripTiming } from '../data/tripTiming';
import type { TripLiveResponse } from '../data/tripLiveTypes';
import type { ActiveTripCoordinator } from './useActiveTrip';
import { useAppActive } from './useAppActive';

const RECOVERY_RETRY_MS = 30_000;

function onboardAnchor(active: ActiveTripRuntime, statuses: TripLiveResponse | null, now: number): number | null {
  if (active.cursor.phase !== 'riding') return null;
  const step = active.itinerary.steps[active.cursor.stepIndex];
  if (step?.kind !== 'transit') return null;
  const observation = projectTripTiming(active.itinerary, statuses, now, { cursor: active.cursor }).legs
    .find((leg) => leg.stepIndex === active.cursor.stepIndex)?.observation;
  const predicted = observation?.state === 'fresh' && observation.arrives && !observation.arrivalNoData ? Date.parse(observation.arrives) : 0;
  return Math.max(Date.parse(step.to.time), predicted);
}

function currentFix(fix: NavigationFix | null, now: number): fix is NavigationFix {
  return Boolean(fix && fix.source === 'real' && typeof fix.accuracyMeters === 'number' && fix.accuracyMeters >= 0 && fix.accuracyMeters <= 50
    && Number.isFinite(fix.capturedAt) && fix.capturedAt <= now + 5000 && now - fix.capturedAt <= 30_000
    && Number.isFinite(fix.point.lat) && Math.abs(fix.point.lat) <= 90 && Number.isFinite(fix.point.lng) && Math.abs(fix.point.lng) <= 180);
}

/** Recovery is an automatic, bounded operation. No toast, modal or route acceptance path. */
export function useAutomaticTripRecovery(active: ActiveTripRuntime | null, statuses: TripLiveResponse | null,
  fix: NavigationFix | null, apply: ActiveTripCoordinator['applyRecovery']) {
  const foreground = useAppActive();
  const activeExists = active !== null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!activeExists || !foreground) return undefined;
    const timer = setInterval(() => tick((value) => value + 1), 5_000);
    return () => clearInterval(timer);
  }, [activeExists, foreground]);
  const priorFix = useRef<NavigationFix | null>(null);
  const latestFix = useRef<NavigationFix | null>(null);
  const history = useRef<NavigationFix[]>([]);
  const latest = useRef({ active, statuses, fix, foreground });
  const epoch = useRef(0);
  const working = useRef<{ owner: string; generation: number } | null>(null);
  const lastAttempt = useRef<{ owner: string; reason: string; at: number } | null>(null);
  const ownerKey = active ? JSON.stringify([active.uid, active.sessionId, active.selection.fingerprint]) : null;
  useLayoutEffect(() => {
    epoch.current += 1;
    working.current = null;
    lastAttempt.current = null;
    priorFix.current = null; latestFix.current = null; history.current = [];
    return () => { epoch.current += 1; };
  }, [ownerKey]);
  useLayoutEffect(() => {
    latest.current = { active, statuses, fix, foreground };
    if (fix && fix.capturedAt !== latestFix.current?.capturedAt) {
      history.current = [...history.current, fix].filter((item) => item.capturedAt >= fix.capturedAt - 60_000).slice(-24);
      priorFix.current = history.current.find((item) => fix.capturedAt - item.capturedAt >= 10_000) ?? null;
      latestFix.current = fix;
    }
  }, [active, statuses, fix, foreground]);
  useEffect(() => {
    if (!active || !ownerKey || !foreground || working.current) return;
    const now = Date.now();
    const reason = recoveryReason(active, statuses, fix, now, priorFix.current);
    if (!reason || (lastAttempt.current?.owner === ownerKey && now - lastAttempt.current.at < RECOVERY_RETRY_MS)) return;
    const generation = epoch.current;
    const token = { owner: ownerKey, generation };
    const anchor = onboardAnchor(active, statuses, now);
    let prepared: TripRecoveryPlan | null = null;
    const isCurrent = () => {
      const current = latest.current;
      if (working.current !== token || epoch.current !== generation || !current.foreground || !current.active || current.active.uid !== active.uid
        || current.active.sessionId !== active.sessionId || current.active.selection.fingerprint !== active.selection.fingerprint
        || current.active.cursor.stepIndex !== active.cursor.stepIndex || current.active.cursor.phase !== active.cursor.phase) return false;
      // A later alighting forecast changes the onward planning boundary, even when the reason is unchanged.
      if (anchor !== onboardAnchor(current.active, current.statuses, Date.now())) return false;
      if (prepared && !prepared.keepCursor) {
        if (!prepared.startPoint || !currentFix(current.fix, Date.now())
          || distanceMeters(current.fix.point, prepared.startPoint) > 75) return false;
      }
      // Slow planning must not act on old GPS or an observation that has since expired/recovered.
      return recoveryReason(current.active, current.statuses, current.fix, Date.now(), priorFix.current)?.key === reason.key;
    };
    working.current = token;
    lastAttempt.current = { owner: ownerKey, reason: reason.key, at: now };
    void (async () => {
      const document = await readNavigationDocument(active.uid);
      if (!isCurrent() || document.active?.sessionId !== active.sessionId) return;
      const plan = await findTripRecovery(active, document.active.request, fix, reason, statuses, { isCurrent });
      prepared = plan;
      if (!plan || !isCurrent()) return;
      await apply({ sessionId: active.sessionId, selectionFingerprint: active.selection.fingerprint,
        stepIndex: active.cursor.stepIndex, phase: active.cursor.phase, plan, isCurrent });
    })().catch(() => undefined).finally(() => { if (working.current === token) working.current = null; });
  });
}
