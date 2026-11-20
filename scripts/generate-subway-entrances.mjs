// Writes the MTA's "Subway Entrances and Exits" open data for the app and the backend:
// - mobile/src/data/subwayEntrances.json: [complex id, lat, lng, type, access] rows, for the trip map.
// - firebase/functions/src/subwayEntrances.json: GTFS station stop_id -> [lat, lng, type, access]
//   rows, for the stop list's and trip legs' ways in and out (stationEntrances.ts).
// Run from the repo root when stations change: node scripts/generate-subway-entrances.mjs
import { writeFileSync } from 'node:fs';

const SOURCE = 'https://data.ny.gov/resource/i9wp-a4ja.json?$limit=10000&$order=complex_id,entrance_latitude';

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Entrance data request failed with status ${response.status}`);
const rows = await response.json();

const access = (row) => (row.exit_allowed !== 'YES' ? 'entry' : row.entry_allowed !== 'YES' ? 'exit' : 'both');

// [complex id, lat, lng, type, 'both' | 'entry' | 'exit'], with exact duplicates dropped.
const entrances = [...new Set(rows.map((row) => JSON.stringify([
  Number(row.complex_id),
  Number(row.entrance_latitude),
  Number(row.entrance_longitude),
  row.entrance_type,
  access(row),
])))];
writeFileSync(new URL('../mobile/src/data/subwayEntrances.json', import.meta.url), `[\n${entrances.join(',\n')}\n]\n`);
console.log(`Wrote ${entrances.length} entrances for the app`);

// One station's entrances, keyed by the GTFS parent stop_id the backend's stops use.
const byStation = new Map();
for (const row of rows) {
  if (!row.gtfs_stop_id) continue;
  const list = byStation.get(row.gtfs_stop_id) ?? new Set();
  list.add(JSON.stringify([Number(row.entrance_latitude), Number(row.entrance_longitude), row.entrance_type, access(row)]));
  byStation.set(row.gtfs_stop_id, list);
}
const stations = [...byStation.keys()].sort().map((stopId) => `${JSON.stringify(stopId)}: [${[...byStation.get(stopId)].join(', ')}]`);
writeFileSync(new URL('../firebase/functions/src/subwayEntrances.json', import.meta.url), `{\n${stations.join(',\n')}\n}\n`);
console.log(`Wrote entrances for ${stations.length} stations for the backend`);
