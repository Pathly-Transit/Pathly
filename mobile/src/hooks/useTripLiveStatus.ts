import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseTripRunRef, sameTripRunRef } from '../data/tripRunRef';
import { tripLiveRequests } from '../data/tripTiming';
import type { Itinerary } from '../data/tripPlanning';
import type { TripLegObservation, TripLiveRequest, TripLiveResponse } from '../data/tripLiveTypes';
import { auth, callable } from '../lib/firebase';
import { useAppActive } from './useAppActive';

export const TRIP_STATUS_POLL_MS = 30_000;
const loadStatus = callable<TripLiveRequest, TripLiveResponse>('getTripLiveStatus');

/** Accept only observations for this exact request; retrieval time never renews source age. */
export function matchedTripStatus(value: unknown, request: TripLiveRequest): TripLiveResponse | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as TripLiveResponse;
  if (data.version !== 1 || !Number.isFinite(data.fetchedAt) || !Array.isArray(data.legs) || data.legs.length > 12) return null;
  const counts = new Map<string, number>();
  for (const leg of data.legs) if (leg && typeof leg.legKey === 'string') counts.set(leg.legKey, (counts.get(leg.legKey) ?? 0) + 1);
  const legs: TripLegObservation[] = [];
  for (const leg of data.legs) {
    const selected = request.legs.find((item) => item.legKey === leg?.legKey);
    if (!selected || counts.get(leg.legKey) !== 1 || !parseTripRunRef(leg.runRef) || !sameTripRunRef(selected.runRef, leg.runRef)
      || !['fresh', 'stale', 'unknown'].includes(leg.state)
      || !['predicted', 'cancelled', 'skips-stop', 'no-data', 'unavailable'].includes(leg.status)
      || (leg.observedAt !== null && !Number.isFinite(leg.observedAt))
      || (leg.expiresAt !== null && !Number.isFinite(leg.expiresAt))
      || (leg.departs !== undefined && !Number.isFinite(Date.parse(leg.departs)))
      || (leg.arrives !== undefined && !Number.isFinite(Date.parse(leg.arrives)))) continue;
    legs.push(leg);
  }
  return { version: 1, fetchedAt: data.fetchedAt, legs };
}

/** One bounded selected-run read per tick, independent from search and routine GPS fixes. */
export function useTripLiveStatus({ uid, sessionId, itinerary, enabled = true }: {
  uid: string | null | undefined;
  sessionId?: string | null;
  itinerary: Itinerary | null | undefined;
  enabled?: boolean;
}) {
  const appActive = useAppActive();
  const [now, setNow] = useState(() => Date.now());
  const legs = useMemo(() => itinerary ? tripLiveRequests(itinerary).slice(0, 12) : [], [itinerary]);
  const key = JSON.stringify([uid ?? null, sessionId ?? itinerary?.id ?? null, legs]);
  useEffect(() => {
    if (!enabled || !uid || !appActive || legs.length === 0) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [enabled, uid, appActive, legs.length]);
  const [loaded, setLoaded] = useState<{ key: string; data: TripLiveResponse | null; refreshing: boolean } | null>(null);
  const inFlight = useRef<{ key: string; promise: Promise<TripLiveResponse | null> } | null>(null);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled || !uid || !appActive || legs.length === 0) return undefined;
    let cancelled = false;
    let working = false;
    const request: TripLiveRequest = { version: 1, legs };
    const isCurrent = () => !cancelled && auth.currentUser?.uid === uid;
    const refresh = async () => {
      if (working || !isCurrent()) return;
      // Age the previous source as soon as foreground refresh starts, even if the RPC is slow.
      setNow(Date.now());
      working = true;
      setLoaded((previous) => ({ key, data: previous?.key === key ? previous.data : null, refreshing: true }));
      try {
        // Resume can share an identical request still pending when the app was backgrounded.
        if (inFlight.current?.key !== key) {
          const pending = { key, promise: loadStatus(request).then(({ data }) => matchedTripStatus(data, request)) };
          inFlight.current = pending;
          void pending.promise.finally(() => { if (inFlight.current === pending) inFlight.current = null; }).catch(() => undefined);
        }
        const data = await inFlight.current!.promise;
        if (isCurrent()) setLoaded((previous) => ({ key, data: data ?? (previous?.key === key ? previous.data : null), refreshing: false }));
      } catch {
        if (isCurrent()) setLoaded((previous) => ({ key, data: previous?.key === key ? previous.data : null, refreshing: false }));
      } finally { working = false; }
    };
    refreshRef.current = refresh;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, TRIP_STATUS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); if (refreshRef.current === refresh) refreshRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key covers selected run references and owner; GPS is deliberately excluded
  }, [key, enabled, appActive]);

  const refresh = useCallback(() => { void refreshRef.current?.(); }, []);
  return { statuses: loaded?.key === key ? loaded.data : null, refreshing: loaded?.key === key && loaded.refreshing, now, refresh };
}
