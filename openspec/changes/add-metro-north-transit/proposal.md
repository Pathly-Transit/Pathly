# Proposal

## Why

Pathly currently covers the LIRR but not Metro-North, leaving riders without Metro-North schedules, live status, searchable stations, or route details. Destinations reachable through Metro-North can also be rejected by the app's service-area check even when they are within the system's practical coverage.

## What Changes

- Add Metro-North as a first-class transit agency using the existing GTFS schedule, real-time, route detail, nearby search, and stop search flows.
- Make Metro-North stations and lines discoverable in search, show them in the shared route detail experience, and include their service in transit planning.
- Expand transit endpoint coverage so destinations served by Metro-North can be planned without being rejected as outside Pathly's coverage.
- Add Metro-North-aware route badges, agency identification, and fare behavior consistent with the data available for that agency; keep the Metro-North agency identifier distinct from the existing `mn` Manhattan bus feed.

## Capabilities

### New Capabilities

- `metro-north-transit`: Metro-North agency data and its integration into line discovery, station search, live departures, route detail, and trip planning.

### Modified Capabilities

- `destination-search`: Search results must include Metro-North stations and their lines, and the supported search area must include Metro-North-served destinations.
- `mobile-prototype-navigation`: Metro-North routes must participate in transit features and trip planning, including route detail and endpoint coverage validation.

## Impact

- Backend agency configuration, GTFS refresh and derived indexes, real-time status, route geometry, trip planning, agency matching, fares, and service-area validation.
- Mobile transit types, badges/colors, line search, station labels, nearby and route detail, transfer presentation, trip mode filters, and map geometry.
- External data dependencies: Metro-North static GTFS and GTFS-Realtime feeds, and Google Routes API coverage for Metro-North itineraries. API credentials remain backend-managed where required.
- Existing agency behavior and persisted trip data must remain compatible.
