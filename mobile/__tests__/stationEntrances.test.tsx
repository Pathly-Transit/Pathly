import { act, fireEvent, render, within } from '@testing-library/react-native';
import mockSafeAreaContext from 'react-native-safe-area-context/jest/mock';

import { toTripDetailModel } from '../src/components/PlannedTripDetailView';
import { RouteDetailView } from '../src/components/RouteDetailView';
import { SharedTripDetailView } from '../src/components/SharedTripDetailView';
import { entranceCount, entranceInstruction, entranceLabel, entranceRows, legEntrances, nearestEntrance, parseEntrances, type StationEntrance } from '../src/data/stationEntrances';
import { routeById } from '../src/data/transit';
import { tripMapPoints } from '../src/data/tripMap';
import type { Itinerary, TransitStep, TripStep, WalkStep } from '../src/data/tripPlanning';
import { AppSettingsProvider } from '../src/theme/AppSettings';

jest.mock('react-native-safe-area-context', () => mockSafeAreaContext);

// Route View's geometry comes with each station's entrances; every other call answers empty.
const mockGeometry = jest.fn();
jest.mock('../src/lib/firebase', () => ({
  callable: (name: string) => () => Promise.resolve({ data: name === 'getRouteGeometry' ? mockGeometry() : name === 'getRouteTransfers' ? { transfers: {} } : { vehicles: [] } }),
}));

const stair = (lat: number, lon: number, corner?: StationEntrance['corner'], access: StationEntrance['access'] = 'both'): StationEntrance => ({ lat, lon, kind: 'stair', access, ...(corner ? { corner } : {}) });

// A station at 40.75, -73.99 with ways out to its north and south, the south one exit only.
const north = stair(40.7509, -73.99, 'N');
const south = stair(40.7491, -73.99, 'S', 'exit');
const elevator: StationEntrance = { lat: 40.7506, lon: -73.9892, kind: 'elevator', access: 'both', corner: 'NE' };

describe('naming an entrance', () => {
  it('says what it is, which side of the station, and whether it only goes one way', () => {
    expect(entranceLabel(elevator)).toBe('Elevator, NE corner');
    expect(entranceLabel(south)).toBe('Stair, south side (exit only)');
    expect(entranceLabel({ lat: 0, lon: 0, kind: 'entrance', access: 'entry' })).toBe('Entrance (entrance only)');
    expect(entranceCount([north])).toBe('1 entrance');
    expect(entranceCount([north, south, elevator])).toBe('3 entrances');
  });

  it('lists alike entrances together', () => {
    const northStair = stair(40.751, -73.99, 'N');
    expect(entranceRows([north, northStair, south, elevator])).toEqual(['2 stairs, north side', 'Stair, south side (exit only)', 'Elevator, NE corner']);
    const southExit = stair(40.749, -73.99, 'S', 'exit');
    expect(entranceRows([south, southExit])).toEqual(['2 stairs, south side (exit only)']);
  });

  it('tells the rider where to go in or out', () => {
    expect(entranceInstruction(elevator, 'enter')).toBe('Enter by the elevator at the NE corner');
    expect(entranceInstruction(south, 'exit')).toBe('Exit by the stair on the south side');
    // PATH's entrances say nothing but where they are.
    expect(entranceInstruction({ lat: 0, lon: 0, kind: 'entrance', access: 'both', corner: 'W' }, 'exit')).toBe('Exit on the west side');
    expect(entranceInstruction({ lat: 0, lon: 0, kind: 'entrance', access: 'both' }, 'enter')).toBe('Enter at the station entrance');
  });

  it('picks the nearest way open to that use', () => {
    const southOfStation = { lat: 40.748, lng: -73.99 };
    expect(nearestEntrance([north, south], southOfStation, 'exit')).toBe(south);
    // The south stair is exit only, so a rider coming from the south still goes in on the north side.
    expect(nearestEntrance([north, south], southOfStation, 'enter')).toBe(north);
    expect(nearestEntrance([north], undefined, 'enter')).toBeUndefined();
    expect(nearestEntrance(undefined, southOfStation, 'enter')).toBeUndefined();
  });

  it('keeps only well-formed entrances from a payload', () => {
    expect(parseEntrances([north, { lat: 1, lon: 2, kind: 'trapdoor', access: 'both' }, 'x'])).toEqual([north]);
    expect(parseEntrances([])).toBeUndefined();
    expect(parseEntrances(undefined)).toBeUndefined();
  });
});

const time = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 15, minutes)).toISOString();
const walkStep = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, distanceMeters: number, toName: string): WalkStep => ({ kind: 'walk', durationSeconds: distanceMeters, distanceMeters, toName, path: [from, to] });
const ride = (from: { lat: number; lng: number }, to: { lat: number; lng: number }, start: number, extra: Partial<TransitStep> = {}): TransitStep => ({
  kind: 'transit',
  mode: 'subway',
  agency: { name: 'MTA New York City Transit' },
  line: { name: 'E', shortName: 'E', color: '#0039A6' },
  from: { name: 'Board', location: from, time: time(start) },
  to: { name: 'Alight', location: to, time: time(start + 10) },
  stopCount: 3,
  durationSeconds: 600,
  path: [from, to],
  ...extra,
});

