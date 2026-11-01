import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TEAM_BUDGET,
  type TeamAction,
  TeamMemberId,
  TeamRunId,
  type TeamRun,
  TeamTaskId,
  ThreadId,
} from "@t3tools/contracts";

import { applyTeamAction, enforceTeamBudget } from "./teamRunMachine.ts";

const lead = TeamMemberId.make("lead");
const builder = TeamMemberId.make("builder");
const reviewer = TeamMemberId.make("reviewer");
const tester = TeamMemberId.make("tester");
const skeptic = TeamMemberId.make("skeptic");
const task = TeamTaskId.make("task-1");
const at = "2026-11-01T12:00:00.000Z";

const makeRun = (overrides: Partial<TeamRun> = {}): TeamRun => ({
  id: TeamRunId.make("run"),
  parentThreadId: ThreadId.make("parent"),
  request: "Ship it",
  presetId: "build-a-feature",
  dial: "autonomous",
  budget: DEFAULT_TEAM_BUDGET,
  dryRun: false,
  phase: "build",
  status: "running",
  waitingFor: null,
  reviewLoops: 0,
  members: [
    { id: lead, role: "lead", threadId: null },
    { id: builder, role: "builder", threadId: null },
    { id: reviewer, role: "reviewer", threadId: null },
    { id: tester, role: "tester", threadId: null },
    { id: skeptic, role: "skeptic", threadId: null },
  ],
  tasks: [{ id: task, title: "Slice", ownerId: builder, state: "done", builtBy: [builder] }],
  notes: [],
  handoffs: [],
  evidence: [],
  verdicts: [],
  report: null,
  startedAt: at,
  updatedAt: at,
  ...overrides,
});

const apply = (run: TeamRun, action: TeamAction) => applyTeamAction(run, action, at);

const applied = (run: TeamRun, action: TeamAction) => {
  const result = apply(run, action);
  if (!result.ok) throw new Error(result.refusal.detail);
  return result.run;
};

const refusedWith = (run: TeamRun, action: TeamAction) => {
  const result = apply(run, action);
  return result.ok ? "applied" : result.refusal.reason;
};

const passing = { command: "vp test run", output: "1 passed", passed: true };

