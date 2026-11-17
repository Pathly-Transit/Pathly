# Design

## Context

See proposal.md for the motivation and specs for rider-visible behavior. Pathly routes agency data through shared GTFS discovery, schedule, geometry, and real-time functions configured in `gtfsAgencies.ts`. The code comment there describes Metro-North as a future agency intended to use this common path. The mobile agency id `mn` is already assigned to Manhattan buses, so Metro-North needs its own stable id. Search and trip planning currently share a NYC, Nassau, and Suffolk bounding rectangle, and rail-specific styling and fare matching include LIRR-specific branches.

## Goals / Non-Goals

**Goals:**
- Reuse the existing agency pipeline for Metro-North static GTFS, prepared data, route discovery, station search, real-time status, and route geometry.
- Make Metro-North station and route identity survive the existing backend-to-mobile trip and route models.
- Extend endpoint coverage to Metro-North destinations and keep search restrictions and trip-planning validation consistent.
- Keep Metro-North as commuter rail in trip filtering while presenting it distinctly from LIRR.

**Non-Goals:**
- Adding other regional railroads or changing the service provided by existing agencies.
- Inventing Metro-North fare estimates when no authoritative fare mapping is available.
- Replacing Google Routes API or changing its authentication model.

## Decisions

1. **Add a dedicated agency identifier, `metronorth`.** This avoids collision with `mn`, the Manhattan bus feed, and keeps identifiers consistent across backend `AgencyId`, mobile `LiveSource`, caches, and saved route references. A generic `rail` id was considered, but it would conflate separately operated systems and their feed ownership.

2. **Use the existing GTFS agency lifecycle.** Configure the official Metro-North static schedule feed and MTA GTFS-Realtime source through the existing refresh, validation, snapshot, and route-index pipeline. Reuse generic discovery, timetable, route geometry, nearby, and realtime logic, extending agency-specific mappings only where feed semantics require it. MTA lists Metro-North schedule and real-time data through its [Developer Resources](https://api.mta.info/). Confirm feed URLs, formats, and any authentication requirements against the current MTA feed catalog before implementation.

3. **Treat Metro-North as the same commuter-rail filter category as LIRR.** Preserve agency identity in badges and itinerary steps, but use the shared commuter-rail inclusion/exclusion behavior. A separate Metro-North-only toggle was considered; the current app groups service by travel mode, so a second rail toggle would change that interaction model.

4. **Extend the shared geographic coverage bounds consistently.** Update mobile search/map coverage and backend endpoint validation to include Metro-North-served destinations, rather than adding an exception in only one screen. Keep these bounds distinct from map-exploration bounds. The box remains an approximation of geographic coverage, consistent with the current implementation.

5. **Use routing-service fares when returned; otherwise require explicit Metro-North fare data.** Do not map Metro-North stations to LIRR fare zones or infer a price. If no maintained Metro-North fare table is added, the existing unavailable-fare behavior is the safe fallback.

6. **Extend shared rail presentation instead of adding a parallel route-detail screen.** Add Metro-North to line-layer grouping, station labels, route badges/colors, transfer identification, and route agency matching while preserving each system's agency identity. Generic rail rendering remains shared.

## Risks / Trade-offs

- [Feed schema or identifier behavior differs from LIRR] → Validate actual static and realtime feed samples and add explicit normalization only where required; preserve timetable fallback if live parsing fails.
- [A rectangular coverage expansion can include places not served by Metro-North] → Keep the expanded bounds narrowly aligned to the system's station envelope and add regression scenarios for both Metro-North destinations and unrelated out-of-area places.
- [Persisted route references or caches could collide with Manhattan buses if ids are reused] → Use `metronorth` end-to-end and add compatibility coverage for existing `mn` bus data.
- [Google Routes API may return Metro-North under a different agency/vehicle label or omit fares] → Verify representative itinerary payloads and map agency/mode based on observed provider output; retain unavailable-fare behavior absent verified data.
- [Metro-North feed availability/authentication may change] → Resolve the current authoritative feed URLs and credentials during implementation, keep secrets server-side, and retain static schedule service if realtime is unavailable.

## Migration Plan

Deploy the backend with Metro-North feed configuration and generated route indexes, then deploy the mobile client that recognizes the new agency id and expanded coverage. The agency is additive; existing agency identifiers and stored route references remain unchanged. If Metro-North publication or routing integration needs rollback, remove the new agency from discovery and revert the coverage expansion while keeping existing agency data intact.
