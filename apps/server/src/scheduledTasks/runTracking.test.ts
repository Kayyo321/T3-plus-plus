import { describe, expect, it } from "@effect/vitest";

import { assessRun, repeaterStep, type RunMeasure } from "./runTracking.ts";

const measure = (overrides: Partial<RunMeasure> = {}): RunMeasure => ({
  elapsedMs: 0,
  toolCalls: 0,
  costUsd: 0,
  waitingOnPerson: false,
  ...overrides,
});

describe("assessRun", () => {
  it.each([
    ["completed", null, "succeeded"],
    ["completed", "continue", "succeeded"],
    ["completed", "done", "done"],
    ["completed", "nothing_changed", "nothing_changed"],
    ["failed", "done", "failed"],
    ["interrupted", null, "interrupted"],
    ["cancelled", null, "interrupted"],
    ["rolled_back", null, "interrupted"],
  ] as const)("a %s run with verdict %s ends as %s", (status, verdict, outcome) => {
    expect(assessRun({ status, verdict, policy: undefined, measure: measure() })).toEqual({
      type: "finish",
      outcome,
    });
  });

  it("does not spend budget on a run that has not started", () => {
    expect(
      assessRun({
        status: "queued",
        verdict: null,
        policy: { budget: { maxDurationMinutes: 1 } },
        measure: measure({ elapsedMs: 3_600_000 }),
      }),
    ).toEqual({ type: "continue" });
  });

  it("enforces cost only once the price is known", () => {
    const policy = { budget: { maxCostUsd: 2 } };
    expect(
      assessRun({ status: "running", verdict: null, policy, measure: measure({ costUsd: null }) }),
    ).toEqual({ type: "continue" });
    expect(
      assessRun({ status: "running", verdict: null, policy, measure: measure({ costUsd: 2.5 }) }),
    ).toMatchObject({ type: "stop", outcome: "budget_exceeded" });
  });

  it("parks before it checks the budget", () => {
    expect(
      assessRun({
        status: "waiting",
        verdict: null,
        policy: { budget: { maxDurationMinutes: 1 } },
        measure: measure({ elapsedMs: 3_600_000, waitingOnPerson: true }),
      }),
    ).toEqual({ type: "park" });
  });
});

describe("repeaterStep", () => {
  const repeater = { doneWhen: "tests pass", maxIterations: 2 };

  it("keeps going under the cap, and stops at it", () => {
    expect(repeaterStep({ repeater, iteration: 1, outcome: "succeeded" })).toEqual({
      stop: false,
      outcome: "succeeded",
    });
    expect(repeaterStep({ repeater, iteration: 2, outcome: "succeeded" })).toEqual({
      stop: true,
      outcome: "iteration_limit",
    });
  });

  it.each(["done", "failed", "interrupted", "budget_exceeded"] as const)(
    "stops on %s under the cap",
    (outcome) => {
      expect(repeaterStep({ repeater, iteration: 1, outcome })).toEqual({ stop: true, outcome });
    },
  );

  it("treats nothing changed as another pass", () => {
    expect(repeaterStep({ repeater, iteration: 1, outcome: "nothing_changed" }).stop).toBe(false);
  });
});
