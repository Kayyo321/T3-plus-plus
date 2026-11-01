// @effect-diagnostics globalDate:off
import {
  MIN_SCHEDULED_TASK_INTERVAL_MS,
  parseCronExpression,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const WEEKDAY_NAMES = [
  ["sunday", "sundays", "sun"],
  ["monday", "mondays", "mon"],
  ["tuesday", "tuesdays", "tue", "tues"],
  ["wednesday", "wednesdays", "wed"],
  ["thursday", "thursdays", "thu", "thurs"],
  ["friday", "fridays", "fri"],
  ["saturday", "saturdays", "sat"],
] as const;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  ten: 10,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
};

const amount = (text: string) => NUMBER_WORDS[text] ?? Number(text);

const pad = (value: number) => value.toString().padStart(2, "0");

/** Reads "9am", "5:30 pm", "17:45", "noon" and "midnight" into 24-hour time. */
function parseClock(text: string): { hour: number; minute: number } | null {
  const value = text.trim();
  if (value === "noon") return { hour: 12, minute: 0 };
  if (value === "midnight") return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(value);
  if (!match) return null;
  const rawHour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3]?.[0];
  if (minute > 59) return null;
  if (meridiem === undefined) return rawHour <= 23 ? { hour: rawHour, minute } : null;
  if (rawHour < 1 || rawHour > 12) return null;
  return { hour: (rawHour % 12) + (meridiem === "p" ? 12 : 0), minute };
}

/** Finds weekday names in a phrase. Empty when it names none. */
function parseWeekdays(text: string): ReadonlyArray<number> {
  if (/\b(weekdays?|business days?|work ?days?)\b/.test(text)) return [1, 2, 3, 4, 5];
  if (/\bweekends?\b/.test(text)) return [0, 6];
  const words = new Set(text.split(/[\s,]+/));
  return WEEKDAY_NAMES.flatMap((names, day) =>
    names.some((name) => words.has(name)) ? [day] : [],
  );
}

const FIXED_TIME =
  /^(?:(?:every|each)\s+)?(.*?)\s*(?:at|@)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?|noon|midnight)$/;

function parseFixedTime(text: string): ScheduledTaskUpsertSchedule | null {
  const match = FIXED_TIME.exec(text);
  const days = match?.[1] ?? "";
  const clock = match?.[2] === undefined ? null : parseClock(match[2]);
  if (clock === null) return null;
  const timeOfDay = `${pad(clock.hour)}:${pad(clock.minute)}`;
  if (days === "" || /^(day|daily|everyday)$/.test(days)) return { type: "fixed_time", timeOfDay };
  const weekdays = parseWeekdays(days);
  return weekdays.length === 0 ? null : { type: "fixed_time", timeOfDay, weekdays };
}

function parseInterval(text: string): ScheduledTaskUpsertSchedule | null {
  if (text === "hourly") return { type: "interval", everyMs: HOUR_MS };
  const match =
    /^(?:every|each)\s+(?:(\d+|[a-z]+)\s+)?(minute|min|hour|hr|day)s?(?:\s+on\s+(.+))?$/.exec(text);
  if (!match || match[2] === undefined) return null;
  const count = match[1] === undefined ? 1 : amount(match[1]);
  if (!Number.isInteger(count) || count < 1) return null;
  const unit = match[2];
  const days = match[3] === undefined ? [] : parseWeekdays(match[3]);
  if (match[3] !== undefined && days.length === 0) return null;
  if (days.length > 0) {
    if (unit === "day") return null;
    const minuteStep = unit === "minute" || unit === "min" ? count : count * 60;
    if (minuteStep % 60 === 0) {
      return { type: "cron", expression: `0 */${minuteStep / 60} * * ${days.join(",")}` };
    }
    return minuteStep < 60
      ? { type: "cron", expression: `*/${minuteStep} * * * ${days.join(",")}` }
      : null;
  }
  if (unit === "day" && count === 1) return { type: "fixed_time", timeOfDay: "09:00" };
  const unitMs =
    unit === "day" ? 24 * HOUR_MS : unit === "hour" || unit === "hr" ? HOUR_MS : MINUTE_MS;
  const everyMs = count * unitMs;
  return everyMs >= MIN_SCHEDULED_TASK_INTERVAL_MS ? { type: "interval", everyMs } : null;
}

function parseOneTime(text: string, now: Date): ScheduledTaskUpsertSchedule | null {
  const relative = /^in\s+(\d+|[a-z]+)\s+(minute|min|hour|hr|day)s?$/.exec(text);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    const count = amount(relative[1]);
    if (!Number.isInteger(count) || count < 1) return null;
    const unit = relative[2];
    const unitMs = unit === "day" ? 24 * HOUR_MS : unit.startsWith("h") ? HOUR_MS : MINUTE_MS;
    return { type: "once", runAt: new Date(now.getTime() + count * unitMs).toISOString() };
  }
  const day = /^(today|tonight|tomorrow)(?:\s+(?:at\s+)?(.+))?$/.exec(text);
  if (!day?.[1]) return null;
  const clock = day[2] === undefined ? { hour: 9, minute: 0 } : parseClock(day[2]);
  if (clock === null) return null;
  const runAt = new Date(now);
  runAt.setHours(clock.hour, clock.minute, 0, 0);
  if (day[1] === "tomorrow") runAt.setDate(runAt.getDate() + 1);
  return runAt.getTime() > now.getTime() ? { type: "once", runAt: runAt.toISOString() } : null;
}

/**
 * Reads a schedule from everyday English, or passes a cron expression through. One-time phrases
 * resolve against `now` in the client's zone, because that is the zone the person meant.
 */
export function parseScheduleText(
  input: string,
  now: Date = new Date(),
): ScheduledTaskUpsertSchedule | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const cronText = trimmed.replace(/^cron:?\s+/i, "");
  if (parseCronExpression(cronText) !== null) return { type: "cron", expression: cronText };
  const text = trimmed.toLowerCase().replace(/\s+/g, " ").replace(/[.!]$/, "");
  return parseOneTime(text, now) ?? parseFixedTime(text) ?? parseInterval(text);
}
