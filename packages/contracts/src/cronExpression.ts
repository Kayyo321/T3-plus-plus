export interface CronFields {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Classic cron matches either day field when both are restricted. */
  readonly daysOfMonthRestricted: boolean;
  readonly daysOfWeekRestricted: boolean;
  /** Runs every hour or a step of hours, so it follows elapsed time across clock changes. */
  readonly hourly: boolean;
}

const MONTH_NAMES = "jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec".split(",");
const DAY_NAMES = "sun,mon,tue,wed,thu,fri,sat".split(",");

const CRON_ALIASES: Readonly<Record<string, string>> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

function fieldValue(text: string, range: FieldRange, names?: ReadonlyArray<string>): number | null {
  const named = names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + range.min;
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= range.min && value <= range.max ? value : null;
}

function parseField(
  text: string,
  range: FieldRange,
  names?: ReadonlyArray<string>,
): Set<number> | null {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [span = "", stepText, ...rest] = part.split("/");
    if (rest.length > 0) return null;
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return null;
    const [startText = "", endText, ...more] = span.split("-");
    if (more.length > 0) return null;
    const whole = startText === "*" && endText === undefined;
    const start = whole ? range.min : fieldValue(startText, range, names);
    const end = whole
      ? range.max
      : endText === undefined
        ? stepText === undefined
          ? start
          : range.max
        : fieldValue(endText, range, names);
    if (start === null || end === null || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Five fields: minute, hour, day of month, month, day of week. Sunday is 0 or 7. */
export function parseCronExpression(expression: string): CronFields | null {
  const trimmed = expression.trim();
  const fields = (CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed).split(/\s+/);
  const [minuteText, hourText, dayText, monthText, weekdayText] = fields;
  if (
    fields.length !== 5 ||
    minuteText === undefined ||
    hourText === undefined ||
    dayText === undefined ||
    monthText === undefined ||
    weekdayText === undefined
  ) {
    return null;
  }
  const minutes = parseField(minuteText, { min: 0, max: 59 });
  const hours = parseField(hourText, { min: 0, max: 23 });
  const daysOfMonth = parseField(dayText, { min: 1, max: 31 });
  const months = parseField(monthText, { min: 1, max: 12 }, MONTH_NAMES);
  const rawWeekdays = parseField(weekdayText, { min: 0, max: 7 }, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawWeekdays) return null;
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...rawWeekdays].map((day) => day % 7)),
    daysOfMonthRestricted: !dayText.startsWith("*"),
    daysOfWeekRestricted: !weekdayText.startsWith("*"),
    hourly: hourText.startsWith("*"),
  };
}
