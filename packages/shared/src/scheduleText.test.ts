import { describe, expect, it } from "vitest";

import { parseScheduleText } from "./scheduleText.ts";

// A Wednesday, in the test runner's zone so one-time phrases compare locally.
const NOW = new Date(2026, 5, 10, 8, 0, 0);

describe("parseScheduleText", () => {
  it.each([
    ["every 30 minutes", { type: "interval", everyMs: 1_800_000 }],
    ["every minute", { type: "interval", everyMs: 60_000 }],
    ["Every 2 hours", { type: "interval", everyMs: 7_200_000 }],
    ["hourly", { type: "interval", everyMs: 3_600_000 }],
    ["every thirty minutes", { type: "interval", everyMs: 1_800_000 }],
    ["daily at 9am", { type: "fixed_time", timeOfDay: "09:00" }],
    ["every day at 5:30 pm", { type: "fixed_time", timeOfDay: "17:30" }],
    ["at noon", { type: "fixed_time", timeOfDay: "12:00" }],
    ["every day at midnight", { type: "fixed_time", timeOfDay: "00:00" }],
    ["weekdays at 9am", { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] }],
    ["weekends at 10:15", { type: "fixed_time", timeOfDay: "10:15", weekdays: [0, 6] }],
    ["every monday at 8am", { type: "fixed_time", timeOfDay: "08:00", weekdays: [1] }],
    ["mondays and fridays at 12am", { type: "fixed_time", timeOfDay: "00:00", weekdays: [1, 5] }],
    ["every 15 minutes on weekdays", { type: "cron", expression: "*/15 * * * 1,2,3,4,5" }],
    ["every 2 hours on weekends", { type: "cron", expression: "0 */2 * * 0,6" }],
    ["0 9 * * 1-5", { type: "cron", expression: "0 9 * * 1-5" }],
    ["cron: */5 * * * *", { type: "cron", expression: "*/5 * * * *" }],
  ])("reads %j", (text, schedule) => {
    expect(parseScheduleText(text, NOW)).toEqual(schedule);
  });

  it("resolves one-time phrases against now", () => {
    expect(parseScheduleText("in 2 hours", NOW)).toEqual({
      type: "once",
      runAt: new Date(2026, 5, 10, 10, 0, 0).toISOString(),
    });
    expect(parseScheduleText("tomorrow at 9am", NOW)).toEqual({
      type: "once",
      runAt: new Date(2026, 5, 11, 9, 0, 0).toISOString(),
    });
    expect(parseScheduleText("today at 5pm", NOW)).toEqual({
      type: "once",
      runAt: new Date(2026, 5, 10, 17, 0, 0).toISOString(),
    });
  });

  it.each([
    "",
    "whenever you feel like it",
    "every 30 seconds",
    "every 0 minutes",
    "today at 7am",
    "at 25:00",
    "at 13pm",
    "every banana at 9am",
    "every 90 minutes on weekdays",
  ])("refuses %j", (text) => {
    expect(parseScheduleText(text, NOW)).toBeNull();
  });
});
