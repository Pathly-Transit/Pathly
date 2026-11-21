/** GTFS Time uses the service date's local noon minus 12 elapsed hours, including on DST days. */
export type GtfsServiceDay = { dateKey: string; dayOfWeek: number; startMs: number; seconds: number };
const DAY_MS = 24 * 60 * 60_000;
const easternParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function clock(ms: number) {
  const parts = Object.fromEntries(easternParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Each calendar date gets its own unambiguous noon; adjacent service starts need not be 24h apart. */
export function gtfsServiceDaysFor(ms: number, offsets: readonly number[] = [0, -1, 1]): GtfsServiceDay[] {
  const today = clock(ms);
  const calendarMidnight = Date.UTC(today.year, today.month - 1, today.day);
  return offsets.map((offset) => {
    // UTC arithmetic here changes a calendar label, not an Eastern elapsed-time boundary.
    const date = new Date(calendarMidnight + offset * DAY_MS);
    const targetNoon = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12);
    let noonMs = targetNoon;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = clock(noonMs);
      const adjustment = targetNoon - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
      noonMs += adjustment;
      if (adjustment === 0) break;
    }
    const startMs = noonMs - DAY_MS / 2;
    return {
      dateKey: String(date.getUTCFullYear()).padStart(4, '0') + String(date.getUTCMonth() + 1).padStart(2, '0') + String(date.getUTCDate()).padStart(2, '0'),
      dayOfWeek: date.getUTCDay(), startMs, seconds: (ms - startMs) / 1000,
    };
  });
}
