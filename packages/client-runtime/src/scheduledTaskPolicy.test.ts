import {
  DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
  MAX_SCHEDULED_TASK_ITERATIONS,
  ScheduledTaskId,
  ScheduledTaskRunId,
  type ScheduledTaskRun,
  type ScheduledTaskRunPolicy,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_SCHEDULED_TASK_ITERATIONS,
  parseScheduledTaskPolicyDraft,
  scheduledRunDetails,
  scheduledRunOutcome,
  scheduledTaskHostNotice,
  scheduledTaskPolicyDraft,
  shouldNotifyScheduledRun,
  withLatestScheduledRun,
} from "./scheduledTaskPolicy.ts";

const fullPolicy: ScheduledTaskRunPolicy = {
  budget: { maxDurationMinutes: 30, maxToolCalls: 100, maxCostUsd: 2.5 },
  repeater: { doneWhen: "all tests pass", maxIterations: 5 },
  missedRuns: "catch_up",
  notify: "failures",
  onPrompt: "fail",
};

const run = (overrides: Partial<ScheduledTaskRun>): ScheduledTaskRun => ({
  id: ScheduledTaskRunId.make("run-1"),
  taskId: ScheduledTaskId.make("task"),
  trigger: "scheduled",
  scheduledFor: null,
  startedAt: "2026-11-01T09:00:00.000Z",
  finishedAt: "2026-11-01T09:05:00.000Z",
  outcome: "succeeded",
  threadId: null,
  iteration: 0,
  summary: null,
  error: null,
  toolCalls: 0,
  costUsd: null,
  ...overrides,
});

describe("scheduled task policy drafts", () => {
  it.each<[string, ScheduledTaskRunPolicy | undefined, ScheduledTaskRunPolicy]>([
    ["no stored policy", undefined, {}],
    ["an empty policy", {}, {}],
    ["every field", fullPolicy, fullPolicy],
    ["a budget without the defaults", { budget: { maxCostUsd: 5 } }, { budget: { maxCostUsd: 5 } }],
    [
      "unknown fields",
      { notify: "none", later: true } as ScheduledTaskRunPolicy,
      { notify: "none", later: true } as ScheduledTaskRunPolicy,
    ],
  ])("round trips %s unchanged", (_name, stored, expected) => {
    expect(parseScheduledTaskPolicyDraft(scheduledTaskPolicyDraft(stored))).toEqual({
      policy: expected,
    });
  });

  it("keeps the other default limits when one budget field is set", () => {
    const draft = { ...scheduledTaskPolicyDraft(undefined), maxCostUsd: "1.5" };
    expect(parseScheduledTaskPolicyDraft(draft)).toEqual({
      policy: { budget: { ...DEFAULT_SCHEDULED_TASK_RUN_BUDGET, maxCostUsd: 1.5 } },
    });
  });

  it("returns to the server's budget when every limit is cleared", () => {
    const draft = {
      ...scheduledTaskPolicyDraft(fullPolicy),
      maxDurationMinutes: "",
      maxToolCalls: "",
      maxCostUsd: "",
    };
    expect(parseScheduledTaskPolicyDraft(draft)).toEqual({
      policy: {
        repeater: fullPolicy.repeater,
        missedRuns: "catch_up",
        notify: "failures",
        onPrompt: "fail",
      },
    });
  });

  it("clears the cost limit without losing the other limits", () => {
    const draft = { ...scheduledTaskPolicyDraft(fullPolicy), maxCostUsd: "" };
    expect(parseScheduledTaskPolicyDraft(draft)).toEqual({
      policy: { ...fullPolicy, budget: { maxDurationMinutes: 30, maxToolCalls: 100 } },
    });
  });

  it("removes the repeater with its condition and defaults its iterations", () => {
    const stored = scheduledTaskPolicyDraft(fullPolicy);
    expect(parseScheduledTaskPolicyDraft({ ...stored, doneWhen: "  " })).toEqual({
      policy: {
        budget: fullPolicy.budget,
        missedRuns: "catch_up",
        notify: "failures",
        onPrompt: "fail",
      },
    });
    const fresh = { ...scheduledTaskPolicyDraft(undefined), doneWhen: " queue is empty " };
    expect(parseScheduledTaskPolicyDraft(fresh)).toEqual({
      policy: {
        repeater: { doneWhen: "queue is empty", maxIterations: DEFAULT_SCHEDULED_TASK_ITERATIONS },
      },
    });
  });

  it.each([
    ["maxDurationMinutes", "0"],
    ["maxDurationMinutes", "1.5"],
    ["maxToolCalls", "-3"],
    ["maxCostUsd", "free"],
    ["maxCostUsd", "0"],
  ])("rejects %s of %s", (field, value) => {
    const draft = { ...scheduledTaskPolicyDraft(undefined), [field]: value };
    expect(parseScheduledTaskPolicyDraft(draft)).toHaveProperty("error");
  });

  it("caps iterations at the server's maximum", () => {
    const draft = { ...scheduledTaskPolicyDraft(undefined), doneWhen: "done" };
    expect(
      parseScheduledTaskPolicyDraft({
        ...draft,
        maxIterations: String(MAX_SCHEDULED_TASK_ITERATIONS),
      }),
    ).toHaveProperty("policy");
    expect(
      parseScheduledTaskPolicyDraft({
        ...draft,
        maxIterations: String(MAX_SCHEDULED_TASK_ITERATIONS + 1),
      }),
    ).toHaveProperty("error");
  });
});

