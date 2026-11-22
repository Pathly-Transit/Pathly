import { transit_realtime } from 'gtfs-realtime-bindings';
import { logUpstreamRequest } from './upstreamUsage';

// One real GTFS-RT fetch already contains every route on that feed — getRouteStatus calls this
// once per *route* it's asked about, though, so polling N routes on the same agency in one
// client poll cycle would otherwise mean N identical fetches of the exact same feed. That's
// wasteful generally, and a real problem for rate-limited providers: Swiftly (NICE Bus/Suffolk
// County Transit) allows 180 requests/15min, which a handful of simultaneously-tracked routes
// (the demo catalog plus whatever's dynamically nearby) can exceed easily without this. Caching
// the in-flight *promise* (not just the resolved value) per feed URL, briefly, means every
// route asking for the same feed within one poll cycle shares a single real request — this
// benefits every agency, not just rate-limited ones, so it's not Swiftly-specific.
const FEED_CACHE_TTL_MS = 25_000; // spans successive 15-second client polls without serving data for long
const FEED_FAILURE_CACHE_TTL_MS = 10_000;
const FEED_TIMEOUT_MS = 15_000;
export const GTFS_SOURCE_MAX_AGE_MS = 90_000;
export const GTFS_FUTURE_TOLERANCE_MS = 30_000;

/** Retrieval time is deliberately separate from the agency's measurement time. */
export type RealtimeFeed = {
  entities: transit_realtime.FeedEntity[];
  fetchedAt: number;
  /** Epoch milliseconds; null when the producer omitted a valid header timestamp. */
  observedAt: number | null;
  /** Differential feeds need a stateful consumer; these endpoints only consume full snapshots. */
  differential: boolean;
};

export type SourceFreshness = {
  state: 'fresh' | 'stale' | 'unknown';
  observedAt: number | null;
  expiresAt: number | null;
};

/** protobuf uint64 values may be Long objects; zero/default values do not prove freshness. */
export function timestampMilliseconds(value: unknown): number | null {
  if (value == null) return null;
  const seconds = Number(String(value));
  return Number.isFinite(seconds) && seconds > 0 && Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : null;
}

/** A recent HTTP response cannot make an old feed or old trip measurement current. */
export function sourceFreshness(feedObservedAt: number | null, tripObservedAt: number | null, nowMs = Date.now()): SourceFreshness {
  const timestamps = [feedObservedAt, tripObservedAt].filter((value): value is number => value !== null && Number.isFinite(value));
  if (timestamps.length === 0 || timestamps.some((value) => value > nowMs + GTFS_FUTURE_TOLERANCE_MS)) {
    return { state: 'unknown', observedAt: null, expiresAt: null };
  }
  const observedAt = Math.min(...timestamps);
  const expiresAt = observedAt + GTFS_SOURCE_MAX_AGE_MS;
  return { state: expiresAt > nowMs ? 'fresh' : 'stale', observedAt, expiresAt };
}

const feedCache = new Map<string, { expiresAt: number; promise: Promise<RealtimeFeed> }>();

/**
 * Fetches and decodes one live GTFS-RT feed. No API key needed for any MTA feed (LIRR,
 * subway); Swiftly-hosted feeds (NICE Bus, Suffolk County Transit) need an `Authorization`
 * header, passed via `headers` rather than hand-building a request per agency.
 */
export function fetchRealtimeFeed(feedUrl: string, headers?: Record<string, string>): Promise<RealtimeFeed> {
  const cached = feedCache.get(feedUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = (async () => {
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(feedUrl, { headers, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
    } catch (error) {
      logUpstreamRequest(feedUrl, 'feed', startedAt, undefined, error);
      throw error;
    }
    logUpstreamRequest(feedUrl, 'feed', startedAt, response);
    // Without the query string: MTA Bus Time takes its API key there, and errors reach the logs.
    if (!response.ok) throw new Error(`GTFS-RT request to ${feedUrl.split('?')[0]} failed: ${response.status}`);
    const buffer = new Uint8Array(await response.arrayBuffer());
    const feed = transit_realtime.FeedMessage.decode(buffer);
    return {
      entities: feed.entity,
      fetchedAt: Date.now(),
      observedAt: timestampMilliseconds(feed.header.timestamp),
      differential: feed.header.incrementality === 1,
    };
  })();
  const entry = { expiresAt: Date.now() + FEED_CACHE_TTL_MS, promise };
  feedCache.set(feedUrl, entry);
  // Cache a provider failure briefly too. Otherwise a parallel route-poll burst would turn one
  // 429/503 into one upstream retry per route and make a quota outage worse. The identity check
  // prevents a slow, expired request from shortening a newer cache entry.
  void promise.catch(() => {
    if (feedCache.get(feedUrl)?.promise === promise) {
      entry.expiresAt = Date.now() + FEED_FAILURE_CACHE_TTL_MS;
    }
  });
  return promise;
}

/** Compatibility for existing route/alert consumers, sharing the exact same upstream cache. */
export async function fetchFeedEntities(feedUrl: string, headers?: Record<string, string>): Promise<transit_realtime.FeedEntity[]> {
  return (await fetchRealtimeFeed(feedUrl, headers)).entities;
}
