/**
 * PATH's line names as the Port Authority signs them (NWK-WTC, HOB-33, JSQ-33, HOB-WTC). PATH's
 * GTFS sets every route_short_name to "PATH", so the code is built from route_long_name
 * ("Newark - World Trade Center", "Journal Square - 33rd Street (via Hoboken)"). Mirrors
 * firebase/functions/src/pathLines.ts, for Google's planned PATH legs.
 */
const PLACE_CODES: Record<string, string> = {
  newark: 'NWK',
  harrison: 'HAR',
  'journal square': 'JSQ',
  'grove street': 'GRV',
  'exchange place': 'EXP',
  newport: 'NEW',
  hoboken: 'HOB',
  'world trade center': 'WTC',
  'christopher street': 'CHR',
  '9th street': '9',
  '14th street': '14',
  '23rd street': '23',
  '33rd street': '33',
};

const placeCode = (place: string) => PLACE_CODES[place.trim().toLowerCase().replace(/\s+/g, ' ')];

/**
 * The line's code: "NWK-WTC", or "JSQ-HOB-33" for Journal Square to 33rd Street via Hoboken (the
 * Port Authority's own code for that late-night and weekend line). Null when a place isn't known.
 */
export function pathLineCode(longName: string): string | null {
  const match = /^(.+?)\s+-\s+(.+?)(?:\s+shuttle(?:\s+train)?)?(?:\s*\(via\s+(.+)\))?$/i.exec(longName.trim());
  if (!match) return null;
  const codes = [match[1]!, match[3], match[2]!].filter((place): place is string => Boolean(place)).map(placeCode);
  return codes.every(Boolean) ? codes.join('-') : null;
}

// PATH's everyday lines; the night and weekend ones (JSQ-HOB-33, WTC-33) borrow one's color.
const PATH_EVERYDAY_LINES = new Set(['NWK-WTC', 'HOB-WTC', 'JSQ-33', 'HOB-33', 'NWK-HAR']);

/**
 * `items` with one PATH line per color, keeping the everyday line: JSQ-33 and JSQ-HOB-33 are both
 * orange, and two identical Ps side by side would only read as a mistake. Other agencies' items
 * (and the order of everything kept) are left as they are.
 */
export function onePathLinePerColor<T>(items: readonly T[], read: (item: T) => { agency: string; code: string; color: string | null | undefined }): T[] {
  const everydayFirst = [...items].sort((a, b) => Number(!PATH_EVERYDAY_LINES.has(read(a).code)) - Number(!PATH_EVERYDAY_LINES.has(read(b).code)));
  const kept = new Set<T>();
  const seen = new Set<string>();
  for (const item of everydayFirst) {
    const { agency, color } = read(item);
    if (!isPathAgency(agency) || !color) continue;
    const key = color.replace('#', '').toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.add(item);
  }
  return items.filter((item) => {
    const { agency, color } = read(item);
    return !isPathAgency(agency) || !color || kept.has(item);
  });
}

/** PATH, by Pathly's name for it or Google's ("Port Authority Trans-Hudson"). */
export const isPathAgency = (agency: string) => /^path$|port authority trans[\s-]*hudson/i.test(agency.trim());

const PLACE_NAMES: Record<string, string> = { HOB: 'Hoboken', JSQ: 'Journal Square', GRV: 'Grove Street', EXP: 'Exchange Place', NEW: 'Newport' };

/**
 * The station a PATH line detours through, from its name ("... (via Hoboken)") or its code
 * (JSQ-HOB-33). Null for the lines that run straight between their two ends.
 */
export function pathVia(line: { name: string; shortName?: string }): string | null {
  const named = /\(via\s+(.+?)\)\s*$/i.exec(line.name.trim())?.[1];
  if (named) return named.trim();
  const middle = /^[A-Z0-9]+-([A-Z0-9]+)-[A-Z0-9]+$/i.exec((line.shortName ?? line.name).trim())?.[1];
  return middle ? PLACE_NAMES[middle.toUpperCase()] ?? null : null;
}

/**
 * Where a PATH train is headed, as riders read it: its destination, plus "via Hoboken" for the
 * night and weekend train that detours there (its sign says only "33rd Street").
 */
export function pathHeadsign(headsign: string, line: { name: string; shortName?: string }): string {
  const via = pathVia(line);
  return via && !headsign.toLowerCase().includes(via.toLowerCase()) ? `${headsign} via ${via}` : headsign;
}