describe("shouldNotifyScheduledRun", () => {
  const finished = (outcome: string) => run({ outcome });
  const open = (outcome: string) => run({ outcome, finishedAt: null });

  it.each([
    [undefined, "succeeded", true],
    [undefined, "nothing_changed", true],
    ["all", "skipped", true],
    ["changes", "succeeded", true],
    ["changes", "nothing_changed", false],
    ["failures", "succeeded", false],
    ["failures", "nothing_changed", false],
    ["failures", "failed", true],
    ["failures", "budget_exceeded", true],
    ["failures", "iteration_limit", true],
    ["failures", "interrupted", true],
    ["none", "failed", false],
    ["all", "a_new_outcome", true],
    ["changes", "a_new_outcome", true],
    ["failures", "a_new_outcome", false],
  ] as const)("with %s, a finished %s run gives %s", (notify, outcome, expected) => {
    expect(shouldNotifyScheduledRun(finished(outcome), notify)).toBe(expected);
  });

  it.each(["all", "changes", "failures"] as const)("%s still asks for answers", (notify) => {
    expect(shouldNotifyScheduledRun(open("needs_input"), notify)).toBe(true);
  });

  it("stays quiet about answers under none, and about runs still going", () => {
    expect(shouldNotifyScheduledRun(open("needs_input"), "none")).toBe(false);
    expect(shouldNotifyScheduledRun(open("running"), "all")).toBe(false);
    expect(shouldNotifyScheduledRun(open("a_new_outcome"), "all")).toBe(false);
  });
});

describe("scheduled run presentation", () => {
  it("reads an unknown outcome as words, including one named after an object key", () => {
    expect(scheduledRunOutcome("needs_input").tone).toBe("warning");
    expect(scheduledRunOutcome("timed_out")).toEqual({ label: "Timed out", tone: "neutral" });
    expect(scheduledRunOutcome("constructor")).toEqual({ label: "Constructor", tone: "neutral" });
  });

  it("leaves out what a run doesn't have", () => {
    expect(scheduledRunDetails(run({ toolCalls: 1 }))).toBe("1 tool call");
    expect(scheduledRunDetails(run({ toolCalls: 4, costUsd: 0.125, iteration: 2 }))).toBe(
      "4 tool calls · $0.13 · Iteration 2",
    );
    expect(scheduledRunDetails(run({ costUsd: 0.001 }))).toBe("0 tool calls · Under $0.01");
  });

  it("lets the live run replace or lead a cached page", () => {
    const cached = run({ outcome: "running", finishedAt: null });
    const live = run({ outcome: "failed" });
    expect(withLatestScheduledRun([cached], live)).toEqual([live]);

    const next = run({
      id: ScheduledTaskRunId.make("run-2"),
      startedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(withLatestScheduledRun([cached], next)).toEqual([next, cached]);
    expect(withLatestScheduledRun([next], cached)).toEqual([next]);
    expect(withLatestScheduledRun([cached], undefined)).toEqual([cached]);
  });

  it("warns only when no service keeps tasks firing", () => {
    expect(scheduledTaskHostNotice("terminal")).toContain("t3pp service install");
    expect(scheduledTaskHostNotice("desktop")).toContain("t3pp service install");
    expect(scheduledTaskHostNotice("service")).toBeNull();
    expect(scheduledTaskHostNotice(undefined)).toBeNull();
  });
});
