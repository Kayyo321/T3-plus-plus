import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_TEAM_BUDGET,
  type TeamAction,
  TeamFindingId,
  TeamGrowthRequestId,
  TeamMemberId,
  TeamNodeId,
  TeamRunId,
  type TeamRun,
  TeamSheetId,
  TeamTaskId,
  ThreadId,
} from "@t3tools/contracts";

import { applyTeamAction, enforceTeamBudget, type TeamTransition } from "./teamRunMachine.ts";

const at = "2026-11-01T12:00:00.000Z";
const started = Date.parse(at);
const lead = TeamMemberId.make("lead");
const builder = TeamMemberId.make("build/m1");
const otherBuilder = TeamMemberId.make("build/m2");
const reviewer = TeamMemberId.make("review/m1");
const validator = TeamMemberId.make("validate/m1");
const task = TeamTaskId.make("task-1");
const node = (id: string) => TeamNodeId.make(id);
const position = { x: 0, y: 0 };

const flow: TeamRun["flow"] = {
  sheetName: "Default",
  sheetRevision: 0,
  nestedSessions: true,
  nodes: [
    {
      id: node("lead"),
      name: "Project Lead",
      instructions: "",
      position,
      kind: "lead",
      growth: { mode: "off", scope: "session" },
    },
    {
      id: node("build"),
      name: "Build",
      instructions: "",
      position,
      kind: "build",
      modelChoice: { type: "lead" },
    },
    {
      id: node("review"),
      name: "Review",
      instructions: "",
      position,
      kind: "review",
      modelChoice: { type: "lead" },
    },
    {
      id: node("validate"),
      name: "Validate",
      instructions: "",
      position,
      kind: "validate",
      modelChoice: { type: "lead" },
    },
  ],
  edges: [
    { from: node("lead"), to: node("build"), kind: "handoff" },
    { from: node("build"), to: node("review"), kind: "handoff" },
    { from: node("review"), to: node("validate"), kind: "handoff" },
    { from: node("review"), to: node("build"), kind: "return" },
    { from: node("validate"), to: node("build"), kind: "return" },
  ],
};

const member = (id: TeamMemberId, nodeId: string, kind: TeamRun["members"][number]["kind"]) => ({
  id,
  nodeId: node(nodeId),
  slot: id.split("/").at(-1) ?? "lead",
  kind,
  name: kind,
  threadId: null,
  state: "idle" as const,
});

const makeRun = (overrides: Partial<TeamRun> = {}): TeamRun => ({
  id: TeamRunId.make("run-1"),
  parentThreadId: ThreadId.make("thread-1"),
  sheetId: TeamSheetId.make("default"),
  flow,
  request: "Ship the change",
  leadModel: { instanceId: "codex", model: "unknown" } as TeamRun["leadModel"],
  budget: DEFAULT_TEAM_BUDGET,
  status: "running",
  activeNodeId: null,
  waitingFor: null,
  correctionCycles: 0,
  members: [
    member(lead, "lead", "lead"),
    member(builder, "build", "build"),
    member(otherBuilder, "build", "build"),
    member(reviewer, "review", "review"),
    member(validator, "validate", "validate"),
  ],
  tasks: [],
  notes: [],
  handoffs: [],
  evidence: [],
  verdicts: [],
  growth: [],
  report: null,
  startedAt: at,
  updatedAt: at,
  ...overrides,
});

const apply = (run: TeamRun, action: TeamAction) => applyTeamAction(run, action, at);

const runOf = (transition: TeamTransition): TeamRun => {
  if (!transition.ok) assert.fail(transition.refusal.detail);
  return transition.run;
};

const reasonOf = (transition: TeamTransition) => (transition.ok ? "ok" : transition.refusal.reason);

const upsert = (
  byId: TeamMemberId,
  overrides: Partial<Extract<TeamAction, { type: "task_upsert" }>> = {},
): TeamAction => ({
  type: "task_upsert",
  byId,
  taskId: task,
  objective: "Ship the parser",
  acceptanceCriteria: ["parser handles empty input"],
  ...overrides,
});

const handoffAction = (fromId: TeamMemberId): TeamAction => ({
  type: "handoff",
  fromId,
  taskId: task,
  changed: "parser",
  where: "src/parser.ts",
  requirements: "empty input",
  checked: "unit tests",
  uncertain: "none",
});

