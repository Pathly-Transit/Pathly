# Spec Delta

## MODIFIED Requirements

### Requirement: Route Results supports editable trip criteria
Route Results SHALL display separate origin and destination fields that can be changed at any time. Each field SHALL be a control that, when activated, opens the destination search page for that endpoint. That page SHALL behave exactly like the original destination search: Google Places autocomplete limited to the service area, the same loading, empty, error, and unconfigured states, and session recent searches. When editing the origin, a "Current location" option SHALL appear first. Choosing a place SHALL set that endpoint and return to Route Results with the other endpoint and every other trip criterion unchanged; cancelling SHALL return to Route Results with nothing changed. The fields SHALL NOT accept typed text directly. The swap control SHALL exchange the two endpoints. Any change to an endpoint SHALL plan the trip again.

Route Results SHALL also display a leave-time control, a refresh control, a Modes control, and a Filter control.

- **Leave time:**
  - The control SHALL open a time picker offering Leave now, Depart at, and Arrive by, with scrollable hour, minute (5-minute increments), and AM/PM selections.
  - Depart at and Arrive by SHALL mean the next occurrence of the chosen clock time: today if it is still ahead, otherwise tomorrow, which the control SHALL then indicate.
  - After the rider confirms, the control SHALL display the chosen mode and time, and trips SHALL be planned again for that time.
  - With Depart at, no itinerary SHALL depart before the chosen time. With Arrive by, no itinerary SHALL arrive after it.
- **Filter:**
  - Filter SHALL offer selectable Fastest, Fewer transfers, and Lowest fare preferences.
  - Fastest SHALL order itineraries by earliest arrival.
  - Fewer transfers SHALL plan the trip again with a preference for fewer transfers, and order the results by transfer count, then by arrival.
  - Lowest fare SHALL order itineraries by their fare, with itineraries whose fare is unavailable listed last.
- **Modes:**
  - The Modes control SHALL let the rider include or exclude Subway, Bus, Ferry, and Commuter rail. The commuter-rail option SHALL include both LIRR and Metro-North service.
  - The exclusions SHALL be passed to the routing service as a preference.
  - The app SHALL also hide any itinerary that still uses an excluded mode.
- **Refresh:**
  - Refresh SHALL preserve the current trip criteria and plan the trip again.
  - An "Updated" label SHALL show how long ago the shown results were planned.

#### Scenario: Rider filters by mode
- **WHEN** the rider excludes Commuter rail in Modes
- **THEN** the trip is planned again preferring the remaining modes, any itinerary containing an LIRR or Metro-North leg is hidden, and if none remain an empty state with a reset action is shown

#### Scenario: Rider changes an endpoint
- **WHEN** the rider taps the destination field, types "stony", and picks Stony Brook University from the autocomplete suggestions
- **THEN** Route Results shows Stony Brook University as the destination, with the origin, leave time, modes, and filter unchanged, and real itineraries to Stony Brook University load

#### Scenario: Rider changes the origin back to their location
- **WHEN** the rider taps the origin field and chooses "Current location"
- **THEN** Route Results shows "Current location" as the origin and plans from the rider's position

#### Scenario: Rider cancels editing an endpoint
- **WHEN** the rider taps an endpoint field and then cancels the search
- **THEN** Route Results returns with both endpoints, every trip criterion, and the shown itineraries unchanged

#### Scenario: Rider changes route preference
- **WHEN** the rider selects Fastest, Fewer transfers, or Lowest fare from Filter
- **THEN** that preference is visibly selected and the itineraries are ordered by that preference, with Fewer transfers also planning the trip again

#### Scenario: Rider picks a departure time
- **WHEN** the rider opens the leave-time control, chooses Depart at 10:30 AM at 9:00 AM, and confirms
- **THEN** the control reads "Depart 10:30 AM" and every itinerary departs at or after 10:30 AM today

#### Scenario: Rider picks a time that has already passed today
- **WHEN** at 11:00 PM the rider chooses Depart at 7:00 AM and confirms
- **THEN** the control indicates tomorrow and the itineraries depart at or after 7:00 AM tomorrow

#### Scenario: Rider picks an arrival deadline
- **WHEN** the rider chooses Arrive by 12:00 PM and confirms
- **THEN** the control reads "Arrive by 12:00 PM" and every itinerary arrives at or before 12:00 PM

#### Scenario: Rider cancels the picker
- **WHEN** the rider dismisses the time picker without confirming
- **THEN** the previous leave-time choice and the shown itineraries are unchanged

