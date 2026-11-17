# Spec Delta

## Purpose

Defines Metro-North as a supported Pathly transit agency so its schedules, live service, lines, and stations work throughout the same rider-facing features as other supported agencies.

## ADDED Requirements

### Requirement: Metro-North routes are fully integrated
The app SHALL load Metro-North's official static transit schedule data and use it for route discovery, nearby service, departures, stop search, route geometry, station transfers, and timetable matching in planned trips. Metro-North routes and stations SHALL be identified as Metro-North and use the rail presentation, including line badges and map geometry. Routes SHALL be viewable in the shared route detail experience, with their directions, stops, schedule, and live information when available.

#### Scenario: Rider searches for a Metro-North station
- **WHEN** the rider searches a Metro-North station name
- **THEN** the station appears as a train station with the Metro-North routes serving it, and selecting it opens trip results for that station

#### Scenario: Rider opens a Metro-North line
- **WHEN** the rider selects a Metro-North route from search or nearby results
- **THEN** the shared route detail shows that route's identity, color, directions, station sequence, map line, scheduled departures, and live information when available

#### Scenario: Live feed is unavailable
- **WHEN** Metro-North's real-time feed is missing or unavailable
- **THEN** its routes remain searchable and viewable and show scheduled departures as untracked without failing the route detail

#### Scenario: Trip leg matches the Metro-North timetable
- **WHEN** a planned Metro-North leg matches one scheduled trip serving its boarding and alighting stations at the applicable departure time
- **THEN** the leg's intermediate stations and scheduled times come from that timetable trip

### Requirement: Metro-North is available as a trip mode
Route Results SHALL identify Metro-North legs as commuter rail, display the Metro-North line identity and badge, and include them when commuter rail is enabled in travel modes. The app SHALL use a fare returned by the routing service when available; if it must compute a fare and has no published Metro-North fare data for the leg, it SHALL report the fare as unavailable rather than infer a price.

#### Scenario: Itinerary uses Metro-North
- **WHEN** the routing service returns an itinerary using a Metro-North train
- **THEN** Route Results shows a Metro-North rail leg with its line, boarding and alighting stations, times, and route badge

#### Scenario: Metro-North is disabled
- **WHEN** the rider excludes commuter rail in travel modes
- **THEN** itineraries containing Metro-North legs are excluded along with other commuter-rail itineraries

#### Scenario: Metro-North fare is not known
- **WHEN** a Metro-North itinerary has no routing-service fare and the app has no published fare for that journey
- **THEN** the itinerary shows that its fare is unavailable
