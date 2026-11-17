# Spec Delta

## MODIFIED Requirements

### Requirement: Suggestions stay within the service area
Suggestion requests SHALL be restricted to the Pathly service area, as defined by the same service-area bounds the map uses. The service area SHALL include New York City, Nassau County, Suffolk County, and destinations served by Metro-North. Places outside the service area SHALL NOT be suggested, even when they match the query more closely.

#### Scenario: Ambiguous street name
- **WHEN** the rider searches for an address that also exists in other states
- **THEN** only matches within the service area are suggested

#### Scenario: Metro-North destination
- **WHEN** the rider searches for a destination served by Metro-North outside the current NYC, Nassau, and Suffolk bounds
- **THEN** the destination can be suggested and selected for trip planning

#### Scenario: Destination outside the service area
- **WHEN** the rider searches for a place that exists only outside the service area and is not served by Metro-North
- **THEN** that place is not suggested and the "No places found" state is shown if nothing else matches

## ADDED Requirements

### Requirement: Metro-North station suggestions show their lines
Transit-stop search SHALL include Metro-North stations. Each Metro-North station suggestion SHALL use the train icon, identify itself as a Metro-North station, and show the Metro-North route badges serving it. A matching Google station suggestion SHALL also show those route badges using the existing transit-stop matching behavior.

#### Scenario: Rider searches for a Metro-North station
- **WHEN** the rider types a Metro-North station name
- **THEN** matching Metro-North station suggestions appear with Metro-North line badges and selecting one opens trip planning to that station