// Rider starts south of the boarding station and ends north of the alighting one.
const board = { lat: 40.75, lng: -73.99 };
const alight = { lat: 40.76, lng: -73.98 };
const alightNorth = stair(40.7609, -73.98, 'N');
const alightSouth = stair(40.7591, -73.98, 'S');
const steps: TripStep[] = [
  walkStep({ lat: 40.745, lng: -73.99 }, board, 600, 'Board'),
  ride(board, alight, 10, { boardEntrances: [north, south, elevator], alightEntrances: [alightNorth, alightSouth] }),
  walkStep(alight, { lat: 40.765, lng: -73.98 }, 500, 'Office'),
];

describe('a trip leg\'s way in and out', () => {
  it('enters nearest where the walk starts and exits nearest where the next walk goes', () => {
    // From the south, but the south stair is exit only: the elevator is the nearest way in.
    expect(legEntrances(steps, 1)).toEqual({ enter: elevator, exit: alightNorth });
  });

  it('is left out when the rider changes trains inside the station', () => {
    const transfer: TripStep[] = [
      ride(board, alight, 10, { alightEntrances: [alightNorth] }),
      walkStep(alight, { lat: 40.7601, lng: -73.98 }, 60, 'Transfer'),
      ride({ lat: 40.7601, lng: -73.98 }, { lat: 40.78, lng: -73.97 }, 25, { boardEntrances: [alightSouth] }),
    ];
    expect(legEntrances(transfer, 0)).toEqual({});
    expect(legEntrances(transfer, 2)).toEqual({});
  });

  it('is nothing for a bus', () => {
    expect(legEntrances([ride(board, alight, 10, { mode: 'bus' })], 0)).toEqual({});
  });

  it('shows in Trip Details under the boarding and alighting stops', () => {
    const itinerary: Itinerary = { id: 'e-train', departureTime: time(0), arrivalTime: time(30), durationSeconds: 1800, transfers: 0, steps };
    const model = toTripDetailModel(itinerary, 'Home', 'Office', false, '#2457C5');
    expect(model.legs[0]?.enter).toEqual({ text: 'Elevator, NE corner', point: { lat: elevator.lat, lng: elevator.lon }, minutes: expect.any(Number) });
    expect(model.legs[0]?.exit?.text).toBe('Stair, north side');

    const onFocusStop = jest.fn();
    const screen = render(
      <AppSettingsProvider>
        <SharedTripDetailView actionLabel="Start" backLabel="Back" isFavorite={false} map={<></>} model={model} onAction={jest.fn()} onBack={jest.fn()} onFocusStop={onFocusStop} onToggleFavorite={jest.fn()} rootTestID="search-trip" testPrefix="search-trip" />
      </AppSettingsProvider>,
    );
    expect(within(screen.getByTestId('search-trip-enter-0')).getByText('Elevator, NE corner')).toBeTruthy();
    fireEvent.press(screen.getByTestId('search-trip-exit-0'));
    expect(onFocusStop).toHaveBeenCalledWith(expect.objectContaining({ point: { lat: alightNorth.lat, lng: alightNorth.lon } }));
  });

  it('marks the stations\' served entrances on the trip map', () => {
    const itinerary: Itinerary = { id: 'e-train', departureTime: time(0), arrivalTime: time(30), durationSeconds: 1800, transfers: 0, steps };
    const marked = tripMapPoints(itinerary).stops.filter((stop) => stop.kind === 'entrance');
    expect(marked.map((stop) => stop.label)).toEqual(['Stair, north side', 'Stair, south side (exit only)', 'Elevator, NE corner', 'Stair, north side', 'Stair, south side']);
  });
});

describe('Route View stop list', () => {
  it('shows no entrances or exits, even for a station that has them', async () => {
    mockGeometry.mockReturnValue({
      headsign: 'Jamaica Center',
      stops: [
        { stopId: 'A1', name: 'World Trade Center', lat: 40.75, lon: -73.99, offsetMinutes: 0, entrances: [north, south] },
        { stopId: 'A2', name: 'Canal St', lat: 40.76, lon: -73.98, offsetMinutes: 3 },
      ],
    });
    const screen = render(
      <AppSettingsProvider>
        <RouteDetailView isFavorite={false} onBack={jest.fn()} onToggleFavorite={jest.fn()} route={routeById.e} wholeRoute={true} />
      </AppSettingsProvider>,
    );
    await act(async () => {});
    await screen.findByTestId('stop-row-0');
    expect(screen.queryByTestId('stop-entrances-toggle-0')).toBeNull();
    expect(screen.queryByText('2 entrances')).toBeNull();
  });
});
