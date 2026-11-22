import { approachingVehicle, bearingDegrees, directionArrowAt, MIN_FIT_SPAN, snapStopsToPath, splitPathAtStop, streetWalkToDraw, walkConnectors, withAlpha, withMinimumFitSpan } from '../src/data/routeDirection';

// A straight east-west line along 40.9°N: 21 points about 84 m apart.
const line = Array.from({ length: 21 }, (_, index) => ({ lat: 40.9, lon: -73.2 + index * 0.001 }));
const stops = [line[0]!, line[10]!, line[20]!];

describe('route direction helpers', () => {
  it('puts the direction arrow on a straight stretch, pointing the way the line runs', () => {
    // East for 84 m, then a sharp turn north for 1 km: the arrow belongs on the long straight.
    const bend = [
      ...Array.from({ length: 2 }, (_, index) => ({ lat: 40.9, lon: -73.2 + index * 0.001 })),
      ...Array.from({ length: 12 }, (_, index) => ({ lat: 40.9 + (index + 1) * 0.001, lon: -73.199 })),
    ];
    const arrow = directionArrowAt(bend)!;
    expect(arrow.point.lon).toBeCloseTo(-73.199, 4);
    expect(Math.abs(arrow.bearing)).toBeLessThan(2);
    expect(directionArrowAt(line)!.bearing).toBeCloseTo(90, 0);
    expect(directionArrowAt([line[0]!])).toBeNull();
  });

  it('never draws the arrow where another part of the line runs through it', () => {
    // East along 40.9°N, then back west 40 m to the south (a hairpin): at 3 m/px that's ~13 px,
    // right where an arrow drawn on the right of the eastbound line would sit.
    const out = Array.from({ length: 21 }, (_, index) => ({ lat: 40.9, lon: -73.2 + index * 0.0005 }));
    const back = Array.from({ length: 21 }, (_, index) => ({ lat: 40.9 - 0.00036, lon: -73.19 - index * 0.0005 }));
    const arrow = directionArrowAt([...out, ...back], 3)!;
    expect(arrow).not.toBeNull();
    // Clear on the left (north) instead, where nothing else is drawn.
    expect(arrow.side).toBe('left');
    expect(arrow.bearing).toBeCloseTo(90, 0);
    // With the other side blocked too (the faint line behind the stop, 40 m north), there's no room.
    const behind = back.map((point) => ({ lat: 40.9 + 0.00036, lon: point.lon }));
    expect(directionArrowAt([...out, ...back], 3, [behind])).toBeNull();
    // On a plain straight line it sits on the right.
    expect(directionArrowAt(line)!.side).toBe('right');
  });

  it('picks the vehicle with the least line left before the stop', () => {
    // The line leading up to a stop at its east end (line[10]).
    const behind = line.slice(0, 11);
    const far = { id: 'far', lat: 40.9, lon: -73.2 };
    const near = { id: 'near', lat: 40.9001, lon: -73.193 };
    const past = { id: 'past', lat: 40.9, lon: -73.185 };
    const offLine = { id: 'off', lat: 40.95, lon: -73.192 };
    expect(approachingVehicle(behind, [far, near, past, offLine])?.id).toBe('near');
    expect(approachingVehicle(behind, [past, offLine])).toBeNull();
    expect(approachingVehicle([line[0]!], [near])).toBeNull();
  });

  it('splits a straight path at the stop', () => {
    const at = (stopIndex: number) => splitPathAtStop(line, stops, stopIndex);
    expect(at(1).behind.at(-1)).toEqual(line[10]);
    expect(at(1).ahead[0]).toEqual(line[10]);
    expect(at(0).behind).toHaveLength(1);
    expect(at(2).ahead).toHaveLength(1);
  });

  it('cuts at the stop itself when the nearest path point is far away', () => {
    // A 7 km straight segment with the stop in its middle, like the 1 train's sparse shape.
    const sparse = [{ lat: 40.8, lon: -73.96 }, { lat: 40.863, lon: -73.96 }];
    const stop = { lat: 40.83, lon: -73.96 };
    const { behind, ahead } = splitPathAtStop(sparse, [sparse[0]!, stop, sparse[1]!], 1);
    expect(behind.at(-1)!.lat).toBeCloseTo(40.83, 6);
    expect(ahead[0]!.lat).toBeCloseTo(40.83, 6);
  });

  it('splits at the right pass when the line passes the same stop twice', () => {
    // Out to the east and back: the stop at index 2 of the stops list is on the return leg.
    const outAndBack = [...line, ...line.slice(0, -1).reverse()];
    const loopStops = [line[0]!, line[15]!, line[10]!, line[0]!];
    const { behind } = splitPathAtStop(outAndBack, loopStops, 2);
    // Behind runs out to the east end and back to the stop.
    expect(behind.length).toBeGreaterThan(25);
    expect(behind.at(-1)!.lon).toBeCloseTo(line[10]!.lon, 6);
  });

  it('points east or west along the line', () => {
    expect(bearingDegrees(line[0]!, line[5]!)).toBeCloseTo(90, 0);
    expect(bearingDegrees(line[5]!, line[0]!)).toBeCloseTo(270, 0);
  });


  it('adds an alpha channel to hex colors', () => {
    expect(withAlpha('#A626AA', 0.35)).toBe('#A626AA59');
    expect(withAlpha('rgb(1, 2, 3)', 0.35)).toBe('rgb(1, 2, 3)');
  });
});

