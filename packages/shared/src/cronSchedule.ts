import { type CronFields } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// No zone moves its clock by more than this at once.
const CLOCK_CHANGE_WINDOW_MS = 3 * HOUR_MS;
// Feb 29 on a chosen weekday can be years away, and century years skip a leap day.
const SEARCH_LIMIT_MS = 12 * 366 * DAY_MS;

const dayMatches = (cron: CronFields, wall: Date) => {
  const inMonth = cron.daysOfMonth.has(wall.getUTCDate());
  const inWeek = cron.daysOfWeek.has(wall.getUTCDay());
  return cron.daysOfMonthRestricted && cron.daysOfWeekRestricted
    ? inMonth || inWeek
    : inMonth && inWeek;
};

/** First matching wall-clock minute at or after `start`, as a UTC-encoded local time. */
function nextMatchingMinute(cron: CronFields, start: number, limit: number): number | null {
  let wall = new Date(start);
  while (wall.getTime() <= limit) {
    if (!cron.months.has(wall.getUTCMonth() + 1)) {
      wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() + 1, 1));
    } else if (!dayMatches(cron, wall)) {
      wall = new Date(Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1));
    } else if (!cron.hours.has(wall.getUTCHours())) {
      wall = new Date((Math.floor(wall.getTime() / HOUR_MS) + 1) * HOUR_MS);
    } else if (!cron.minutes.has(wall.getUTCMinutes())) {
      wall = new Date(wall.getTime() + MINUTE_MS);
    } else {
      return wall.getTime();
    }
  }
  return null;
}

const wallTime = (value: DateTime.Zoned) => {
  const { year, month, day, hour, minute } = DateTime.toParts(value);
  return Date.UTC(year, month - 1, day, hour, minute);
};

/** The instants a wall-clock minute maps to: two in a repeated hour, a borrowed one in a skipped hour. */
function instantsOf(
  wall: number,
  cron: CronFields,
  zone: DateTime.Zoned["zone"],
): ReadonlyArray<DateTime.Zoned> {
  const clock = new Date(wall);
  const at = (disambiguation: DateTime.Disambiguation) =>
    DateTime.makeZonedUnsafe(
      {
        year: clock.getUTCFullYear(),
        month: clock.getUTCMonth() + 1,
        day: clock.getUTCDate(),
        hour: clock.getUTCHours(),
        minute: clock.getUTCMinutes(),
        second: 0,
        millisecond: 0,
      },
      { timeZone: zone, adjustForTimeZone: true, disambiguation },
    );
  const earlier = at("earlier");
  const later = at("later");
  if (wallTime(later) !== wall) return cron.hourly ? [] : [later];
  return cron.hourly && DateTime.toEpochMillis(earlier) !== DateTime.toEpochMillis(later)
    ? [earlier, later]
    : [earlier];
}

/**
 * The next time after `from` that the expression fires in `from`'s zone. A fixed time inside a
 * skipped hour runs right after the skip, and a fixed time inside a repeated hour runs once.
 * Hourly expressions keep their elapsed cadence through both.
 */
export function nextCronOccurrence(cron: CronFields, from: DateTime.Zoned): DateTime.Zoned | null {
  const fromMs = DateTime.toEpochMillis(from);
  const soon = DateTime.setZone(DateTime.makeUnsafe(fromMs + CLOCK_CHANGE_WINDOW_MS), from.zone);
  const clockChangesSoon = DateTime.zonedOffset(soon) !== DateTime.zonedOffset(from);
  // A repeated hour sits behind the wall clock's position, so an hourly walk starts earlier.
  const lookback = cron.hourly && clockChangesSoon ? CLOCK_CHANGE_WINDOW_MS : 0;
  const fromWall = wallTime(from);
  const limit = fromWall + SEARCH_LIMIT_MS;
  let best: DateTime.Zoned | null = null;
  let wall = fromWall - lookback;
  while (true) {
    const match = nextMatchingMinute(cron, wall, limit);
    if (match === null) return best;
    if (best !== null && match > wallTime(best) + lookback) return best;
    for (const instant of instantsOf(match, cron, from.zone)) {
      const ms = DateTime.toEpochMillis(instant);
      if (ms > fromMs && (best === null || ms < DateTime.toEpochMillis(best))) best = instant;
    }
    if (best !== null && lookback === 0) return best;
    wall = match + MINUTE_MS;
  }
}
