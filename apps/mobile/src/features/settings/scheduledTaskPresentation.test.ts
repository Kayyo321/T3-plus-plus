import { describe, expect, it } from "vite-plus/test";

import { scheduledRunText, scheduledTaskPolicyRows } from "./scheduledTaskPresentation";

const fixedTime = { type: "fixed_time", timeOfDay: "09:00" } as const;
const webhook = { type: "webhook", signature: null } as const;

describe("scheduledRunText", () => {
  it("shows why a run stopped over what it reported", () => {
    expect(scheduledRunText({ summary: "Found two", error: null })).toBe("Found two");
    expect(scheduledRunText({ summary: "Found two", error: "Timed out" })).toBe("Timed out");
  });
});

describe("scheduledTaskPolicyRows", () => {
  it("shows the server's defaults for a task with no stored policy", () => {
    expect(scheduledTaskPolicyRows({ schedule: fixedTime })).toEqual([
      { label: "Limit per run", value: "60 min, 500 tool calls" },
      { label: "If a run is missed", value: "Skip it" },
      { label: "Notify", value: "Every run" },
      { label: "If it needs an answer", value: "Wait for me" },
    ]);
    expect(scheduledTaskPolicyRows({ schedule: webhook })[1]?.value).toBe("Run once on wake");
  });

  it("shows a stored policy and how far a repeater has got", () => {
    const rows = scheduledTaskPolicyRows({
      schedule: fixedTime,
      repeaterIteration: 3,
      policy: {
        budget: { maxCostUsd: 2 },
        notify: "failures",
        onPrompt: "fail",
        missedRuns: "catch_up",
        repeater: { doneWhen: "tests pass", maxIterations: 10 },
      },
    });
    expect(rows).toEqual([
      { label: "Limit per run", value: "$2" },
      { label: "If a run is missed", value: "Catch up" },
      { label: "Notify", value: "Only failures" },
      { label: "If it needs an answer", value: "Stop it" },
      { label: "Repeat until", value: "tests pass (3 of 10 runs)" },
    ]);
  });
});