describe('framing a stop with a rider right beside it', () => {
  // The 4 train's Grand Central-42 St platform and a rider about 30 m away, in the terminal.
  const stop = { lat: 40.751776, lng: -73.976848 };
  const rider = { lat: 40.7525, lng: -73.9768 };

  it('widens the frame to about 1.3 km, so the map never opens at street level', () => {
    const framed = withMinimumFitSpan([stop, rider]);
    const lats = framed.map((point) => point.lat);
    const lngs = framed.map((point) => point.lng);
    expect(Math.max(...lats) - Math.min(...lats)).toBeCloseTo(MIN_FIT_SPAN, 6);
    expect(Math.max(...lngs) - Math.min(...lngs)).toBeCloseTo(MIN_FIT_SPAN, 6);
    expect(framed.slice(0, 2)).toEqual([stop, rider]);
  });

  it('leaves a frame that is already wide enough alone', () => {
    const farRider = { lat: 40.77, lng: -73.96 };
    expect(withMinimumFitSpan([stop, farRider])).toEqual([stop, farRider]);
  });
});

describe('snapStopsToPath', () => {
  // An east-west line; stops sit ~20 m north of it, like platforms beside the track.
  const line = [{ lat: 40.75, lon: -73.99 }, { lat: 40.75, lon: -73.97 }];
  const beside = (lon: number) => ({ name: 'stop', lat: 40.75018, lon });

  it('moves stop dots onto the drawn line', () => {
    const [first, second] = snapStopsToPath(line, [beside(-73.985), beside(-73.975)]);
    expect(first).toEqual({ lat: 40.75, lon: -73.985 });
    expect(second!.lat).toBeCloseTo(40.75, 10);
    expect(second!.lon).toBeCloseTo(-73.975, 10);
  });

  it('keeps a stop far from the line at its own spot', () => {
    const far = { name: 'far', lat: 40.76, lon: -73.98 };
    expect(snapStopsToPath(line, [far])).toEqual([{ lat: 40.76, lon: -73.98 }]);
  });

  it('leaves stops alone with no line to snap to', () => {
    expect(snapStopsToPath(undefined, [beside(-73.98)])).toEqual([{ lat: 40.75018, lon: -73.98 }]);
  });
});

describe('walkConnectors', () => {
  const rider = { lat: 40.7500, lon: -73.9900 };
  const stop = { lat: 40.7520, lon: -73.9850 };
  const walk = [{ lat: 40.7502, lon: -73.9898 }, { lat: 40.7518, lon: -73.9852 }];

  it('joins the walk to the rider and the stop where it stops short', () => {
    expect(walkConnectors(walk, rider, stop)).toEqual([[rider, walk[0]], [walk[1], stop]]);
  });

  it('skips a join when the walk already reaches the dot', () => {
    expect(walkConnectors([rider, stop], rider, stop)).toEqual([]);
  });

  it('runs straight from the rider to the stop with no walk', () => {
    expect(walkConnectors(undefined, rider, stop)).toEqual([[rider, stop]]);
    expect(walkConnectors(undefined, null, stop)).toEqual([]);
  });
});

describe('streetWalkToDraw', () => {
  const stop = { lat: 40.7115, lon: -74.0110 };
  const walk = [{ lat: 40.7116, lon: -74.0105 }, { lat: 40.7114, lon: -74.0108 }];

  it('drops the street walk once the rider is at the stop', () => {
    expect(streetWalkToDraw(walk, { lat: 40.7116, lon: -74.0108 }, stop)).toBeNull();
  });

  it('keeps a real walk for a rider farther off', () => {
    const longWalk = [{ lat: 40.7150, lon: -74.0050 }, { lat: 40.7130, lon: -74.0080 }, { lat: 40.7116, lon: -74.0108 }];
    expect(streetWalkToDraw(longWalk, { lat: 40.7150, lon: -74.0050 }, stop)).toBe(longWalk);
  });

  it('drops a walk too short to be more than a jog along the street', () => {
    expect(streetWalkToDraw(walk, { lat: 40.7150, lon: -74.0050 }, stop)).toBeNull();
  });
});
