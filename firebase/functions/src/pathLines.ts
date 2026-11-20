/**
 * PATH's line names as the Port Authority signs them (NWK-WTC, HOB-33, JSQ-33, HOB-WTC). PATH's
 * GTFS sets every route_short_name to "PATH", so the code is built from route_long_name
 * ("Newark - World Trade Center", "Journal Square - 33rd Street (via Hoboken)"). Mirrored in
 * mobile/src/data/pathLines.ts for Google's planned PATH legs.
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
