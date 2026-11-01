// @effect-diagnostics globalDate:off
import { parseCronExpression } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { nextCronOccurrence } from "./cronSchedule.ts";

const NEW_YORK = "America/New_York";

const next = (expression: string, fromUtc: string, timeZone = NEW_YORK) => {
  const cron = parseCronExpression(expression);
  if (cron === null) throw new Error(`Invalid test expression: ${expression}`);
  const from = DateTime.setZoneNamedUnsafe(DateTime.makeUnsafe(fromUtc), timeZone);
  const occurrence = nextCronOccurrence(cron, from);
  return occurrence === null ? null : DateTime.formatIso(DateTime.toUtc(occurrence));
};

const iso = (value: string) => new Date(value).toISOString();

describe("parseCronExpression", () => {
  it.each([
    "* * * * *",
    "*/15 9-17 * * 1-5",
    "0 9 1,15 * *",
    "30 6 * JAN-MAR mon,fri",
    "0 0 * * 7",
    "5/10 * * * *",
    "@daily",
    "@Hourly",
  ])("accepts %s", (expression) => {
    expect(parseCronExpression(expression)).not.toBeNull();
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "1-2-3 * * * *",
    "a * * * *",
    "@reboot",
  ])("rejects %j", (expression) => {
    expect(parseCronExpression(expression)).toBeNull();
  });

  it("treats 7 as Sunday", () => {
    expect([...(parseCronExpression("0 0 * * 7")?.daysOfWeek ?? [])]).toEqual([0]);
  });
});

describe("nextCronOccurrence", () => {
  it("finds the next minute, hour, weekday and month", () => {
    expect(next("*/5 * * * *", "2026-06-10T12:02:30Z")).toBe(iso("2026-06-10T12:05:00Z"));
    expect(next("0 9 * * *", "2026-06-10T14:00:00Z")).toBe(iso("2026-06-11T13:00:00Z"));
    expect(next("0 9 * * 1-5", "2026-06-12T14:00:00Z")).toBe(iso("2026-06-15T13:00:00Z"));
    expect(next("0 0 1 1 *", "2026-06-12T14:00:00Z")).toBe(iso("2027-01-01T05:00:00Z"));
  });

  it("is strictly after from", () => {
    expect(next("0 9 * * *", "2026-06-10T13:00:00Z")).toBe(iso("2026-06-11T13:00:00Z"));
  });

  it("matches either day field when both are restricted", () => {
    expect(next("0 0 13 * 5", "2026-06-02T12:00:00Z", "UTC")).toBe(iso("2026-06-05T00:00:00Z"));
    expect(next("0 0 13 * 5", "2026-06-12T12:00:00Z", "UTC")).toBe(iso("2026-06-13T00:00:00Z"));
  });

  it("finds a leap day and has no answer for an impossible date", () => {
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z", "UTC")).toBe(iso("2028-02-29T00:00:00Z"));
    expect(next("0 0 31 2 *", "2026-03-01T00:00:00Z", "UTC")).toBeNull();
  });

  it("runs a fixed time inside the skipped hour right after the skip", () => {
    // 2026-03-08 02:00 EST jumps to 03:00 EDT.
    expect(next("30 2 * * *", "2026-03-08T06:00:00Z")).toBe(iso("2026-03-08T07:30:00Z"));
    expect(next("30 2 * * *", "2026-03-08T08:00:00Z")).toBe(iso("2026-03-09T06:30:00Z"));
  });

  it("does not run a fixed time twice in the repeated hour", () => {
    // 2026-11-01 02:00 EDT falls back to 01:00 EST.
    const first = next("30 1 * * *", "2026-11-01T04:00:00Z");
    expect(first).toBe(iso("2026-11-01T05:30:00Z"));
    expect(next("30 1 * * *", first ?? "")).toBe(iso("2026-11-02T06:30:00Z"));
    expect(next("30 1 * * *", "2026-11-01T06:10:00Z")).toBe(iso("2026-11-02T06:30:00Z"));
  });

  it("keeps an hourly cadence through both clock changes", () => {
    expect(next("*/20 * * * *", "2026-03-08T06:50:00Z")).toBe(iso("2026-03-08T07:00:00Z"));
    expect(next("*/20 * * * *", "2026-11-01T05:45:00Z")).toBe(iso("2026-11-01T06:00:00Z"));
    expect(next("0 * * * *", "2026-11-01T05:30:00Z")).toBe(iso("2026-11-01T06:00:00Z"));
    expect(next("0 * * * *", "2026-11-01T06:00:00Z")).toBe(iso("2026-11-01T07:00:00Z"));
  });

  it("uses the zone it is given", () => {
    expect(next("0 9 * * *", "2026-06-10T00:00:00Z", "Asia/Tokyo")).toBe(
      iso("2026-06-11T00:00:00Z"),
    );
  });
});