#### Scenario: Chosen time carries into trip details
- **WHEN** the rider opens an itinerary after choosing a time
- **THEN** the planned trip detail's leave and arrive times match that itinerary's card

#### Scenario: Rider changes departure time or refreshes
- **WHEN** the rider confirms a new leave time or uses the refresh control
- **THEN** the trip is planned again, keeping the current origin, destination, mode filter, and preference (and the new time choice), and the "Updated" label shows when the new results were planned

### Requirement: Real transit trip planning
Route Results SHALL show real public-transit itineraries between the chosen origin and destination, computed by a routing service that knows the region's transit schedules (subway, bus, commuter rail including LIRR and Metro-North, ferry, and walking between them). A single search SHALL offer several alternatives when the routing service has them, typically up to four. Each itinerary SHALL describe its ordered steps:
- walking steps, with duration and distance;
- transit steps, with the operating agency, the line's name, short name, and color, the vehicle type, the headsign, the boarding and alighting stops with their scheduled times, and the number of stops ridden. When the step matches a scheduled trip in the app's own timetables, it SHALL also list the stops in between, in order, with each stop's name, location, and scheduled time. A step SHALL be matched only when one scheduled trip of a line serving both stops leaves the boarding stop within 2 minutes of the routing service's departure time and reaches the alighting stop after it; otherwise it SHALL carry no intermediate stops rather than a guessed list.

Each itinerary SHALL also give its total duration, its departure and arrival times, its number of transfers, and a fare:
- the routing service's own fare, when it has one for every step;
- otherwise, the fare the app computes from the agencies' published fares: the NYC subway and local bus, NICE, and Suffolk County Transit flat fares with their transfer rules, and the LIRR's zone-to-zone peak and off-peak fares. A computed fare SHALL be the full adult one-way fare and SHALL be shown like the routing service's fares, not marked as approximate;
- when any step's agency, LIRR station, or Metro-North journey has no published fare the app knows, the itinerary SHALL say the fare is unavailable rather than show an invented number.

When the origin is "Current location", the rider's current position SHALL be used. When that position is unknown, Route Results SHALL ask the rider to choose an origin instead of planning from a guessed location.

Requests SHALL go through the app's backend, so routing credentials never ship in the app. Requests SHALL be limited to signed-in riders, rate-limited per rider, and restricted to endpoints within the app's service area, including Metro-North-served destinations.

#### Scenario: Rider plans a real trip
- **WHEN** the rider at Stony Brook University chooses Penn Station as the destination with "Leave now"
- **THEN** Route Results lists real itineraries, such as LIRR via Ronkonkoma or Port Jefferson Branch trains, with real departure and arrival times after now, and each card's steps match the trip the routing service returned

#### Scenario: Rider plans to a Metro-North destination
- **WHEN** the rider plans a trip to a destination served by Metro-North that is north or east of the previous service-area bounds
- **THEN** the endpoint is accepted and Route Results can show itineraries using Metro-North when the routing service returns them

#### Scenario: Several ways to go
- **WHEN** the routing service returns a primary itinerary and three alternatives
- **THEN** all four appear as separate cards, with no duplicates

#### Scenario: Fare computed from published fares
- **WHEN** the routing service gives no fare for an itinerary that rides Suffolk bus 51 and then the LIRR from Ronkonkoma to Penn Station off-peak
- **THEN** the card shows the Suffolk fare plus the LIRR off-peak fare for those two stations' zones, with no "~" or estimate marker

#### Scenario: Fare is unknown for a step
- **WHEN** an itinerary uses an agency the app has no published fare for
- **THEN** that card shows that the fare is unavailable instead of a number

#### Scenario: Location unknown for a "Current location" origin
- **WHEN** the origin is "Current location" and the rider's location is unavailable
- **THEN** Route Results asks the rider to choose a starting point and does not request trips

#### Scenario: Endpoint outside the service area
- **WHEN** an endpoint lies outside the service area and is not a Metro-North-served destination
- **THEN** no trips are requested and Route Results explains that the trip is outside the area Pathly covers

#### Scenario: Stops in between come from the timetable
- **WHEN** a planned trip rides the LIRR Port Jefferson Branch from Stony Brook to Huntington, and the timetable has that departure
- **THEN** the transit step lists the stops between Stony Brook and Huntington with their scheduled times, and their number matches the step's stop count

#### Scenario: A leg with no timetable match
- **WHEN** a transit step is on an agency whose timetable the app doesn't have, or no scheduled trip fits its departure time
- **THEN** the step carries its stop count and no intermediate stops