const verdictAction = (
  byId: TeamMemberId,
  outcome: "pass" | "changes_required" | "fail" | "blocked",
  overrides: Partial<Extract<TeamAction, { type: "verdict" }>> = {},
): TeamAction => ({
  type: "verdict",
  byId,
  taskId: task,
  version: 1,
  outcome,
  limitations: "",
  ...overrides,
});

const passingCheck = {
  type: "evidence",
  byId: validator,
  taskId: task,
  command: "vp test run parser",
  output: "1 passed",
  passed: true,
} as const;

/** A task built and handed off, ready for review at version 1. */
const reviewReady = () => {
  let run = makeRun();
  run = runOf(apply(run, upsert(lead)));
  run = runOf(apply(run, handoffAction(builder)));
  return run;
};

describe("applyTeamAction", () => {
  it("refuses every action on a closed run", () => {
    for (const status of ["stopped", "done"] as const) {
      const closed = makeRun({ status });
      assert.equal(reasonOf(apply(closed, upsert(lead))), "run_closed");
      assert.equal(
        reasonOf(apply(closed, { type: "owner_resume", budget: DEFAULT_TEAM_BUDGET })),
        "run_closed",
      );
    }
  });

  it("refuses a non-member actor", () => {
    const stranger = TeamMemberId.make("stranger");
    assert.equal(reasonOf(apply(makeRun(), upsert(stranger))), "not_a_member");
    assert.equal(reasonOf(apply(makeRun(), handoffAction(stranger))), "not_a_member");
  });

  describe("advance", () => {
    const advanceTo = (byId: TeamMemberId, toNodeId: string): TeamAction => ({
      type: "advance",
      byId,
      toNodeId: node(toNodeId),
    });

    it("lets only the lead move along a handoff edge", () => {
      assert.equal(reasonOf(apply(makeRun(), advanceTo(builder, "build"))), "not_lead");
      const moved = runOf(apply(makeRun(), advanceTo(lead, "build")));
      assert.equal(moved.activeNodeId, "build");
    });

    it("refuses a target that no handoff edge reaches", () => {
      assert.equal(reasonOf(apply(makeRun(), advanceTo(lead, "validate"))), "wrong_phase");
      const atBuild = makeRun({ activeNodeId: node("build") });
      assert.equal(reasonOf(apply(atBuild, advanceTo(lead, "lead"))), "wrong_phase");
      assert.equal(reasonOf(apply(atBuild, advanceTo(lead, "review"))), "ok");
    });

    it("refuses while the run waits for its owner or is blocked", () => {
      for (const status of ["awaiting_owner", "blocked", "over_budget"] as const) {
        const parked = makeRun({ status, waitingFor: "Wait." });
        assert.equal(reasonOf(apply(parked, advanceTo(lead, "build"))), "wrong_phase");
      }
    });
  });

  describe("task_upsert", () => {
    it("needs an objective for a new task", () => {
      const withoutObjective = upsert(lead, { objective: undefined });
      assert.equal(reasonOf(apply(makeRun(), withoutObjective)), "not_found");
    });

    it("starts a new task queued at version 0 with empty findings and builtBy", () => {
      const created = runOf(apply(makeRun(), upsert(lead)));
      assert.deepStrictEqual(created.tasks[0]?.status, "queued");
      assert.deepStrictEqual(
        { version: created.tasks[0]?.version, corrections: created.tasks[0]?.corrections },
        { version: 0, corrections: 0 },
      );
      assert.deepStrictEqual(created.tasks[0]?.findings, []);
      assert.deepStrictEqual(created.tasks[0]?.builtBy, []);
    });

    it("records a build member as builder when assigned", () => {
      const assigned = runOf(apply(makeRun(), upsert(lead, { ownerId: builder })));
      assert.deepStrictEqual(assigned.tasks[0]?.builtBy, [builder]);
    });

    it("refuses a status a verdict or handoff owns", () => {
      const created = runOf(apply(makeRun(), upsert(lead)));
      assert.equal(reasonOf(apply(created, upsert(lead, { status: "done" }))), "wrong_phase");
      assert.equal(reasonOf(apply(created, upsert(lead, { status: "building" }))), "ok");
    });
  });

  describe("handoff", () => {
    it("lets a build member or the owner hand off, and bumps the version", () => {
      const built = reviewReady();
      assert.equal(built.tasks[0]?.version, 1);
      assert.equal(built.tasks[0]?.status, "reviewing");
      assert.deepStrictEqual(built.tasks[0]?.builtBy, [builder]);
      assert.equal(built.activeNodeId, "review");
      assert.equal(built.handoffs[0]?.version, 1);
    });

    it("refuses a reviewer who owns nothing", () => {
      const withTask = runOf(apply(makeRun(), upsert(lead)));
      assert.equal(reasonOf(apply(withTask, handoffAction(reviewer))), "not_a_member");
    });

    it("refuses an unknown task", () => {
      const unknown = { ...handoffAction(builder), taskId: TeamTaskId.make("nope") };
      assert.equal(reasonOf(apply(makeRun(), unknown)), "not_found");
    });
  });

  describe("verdict", () => {
    it("refuses a judge's verdict on work it built", () => {
      const owned = runOf(apply(makeRun(), upsert(lead, { ownerId: reviewer })));
      const built = runOf(apply(owned, handoffAction(reviewer)));
      assert.equal(reasonOf(apply(built, verdictAction(reviewer, "pass"))), "self_approval");
    });

    it("refuses a verdict on a stale version", () => {
      const built = reviewReady();
      assert.equal(
        reasonOf(apply(built, verdictAction(reviewer, "pass", { version: 0 }))),
        "wrong_phase",
      );
    });

    it("limits each judge kind to its own outcomes", () => {
      const cases = [
        { judge: reviewer, outcome: "blocked", reason: "wrong_phase" },
        { judge: reviewer, outcome: "fail", reason: "wrong_phase" },
        { judge: validator, outcome: "changes_required", reason: "wrong_phase" },
        { judge: validator, outcome: "pass", reason: "needs_verdict" },
      ] as const;
      const built = reviewReady();
      for (const { judge, outcome, reason } of cases) {
        assert.equal(reasonOf(apply(built, verdictAction(judge, outcome))), reason);
      }
    });

    it("sends changes required back to build through the return edge", () => {
      const built = reviewReady();
      const returned = runOf(apply(built, verdictAction(reviewer, "changes_required")));
      assert.equal(returned.tasks[0]?.status, "building");
      assert.equal(returned.tasks[0]?.corrections, 1);
      assert.equal(returned.correctionCycles, 1);
      assert.equal(returned.activeNodeId, "build");
    });

    it("moves a passed review on to validate", () => {
      const built = reviewReady();
      const passed = runOf(apply(built, verdictAction(reviewer, "pass")));
      assert.equal(passed.tasks[0]?.status, "validating");
      assert.equal(passed.activeNodeId, "validate");
    });

    it("refuses a review pass while a blocking finding is open, and numbers new findings", () => {
      const built = reviewReady();
      const finding = {
        severity: "blocking" as const,
        problem: "empty input throws",
        impact: "crash",
        evidence: "parser.ts:10",
        resolvedWhen: "empty input returns []",
      };
      assert.equal(
        reasonOf(apply(built, verdictAction(reviewer, "pass", { findings: [finding] }))),
        "failed_checks",
      );
      const flagged = runOf(
        apply(built, verdictAction(reviewer, "changes_required", { findings: [finding] })),
      );
      assert.equal(flagged.tasks[0]?.findings[0]?.id, "task-1-f1");
      assert.equal(flagged.tasks[0]?.findings[0]?.status, "open");
    });

    it("records a blocked validation on the task, with the lead as the next node", () => {
      const reviewed = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const blocked = runOf(
        apply(reviewed, verdictAction(validator, "blocked", { limitations: "no test runner" })),
      );
      assert.equal(blocked.tasks[0]?.status, "blocked");
      assert.equal(blocked.tasks[0]?.blocker, "no test runner");
      assert.equal(blocked.activeNodeId, "lead");
    });

    it("needs a review pass on the same version before a validate pass", () => {
      const built = reviewReady();
      const validatorPass = verdictAction(validator, "pass", {
        criteria: [{ criterion: "parser handles empty input", result: "pass", evidence: "ok" }],
      });
      assert.equal(reasonOf(apply(built, validatorPass)), "needs_verdict");
      const reviewed = runOf(apply(built, verdictAction(reviewer, "pass")));
      assert.equal(reasonOf(apply(reviewed, validatorPass)), "needs_evidence");
    });

    it("finishes a task on a validate pass with criteria, clear findings, and passing evidence", () => {
      const validating = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const withCheck = runOf(apply(validating, passingCheck));
      const covered = verdictAction(validator, "pass", {
        criteria: [{ criterion: "parser handles empty input", result: "pass", evidence: "ok" }],
      });
      const done = runOf(apply(withCheck, covered));
      assert.equal(done.tasks[0]?.status, "done");
      assert.equal(done.activeNodeId, "lead");
    });

    it("refuses a validate pass that leaves criteria unverified or lacks evidence", () => {
      const validating = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const withCheck = runOf(apply(validating, passingCheck));
      const unverified = verdictAction(validator, "pass", {
        criteria: [{ criterion: "parser handles empty input", result: "unverified", evidence: "" }],
      });
      assert.equal(reasonOf(apply(withCheck, unverified)), "needs_evidence");
      const covered = verdictAction(validator, "pass", {
        criteria: [{ criterion: "parser handles empty input", result: "pass", evidence: "ok" }],
      });
      assert.equal(reasonOf(apply(validating, covered)), "needs_evidence");
    });

    it("counts a command whose latest run failed as not standing", () => {
      const validating = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const passedThenFailed = [
        passingCheck,
        { ...passingCheck, passed: false, output: "1 failed" },
      ].reduce((run, action) => runOf(apply(run, action)), validating);
      const covered = verdictAction(validator, "pass", {
        criteria: [{ criterion: "parser handles empty input", result: "pass", evidence: "ok" }],
      });
      assert.equal(reasonOf(apply(passedThenFailed, covered)), "needs_evidence");
    });

    it("sends a fail back to build and blocks the run once correction cycles exceed the budget", () => {
      const validating = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const capped = makeRun({
        ...validating,
        budget: { ...DEFAULT_TEAM_BUDGET, maxCorrectionCycles: 0 },
      });
      const failed = runOf(apply(capped, verdictAction(validator, "fail")));
      assert.equal(failed.status, "blocked");
      assert.match(failed.waitingFor ?? "", /correction cycles/);
    });

    it("writes a decision note when a task reaches two corrections", () => {
      let run = reviewReady();
      for (let cycle = 0; cycle < 2; cycle++) {
        const version = run.tasks[0]?.version ?? 0;
        run = runOf(apply(run, verdictAction(reviewer, "changes_required", { version })));
        run = runOf(apply(run, handoffAction(builder)));
      }
      assert.equal(run.tasks[0]?.corrections, 2);
      assert.deepStrictEqual(
        run.notes.map((note) => note.kind),
        ["decision"],
      );
    });
  });

  describe("finding_update", () => {
    it("lets only the lead resolve a finding", () => {
      const flagged = runOf(
        apply(
          reviewReady(),
          verdictAction(reviewer, "changes_required", {
            findings: [
              {
                severity: "suggestion",
                problem: "rename",
                impact: "",
                evidence: "",
                resolvedWhen: "renamed",
              },
            ],
          }),
        ),
      );
      const update = (byId: TeamMemberId): TeamAction => ({
        type: "finding_update",
        byId,
        taskId: task,
        findingId: TeamFindingId.make("task-1-f1"),
        status: "accepted",
      });
      assert.equal(reasonOf(apply(flagged, update(reviewer))), "not_lead");
      assert.equal(runOf(apply(flagged, update(lead))).tasks[0]?.findings[0]?.status, "accepted");
    });
  });

  describe("report", () => {
    const doneRun = () => {
      const validating = runOf(apply(reviewReady(), verdictAction(reviewer, "pass")));
      const withCheck = runOf(apply(validating, passingCheck));
      return runOf(
        apply(
          withCheck,
          verdictAction(validator, "pass", {
            criteria: [{ criterion: "parser handles empty input", result: "pass", evidence: "ok" }],
          }),
        ),
      );
    };
    const report = (byId: TeamMemberId, notVerified: string[] = []): TeamAction => ({
      type: "report",
      byId,
      report: { summary: "Done", verified: ["parser"], notVerified, openRisks: [] },
    });

    it("lets only the lead write the report, once every task is done", () => {
      assert.equal(reasonOf(apply(doneRun(), report(builder))), "not_lead");
      assert.equal(reasonOf(apply(reviewReady(), report(lead))), "wrong_phase");
    });

    it("finishes the run and clears the wait", () => {
      const finished = runOf(apply(doneRun(), report(lead)));
      assert.equal(finished.status, "done");
      assert.equal(finished.activeNodeId, null);
      assert.equal(finished.waitingFor, null);
    });

    it("refuses a report that hides a check which failed and has not passed since", () => {
      const failing = runOf(apply(doneRun(), { ...passingCheck, passed: false, output: "boom" }));
      assert.equal(reasonOf(apply(failing, report(lead))), "failed_checks");
      assert.equal(reasonOf(apply(failing, report(lead, [passingCheck.command]))), "ok");
    });
  });

  describe("owner actions", () => {
    it("stops a run with the reason", () => {
      const stopped = runOf(apply(makeRun(), { type: "owner_stop", reason: "Enough." }));
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.waitingFor, "Enough.");
    });

    it("resumes over budget without a reset, and from blocked with correction cycles reset", () => {
      const over = makeRun({ status: "over_budget", waitingFor: "Budget.", correctionCycles: 2 });
      assert.equal(
        runOf(apply(over, { type: "owner_resume", budget: DEFAULT_TEAM_BUDGET })).correctionCycles,
        2,
      );
      const blocked = makeRun({ status: "blocked", waitingFor: "Cycles.", correctionCycles: 4 });
      const resumed = runOf(apply(blocked, { type: "owner_resume", budget: DEFAULT_TEAM_BUDGET }));
      assert.deepStrictEqual([resumed.status, resumed.correctionCycles], ["running", 0]);
    });

    it("refuses resume from a run that is not parked, and resume that would park again", () => {
      assert.equal(
        reasonOf(apply(makeRun(), { type: "owner_resume", budget: DEFAULT_TEAM_BUDGET })),
        "wrong_phase",
      );
      const exhausted = makeRun({ status: "over_budget", costUsd: 30 });
      assert.equal(
        reasonOf(apply(exhausted, { type: "owner_resume", budget: DEFAULT_TEAM_BUDGET })),
        "budget",
      );
    });

    it("refuses a growth answer with no waiting request", () => {
      const answer: TeamAction = {
        type: "owner_growth_answer",
        requestId: TeamGrowthRequestId.make("g1"),
        allow: true,
      };
      assert.equal(reasonOf(apply(makeRun(), answer)), "growth_refused");
    });

    it("records a denial with the owner's reason and returns to running", () => {
      const requestId = TeamGrowthRequestId.make("g1");
      const waiting = makeRun({
        status: "awaiting_owner",
        waitingFor: "Answer growth.",
        growth: [
          {
            id: requestId,
            nodeId: node("build"),
            fromId: builder,
            capacity: "a second tester",
            why: "more coverage",
            tried: "the existing tester",
            status: "awaiting_owner",
            decidedBy: null,
            reason: null,
            memberId: null,
            scope: null,
            requestedAt: at,
            decidedAt: null,
          },
        ],
      });
      const denied = runOf(
        apply(waiting, {
          type: "owner_growth_answer",
          requestId,
          allow: false,
          note: "Not this run.",
        }),
      );
      assert.deepStrictEqual(
        [denied.growth[0]?.status, denied.growth[0]?.decidedBy, denied.growth[0]?.reason],
        ["denied", "owner", "Not this run."],
      );
      assert.deepStrictEqual([denied.status, denied.waitingFor], ["running", null]);
    });
  });

  it("keeps the last 4000 characters of evidence output", () => {
    const long = "x".repeat(5_000);
    const recorded = runOf(apply(makeRun(), { ...passingCheck, output: long, taskId: undefined }));
    assert.equal(recorded.evidence[0]?.output.length, 4_000);
  });
});

describe("enforceTeamBudget", () => {
  const run = makeRun({ costUsd: 5 });

  it("parks a running run that passed its minutes or cost budget", () => {
    assert.equal(enforceTeamBudget(run, started + 60_000), null);
    assert.equal(enforceTeamBudget({ ...run, costUsd: 26 }, started)?.status, "over_budget");
    assert.equal(enforceTeamBudget({ ...run, costUsd: null }, started)?.status, "over_budget");
    assert.equal(enforceTeamBudget(run, started + 241 * 60_000)?.status, "over_budget");
    assert.equal(enforceTeamBudget({ ...run, status: "done" }, started + 241 * 60_000), null);
  });
});
