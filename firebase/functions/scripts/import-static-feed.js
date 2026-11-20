#!/usr/bin/env node
/**
 * Writes an agency's committed timetable copy (static_data/<dataDir>/) from its source GTFS ZIP,
 * changed the same way the daily refresh changes it (gtfsTransforms.ts: PATH's platforms as
 * stations) and checked the same way. Only the files
 * the backend reads are kept. Run `npm run build:gtfs` afterwards to prepare the derived files.
 *
 * Usage (after `npm run build`):
 *   node scripts/import-static-feed.js <agencyId> <source.zip>
 *
 * Download the source from the agency's staticFeedUrl in src/gtfsAgencies.ts. A feed whose service
 * has already ended (PATH's latest, at the time of writing) is still written, with a warning: its
 * stations and lines are right, but it has no timetable for today.
 */
const fs = require('fs');
const path = require('path');

const { AGENCY_CONFIGS } = require('../lib/gtfsAgencies');
const {
  assertGtfsServiceIsCurrent,
  extractGtfsArchive,
  fillTripDirections,
  snapshotLimitsFor,
  validateAgencySnapshotContract,
} = require('../lib/gtfsSnapshots');
const { transformSourceArchive } = require('../lib/gtfsTransforms');

const [agencyId, source] = process.argv.slice(2);
const config = AGENCY_CONFIGS[agencyId];
if (!config || !source) {
  console.error('Usage: node scripts/import-static-feed.js <agencyId> <source.zip>');
  process.exit(2);
}
if (config.onDemandRouteFiles) {
  console.error(`${agencyId} is read from its published snapshot and has no committed copy.`);
  process.exit(2);
}

const downloaded = fs.readFileSync(source);
const filled = config.fillTripDirections ? fillTripDirections(downloaded) : downloaded;
const archive = transformSourceArchive(config, filled);
const limits = snapshotLimitsFor(agencyId);
const extracted = extractGtfsArchive(archive, { limits: { ...limits, archiveBytes: Math.max(limits.archiveBytes, archive.byteLength) } });
for (const check of [() => assertGtfsServiceIsCurrent(extracted), () => validateAgencySnapshotContract(agencyId, extracted)]) {
  try {
    check();
  } catch (error) {
    console.warn(`Warning: ${error.message}. The refresh job would not publish this feed.`);
  }
}

const dir = path.join(__dirname, '../static_data', config.dataDir);
fs.mkdirSync(dir, { recursive: true });
for (const name of fs.readdirSync(dir)) if (name.endsWith('.txt')) fs.rmSync(path.join(dir, name));
for (const [name, data] of extracted.files) fs.writeFileSync(path.join(dir, name), data);
console.log(`Wrote ${[...extracted.files.keys()].join(', ')} to static_data/${config.dataDir} (service through ${extracted.serviceEndDate}).`);
