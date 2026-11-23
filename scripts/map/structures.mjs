// Building outlines outside New York City, from FEMA's USA Structures (traced from satellite imagery)
// as the U.S. Geological Survey publishes them in The National Map's state structures packages, with
// no constraints on their use. New York City keeps its own, more exact footprints (addBuildings, NYC
// Open Data), so these are used only outside the five boroughs, and only over the area riders explore
// (EXPLORATION), not the margin.
//
// Public: the map needs no credit for them (Settings → About lists the source).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { EXPLORATION } from './bounds.mjs';
import { nycTest, statesOver } from './publicpaths.mjs';
import { fetchZipEntries } from './remotezip.mjs';
import { readShapefile } from './shapefile.mjs';
import { addPolygons, shapePolygons } from './sources.mjs';

const TNM = 'https://prd-tnm.s3.amazonaws.com/StagedProducts';
/** Buildings show from this zoom (MapLibre's), like New York City's. */
const BUILDING_MINZOOM = 14;

/**
 * Fetches the building outlines of every state the explored area reaches into
 * <dir>/usgs/structures/<state>: only the outlines' geometry (Struct_Poly_FEMA_*.shp), not the
 * packages' attribute tables (most of their size). Needs TIGER's states (tiger/).
 */
export async function downloadStructures(dir, log = console.log) {
  for (const { code, name } of statesOver(join(dir, 'tiger'), EXPLORATION)) {
    log(`Fetching building outlines for ${name.replace(/_/g, ' ')}...`);
    try {
      await fetchZipEntries(`${TNM}/Struct/Shape/STRUCT_${name}_State_Shape.zip`, (entry) => /Struct_Poly_FEMA[^/]*\.shp$/i.test(entry), join(dir, 'usgs', 'structures', code), log);
    } catch (error) {
      log(`  ${error.message}; skipped (run the download again to retry)`);
    }
  }
}

/** Adds the outlines to the building layer (outside New York City, inside the explored area). */
export function addStructures(store, dir, log) {
  const root = join(dir, 'usgs', 'structures');
  const files = existsSync(root)
    ? readdirSync(root).flatMap((state) => readdirSync(join(root, state)).filter((name) => /\.shp$/i.test(name)).map((name) => join(root, state, name)))
    : [];
  if (files.length === 0) {
    log(`  buildings outside NYC (USGS): none in ${root}; skipped (npm run map:download fetches them)`);
    return;
  }
  const inNyc = nycTest(join(dir, 'tiger'));
  const { west, south, east, north } = EXPLORATION;
  let count = 0;
  let inCity = 0;
  for (const file of files) {
    for (const { shape } of readShapefile(file, { withProps: false })) {
      if (!shape || shape.type !== 'polygon') continue;
      const [x, y] = shape.parts[0];
      if (x < west || x > east || y < south || y > north) continue;
      if (inNyc(x, y)) {
        inCity += 1;
        continue;
      }
      if (addPolygons(store, 'building', BUILDING_MINZOOM, {}, shapePolygons(shape.parts)) >= 0) count += 1;
    }
  }
  log(`  buildings outside NYC (USGS): ${count} (${inCity} in New York City left to its own)`);
}