describe("applyTeamAction", () => {
  it("lets no builder judge what they built, whatever role they hold", () => {
    const review = makeRun({
      phase: "peer_review",
      members: [
        { id: lead, role: "lead", threadId: null },
        { id: builder, role: "reviewer", threadId: null },
      ],
    });
    assert.equal(
      refusedWith(review, { type: "verdict", byId: builder, passed: true, reason: "ok" }),
      "self_approval",
    );
  });

  it("keeps a builder out even after the task moves to someone else", () => {
    const reassigned = applied(makeRun(), {
      type: "task_upsert",
      byId: lead,
      taskId: task,
      ownerId: tester,
    });
    assert.deepStrictEqual(reassigned.tasks[0]?.builtBy, [builder]);
  });

  it("refuses a judge from the wrong role", () => {
    assert.equal(
      refusedWith(makeRun({ phase: "verification" }), {
        type: "verdict",
        byId: reviewer,
        passed: true,
        reason: "looks good",
      }),
      "not_a_member",
    );
  });

  it("lets the audit preset verify with an independent reviewer", () => {
    const run = makeRun({ presetId: "audit", phase: "verification" });
    const proved = applied(run, { type: "evidence", byId: reviewer, ...passing });
    const judged = applied(proved, {
      type: "verdict",
      byId: reviewer,
      passed: true,
      reason: "Ran the checks",
    });
    assert.equal(applied(judged, { type: "advance", byId: lead }).phase, "acceptance");
  });

  it("does not take looks good for a pass", () => {
    const review = makeRun({ phase: "verification" });
    assert.equal(refusedWith(review, { type: "advance", byId: lead }), "needs_verdict");
    const judged = applied(review, {
      type: "verdict",
      byId: tester,
      passed: true,
      reason: "looks good",
    });
    assert.equal(refusedWith(judged, { type: "advance", byId: lead }), "needs_evidence");
    const proved = applied(judged, { type: "evidence", byId: tester, ...passing });
    assert.equal(applied(proved, { type: "advance", byId: lead }).phase, "acceptance");
  });

  it("holds a failed check until the same check passes", () => {
    const failed = applied(
      applied(makeRun({ phase: "verification" }), {
        type: "evidence",
        byId: tester,
        command: "vp test run",
        output: "1 failed",
        passed: false,
      }),
      { type: "evidence", byId: tester, command: "other check", output: "ok", passed: true },
    );
    const judged = applied(failed, { type: "verdict", byId: tester, passed: true, reason: "ok" });
    assert.equal(refusedWith(judged, { type: "advance", byId: lead }), "failed_checks");
    const fixed = applied(judged, { type: "evidence", byId: tester, ...passing });
    assert.equal(applied(fixed, { type: "advance", byId: lead }).phase, "acceptance");
    const regressed = applied(fixed, {
      type: "evidence",
      byId: tester,
      command: passing.command,
      output: "failed again",
      passed: false,
    });
    assert.equal(refusedWith(regressed, { type: "advance", byId: lead }), "failed_checks");
  });

  it("sends a failed review back to build and stops at the loop limit", () => {
    const rejection = {
      type: "verdict",
      byId: reviewer,
      passed: false,
      reason: "wrong",
    } as const;
    const sentBack = applied(makeRun({ phase: "peer_review" }), rejection);
    assert.equal(sentBack.phase, "build");
    assert.equal(sentBack.tasks[0]?.state, "doing");

    const limit = makeRun({
      phase: "peer_review",
      reviewLoops: DEFAULT_TEAM_BUDGET.maxReviewLoops,
    });
    const parked = applied(limit, rejection);
    assert.equal(parked.status, "awaiting_owner");
    assert.equal(parked.phase, "peer_review");
  });

  it("requires a fresh passing verdict after a send-back", () => {
    const passed = applied(makeRun({ phase: "peer_review" }), {
      type: "verdict",
      byId: reviewer,
      passed: true,
      reason: "good",
    });
    const failed = applied(passed, {
      type: "verdict",
      byId: reviewer,
      passed: false,
      reason: "found one",
    });
    const rebuilt = applied(failed, {
      type: "task_upsert",
      byId: lead,
      taskId: task,
      state: "done",
    });
    const again = applied(applied(rebuilt, { type: "advance", byId: lead }), {
      type: "note",
      byId: lead,
      kind: "decision",
      text: "second look",
    });
    assert.equal(again.phase, "peer_review");
    assert.equal(refusedWith(again, { type: "advance", byId: lead }), "needs_verdict");
  });

  it("stops at the owner's gate for the dial", () => {
    const plan = makeRun({ phase: "plan_review", dial: "approve_plan", tasks: [] });
    const judged = applied(plan, { type: "verdict", byId: reviewer, passed: true, reason: "ok" });
    const waiting = applied(judged, { type: "advance", byId: lead });
    assert.equal(waiting.status, "awaiting_owner");
    assert.equal(waiting.phase, "plan_review");
    assert.equal(refusedWith(waiting, { type: "advance", byId: lead }), "wrong_phase");
    const approved = applied(waiting, { type: "owner_approve" });
    assert.equal(approved.phase, "build");
    assert.equal(approved.status, "running");
  });

  it("ends a dry run with the plan, spending nothing on build", () => {
    const run = applied(makeRun({ phase: "plan", dryRun: true }), { type: "advance", byId: lead });
    assert.equal(run.status, "completed");
    assert.equal(run.phase, "plan");
  });

  it("will not write a report that hides a failed check", () => {
    const run = makeRun({
      phase: "report",
      evidence: [{ byId: tester, command: "e2e", output: "failed", passed: false, at }],
    });
    const summary = { summary: "Done", verified: [], openRisks: [] };
    assert.equal(
      refusedWith(run, {
        type: "report",
        byId: lead,
        report: { ...summary, notVerified: [] },
      }),
      "failed_checks",
    );
    const finished = applied(run, {
      type: "report",
      byId: lead,
      report: { ...summary, notVerified: ["e2e failed"] },
    });
    assert.equal(finished.status, "completed");
  });

  it("refuses evidence from an unknown member", () => {
    assert.equal(
      refusedWith(makeRun(), { type: "evidence", byId: TeamMemberId.make("unknown"), ...passing }),
      "not_a_member",
    );
  });

  it("takes nothing after the run ends", () => {
    assert.equal(
      refusedWith(makeRun({ status: "stopped" }), {
        type: "note",
        byId: lead,
        kind: "decision",
        text: "late",
      }),
      "run_closed",
    );
  });
});

describe("enforceTeamBudget", () => {
  it("parks a run past its time budget and leaves others alone", () => {
    const run = makeRun();
    const started = Date.parse(at);
    assert.equal(enforceTeamBudget(run, started + 60_000), null);
    assert.equal(enforceTeamBudget({ ...run, costUsd: 26 }, started)?.status, "over_budget");
    assert.equal(enforceTeamBudget({ ...run, costUsd: null }, started)?.status, "over_budget");
    const late = started + (DEFAULT_TEAM_BUDGET.maxMinutes + 1) * 60_000;
    assert.equal(enforceTeamBudget(run, late)?.status, "over_budget");
    assert.equal(enforceTeamBudget({ ...run, status: "completed" }, late), null);
  });
});
