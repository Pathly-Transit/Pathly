# Tasks

## 1. Metro-North agency data

- [x] 1.1 Confirm Metro-North static GTFS and GTFS-Realtime endpoints, format, authentication, route ids, and agency identifiers against MTA Developer Resources; record the verified sources and configure a unique `metronorth` agency, with backend agency configuration checks passing.
- [x] 1.2 Add Metro-North static feed refresh, snapshot limits/fallback expectations, and prepared route indexes; verify the feed validates and route/stop discovery returns Metro-North data.
- [x] 1.3 Integrate Metro-North real-time trip updates and vehicle positions, including agency-specific route resolution and service alerts when available; verify live status matches a sample scheduled route and unavailable realtime falls back to schedule.
- [x] 1.4 Extend agency matching, nearby ranking, route geometry, transfer discovery, and station search for `metronorth`; verify representative stations, routes, transfers, and direction geometry resolve correctly.
- [x] 1.5 Add backend regression coverage and update backend operating documentation for Metro-North sources, refresh, live-data fallback, and secrets; verify the backend's focused test and documentation checks pass.

## 2. Search, map, and route presentation

- [x] 2.1 Add the `metronorth` agency to mobile transit types and shared rail identity/color/badge handling without changing the existing Manhattan bus `mn` behavior; verify Metro-North and Manhattan bus IDs render as distinct agencies.
- [x] 2.2 Extend the shared service-area bounds and corresponding backend validation to include Metro-North destinations, keeping mobile and backend bounds aligned; verify Metro-North endpoints pass while unrelated out-of-area endpoints remain rejected.
- [x] 2.3 Integrate Metro-North stations and routes into transit stop search, Google station matching, recents, and station subtitle labels; verify a Metro-North station search shows its served route badges and opens trip planning.
- [x] 2.4 Add Metro-North to the map's line-layer selector and shared route detail flow; verify a selected line draws its geometry and route details show station sequence, departures, and live/fallback state.
- [x] 2.5 Add mobile regression coverage for Metro-North search, route badges, route detail, map geometry, and service-area behavior; verify existing bus and LIRR search/detail behavior remains unchanged.

## 3. Trip planning and coverage

- [x] 3.1 Map Metro-North itinerary agencies and train vehicle types to the Metro-North rail identity and shared commuter-rail filter; verify itineraries show the correct route badge and are excluded when Commuter rail is disabled.
- [x] 3.2 Match Metro-North itinerary legs to the agency timetable and handle fare output using routing-service fares or the unavailable state; verify intermediate stops are shown only for a matching scheduled trip and no fare is invented.
- [x] 3.3 Update trip-planning regression coverage for a Metro-North-only destination beyond the former bounds and for an unrelated destination outside the expanded service area; verify the former can produce results and the latter remains blocked.
- [x] 3.4 Run the relevant backend and mobile regression suites and resolve integration failures across agency discovery, route display, search, live data, and trip planning.
