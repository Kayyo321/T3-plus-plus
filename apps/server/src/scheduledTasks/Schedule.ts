import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  parseCronExpression,
  type ScheduledTaskMissedRunPolicy,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import { nextCronOccurrence } from "@t3tools/shared/cronSchedule";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const inZone = (from: DateTime.DateTime, timeZone: string | undefined): DateTime.Zoned => {
  if (timeZone !== undefined) return DateTime.setZoneNamedUnsafe(from, timeZone);
  return DateTime.isZoned(from) ? from : DateTime.setZone(from, DateTime.zoneMakeLocal());
};

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "cron") {
    const cron = parseCronExpression(schedule.expression);
    return cron === null ? null : nextCronOccurrence(cron, inZone(from, schedule.timeZone));
  }
  if (schedule.type === "once") {
    const runAt = DateTime.make(schedule.runAt);
    return Option.isSome(runAt) &&
      DateTime.toEpochMillis(runAt.value) > DateTime.toEpochMillis(from)
      ? runAt.value
      : null;
  }
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (a.type === "cron") {
    return b.type === "cron" && a.expression === b.expression && a.timeZone === b.timeZone;
  }
  if (a.type === "once") return b.type === "once" && Date.parse(a.runAt) === Date.parse(b.runAt);
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays)
  );
}

const MISSED_RUN_GRACE_MS = 10 * MINUTE_MS;

export function isMissedRun(dueAt: DateTime.DateTime, now: DateTime.DateTime): boolean {
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_RUN_GRACE_MS;
}

/** Tasks without a policy keep their old behaviour: clock times skip, intervals run late. */
export function missedRunPolicy(
  schedule: ScheduledTaskSchedule,
  policy: ScheduledTaskMissedRunPolicy | undefined,
): ScheduledTaskMissedRunPolicy {
  if (policy !== undefined) return policy;
  return schedule.type === "fixed_time" || schedule.type === "cron" ? "skip" : "run_once";
}

/**
 * The next time a catch-up replays after the run due at `dueAt`: the following occurrence,
 * moved up so at most `limit` stay owed. The newest occurrences are the ones kept.
 */
export function nextCatchUpRunAt(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
  limit: number,
): DateTime.DateTime | null {
  const owed: DateTime.DateTime[] = [];
  let cursor = nextScheduledRunAt(schedule, dueAt);
  while (cursor !== null && DateTime.toEpochMillis(cursor) <= DateTime.toEpochMillis(now)) {
    owed.push(cursor);
    cursor = nextScheduledRunAt(schedule, cursor);
  }
  return owed[Math.max(0, owed.length - limit)] ?? cursor;
}
