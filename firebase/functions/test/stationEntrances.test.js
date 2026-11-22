const assert = require('node:assert/strict');
const test = require('node:test');

const { entranceCorner, legEntrances, stationEntrances, withStopEntrances } = require('../lib/stationEntrances');
const { readAgencyStaticData } = require('../lib/gtfsFeed');

test('PATH stations have the entrances its own stops.txt publishes, not as stops', () => {
  const newark = stationEntrances('path', '26733');
  assert.equal(newark.length, 2);
  assert.ok(newark.every((entrance) => entrance.kind === 'entrance' && entrance.access === 'both'));
  // One is just southeast of the station's point; the other about 100 m west, clockwise from north.
  assert.deepEqual(newark.map((entrance) => entrance.corner), ['SE', 'W']);
  const data = readAgencyStaticData(`${__dirname}/../static_data/path`);
  assert.ok(!data.stopsById.has('782490'), 'an entrance is not a stop riders board at');
  assert.equal(data.entrancesByStation.get('26730').length, 2);
});

test('subway stations take their entrances from the state open data, by GTFS station', () => {
  const vanCortlandt = stationEntrances('subway', '101');
  assert.equal(vanCortlandt.length, 4);
  assert.ok(vanCortlandt.every((entrance) => entrance.kind === 'stair' && entrance.corner));
  // A platform's stop id finds its station's entrances.
  assert.deepEqual(stationEntrances('subway', '101N'), vanCortlandt);
  // Exit-only stairs say so.
  assert.ok(stationEntrances('subway', '103').some((entrance) => entrance.access === 'exit'));
});

test('stations of agencies that publish no entrances, and unknown stops, have none', () => {
  assert.deepEqual(stationEntrances('lirr', '237'), []);
  assert.deepEqual(stationEntrances('subway', 'no-such-stop'), []);
});

test('an entrance names the side of the station it is on', () => {
  const station = { lat: 40.75, lon: -73.99 };
  assert.equal(entranceCorner(station, { lat: 40.75015, lon: -73.99 }), undefined);
  assert.equal(entranceCorner(station, { lat: 40.751, lon: -73.99 }), 'N');
  assert.equal(entranceCorner(station, { lat: 40.7507, lon: -73.9891 }), 'NE');
  assert.equal(entranceCorner(station, { lat: 40.749, lon: -73.99 }), 'S');
  assert.equal(entranceCorner(station, { lat: 40.75, lon: -73.9912 }), 'W');
});

test('route stops carry entrances only where their station has some', () => {
  const [path, lirr] = [withStopEntrances('path', [{ stopId: '26730', name: 'Hoboken' }]), withStopEntrances('lirr', [{ stopId: '237', name: 'Penn Station' }])];
  assert.equal(path[0].entrances.length, 2);
  assert.equal('entrances' in lirr[0], false);
});

test('a leg says where to go in at its boarding station and out at its alighting one', () => {
  const subway = legEntrances('subway', '101S', '103S');
  assert.equal(subway.boardEntrances.length, 4);
  assert.ok(subway.alightEntrances.length >= 3);
  assert.deepEqual(legEntrances('nice', 'a', 'b'), {});
});
