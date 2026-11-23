import { basename } from 'node:path';

import { parse as parseCsv } from 'csv-parse/sync';
import { unzipSync, zipSync, type Zippable } from 'fflate';

import type { AgencyConfig } from './gtfsAgencies';
import { normalizePathStaticArchive } from './pathStatic';

/**
 * Changes made to an agency's source feed before it's validated and published (and before a copy
 * is committed under static_data/, by scripts/import-static-feed.js), so the published feed is the
 * shape the rest of the backend expects. Each is switched on by a field in gtfsAgencies.ts.
 *
 * - `stationStops` (PATH): stop_times.txt names platforms, but PATH's live feed names stations.
 *   Each platform is replaced by its parent station, and the platforms are dropped from stops.txt,
 *   so a station is one stop for both directions, as the live feed sees it. Entrances
 *   (location_type 2) stay, still under their station, for the stop list's ways in and out.
 *
 * Entry times are fixed, so the same source yields the same bytes. An archive with nothing to
 * change is returned unchanged.
 */

const ZIP_MTIME = new Date('2000-01-01T00:00:00Z');

type Entries = Record<string, Uint8Array>;

const entryName = (entries: Entries, file: string) => Object.keys(entries).find((name) => basename(name.replaceAll('\\', '/')) === file);

/** The CSV's lines as text, with its header's column positions. Lines keep their own text. */
function csvLines(data: Uint8Array): { header: string[]; lines: string[] } {
  const text = new TextDecoder().decode(data).replace(/^﻿/, '');
  const lines = text.split('\n');
  const header = (parseCsv(lines[0] ?? '', { relax_column_count: true }) as string[][])[0]?.map((column) => column.trim()) ?? [];
  return { header, lines: lines.slice(1).filter((line) => line.trim() !== '') };
}

/** One line's fields. Plain lines (no quotes, as in nearly every row of a big feed) are split directly. */
function fields(line: string): string[] {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!clean.includes('"')) return clean.split(',');
  return (parseCsv(clean, { relax_column_count: true, relax_quotes: true }) as string[][])[0] ?? [];
}

function column(header: readonly string[], name: string): number {
  return header.indexOf(name);
}

const encode = (headerLine: string, lines: readonly string[]) => new TextEncoder().encode(`${[headerLine, ...lines].join('\n')}\n`);
const headerLineOf = (data: Uint8Array) => new TextDecoder().decode(data.subarray(0, data.indexOf(10) < 0 ? data.length : data.indexOf(10))).replace(/^﻿/, '').replace(/\r$/, '');

/** The lines whose `name` column passes `keep`; all of them when the file has no such column. */
function filterLines(data: Uint8Array, name: string, keep: (value: string) => boolean): Uint8Array {
  const { header, lines } = csvLines(data);
  const index = column(header, name);
  if (index < 0) return data;
  return encode(headerLineOf(data), lines.filter((line) => keep(fields(line)[index]?.trim() ?? '')));
}

function zip(entries: Entries): Buffer {
  const sorted: Zippable = {};
  for (const name of Object.keys(entries).sort()) sorted[name] = entries[name]!;
  return Buffer.from(zipSync(sorted, { level: 6, mtime: ZIP_MTIME }));
}

/** PATH: platforms in stop_times.txt become their stations, and stops.txt keeps only stations and their entrances. */
export function collapsePlatformsToStations(archive: Uint8Array): Buffer {
  const entries: Entries = unzipSync(archive);
  const stopsName = entryName(entries, 'stops.txt');
  const stopTimesName = entryName(entries, 'stop_times.txt');
  if (!stopsName || !stopTimesName) return Buffer.from(archive);

  const stops = csvLines(entries[stopsName]!);
  const idIndex = column(stops.header, 'stop_id');
  const parentIndex = column(stops.header, 'parent_station');
  const typeIndex = column(stops.header, 'location_type');
  if (idIndex < 0 || parentIndex < 0) return Buffer.from(archive);
  const stationOf = new Map<string, string>();
  const stationLines: string[] = [];
  for (const line of stops.lines) {
    const row = fields(line);
    const parent = row[parentIndex]?.trim();
    const entrance = typeIndex >= 0 && row[typeIndex]?.trim() === '2';
    if (parent && !entrance) stationOf.set(row[idIndex]!.trim(), parent);
    else stationLines.push(line);
  }
  if (stationOf.size === 0) return Buffer.from(archive);

  const stopTimes = csvLines(entries[stopTimesName]!);
  const stopIndex = column(stopTimes.header, 'stop_id');
  const rewritten = stopTimes.lines.map((line) => {
    const row = fields(line);
    const station = stationOf.get(row[stopIndex]?.trim() ?? '');
    if (!station) return line;
    // Ids are plain (no quotes or commas) in PATH's feed; a quoted line is rebuilt field by field.
    row[stopIndex] = station;
    return row.map((value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value)).join(',');
  });
  entries[stopTimesName] = encode(headerLineOf(entries[stopTimesName]!), rewritten);
  entries[stopsName] = encode(headerLineOf(entries[stopsName]!), stationLines);
  return zip(entries);
}

type TransformConfig = Pick<AgencyConfig, 'id' | 'stationStops'>;

/** The agency's source archive with its configured changes applied (see the top of this file). */
export function transformSourceArchive(config: TransformConfig, archive: Buffer): Buffer {
  const normalized = config.id === 'path' ? normalizePathStaticArchive(archive) : archive;
  return config.stationStops ? collapsePlatformsToStations(normalized) : normalized;
}
