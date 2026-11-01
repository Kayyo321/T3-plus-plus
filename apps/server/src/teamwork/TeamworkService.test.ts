import { ScheduledRunCostEstimator } from "../scheduledTasks/ScheduledTaskService.ts";
import { makeSecretMask } from "@t3tools/shared/secretRedaction";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_TEAM_BUDGET,
  ProviderInstanceId,
  TeamMemberId,
  ThreadId,
  type AuditEntryInput,
  type NestedSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AuditTrail from "../audit/AuditTrail.ts";
import * as NestedSessionService from "../orchestration-v2/NestedSessionService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TeamworkService from "./TeamworkService.ts";

const parent = ThreadId.make("parent");
const owner = { kind: "user", createdBy: "user", creationSource: "web" } as const;
const startInput = {
  parentThreadId: parent,
  presetId: "build-a-feature",
  request: "Fix the parser",
  dial: "approve_plan",
} as const;

const harness = (pricedCost?: number | null) => {
  const started: Array<NestedSessionStartInput> = [];
  const stopped: Array<ThreadId> = [];
  const recorded: Array<AuditEntryInput> = [];
  const layer = TeamworkService.layer.pipe(
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(AuditTrail.AuditTrail)({
          record: (entry) =>
            Effect.sync(() => {
              recorded.push(entry);
            }),
        }),
        Layer.mock(NestedSessionService.NestedSessionService)({
          start: (input) =>
            Effect.sync(() => {
              started.push(input);
              return { threadId: input.threadId, projectId: "project" as never, runId: null };
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed(
              (pricedCost === undefined
                ? { attempts: [], runs: [], providerTurns: [] }
                : {
                    attempts: [{ id: "attempt", runId: "run" }],
                    runs: [{ id: "run", modelSelection: { model: "test-model" } }],
                    providerTurns: [
                      { runAttemptId: "attempt", tokenUsage: { inputTokens: 10, outputTokens: 1 } },
                    ],
                  }) as never,
            ),
          getThreadShell: (id) =>
            Effect.succeed({
              id,
              activeRunId: started.some((input) => input.threadId === id) ? "active" : null,
              runtimeMode: "approval-required",
              interactionMode: "default",
            } as never),
          forceStopThread: (input) =>
            Effect.sync(() => {
              stopped.push(input.threadId);
              return {} as never;
            }),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(ScheduledRunCostEstimator, () => Effect.succeed(pricedCost ?? null)),
    ),
  );
  return { layer, started, stopped, recorded };
};

it.effect("persists the board, binds member identity, and keeps owner gates user-only", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* TeamworkService.TeamworkService;
    const invalid = yield* service
      .start(
        {
          ...startInput,
          roles: [
            { role: "lead", count: 1 },
            { role: "builder", count: 1 },
          ],
        },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(invalid.reason, "invalid_team");
    const selection = { instanceId: ProviderInstanceId.make("chosen"), model: "small" };
    const run = yield* service.start(
      {
        ...startInput,
        roles: [
          { role: "lead", count: 1, modelSelection: selection },
          { role: "builder", count: 1 },
          { role: "tester", count: 1 },
          { role: "reviewer", count: 1 },
        ],
      },
      owner,
    );
    const earlyBuilder = yield* service
      .startMember(
        { runId: run.id, memberId: TeamMemberId.make("builder-1"), message: "Build" },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(earlyBuilder.reason, "wrong_phase");
    const lead = run.members[0];
    assert.isDefined(lead);
    const launched = yield* service.startMember(
      { runId: run.id, memberId: TeamMemberId.make("lead-1"), message: "Plan" },
      owner,
    );
    assert.equal(h.started[0]?.runtimeMode, "approval-required");
    assert.deepEqual(h.started[0]?.modelSelection, selection);
    const threadId = launched.members[0]?.threadId;
    assert.isNotNull(threadId);
    const caller = {
      kind: "agent",
      createdBy: "agent",
      creationSource: "mcp",
      threadId: threadId!,
    } as const;
    const spoofed = yield* service
      .act(
        {
          runId: run.id,
          action: {
            type: "note",
            byId: TeamMemberId.make("tester-1"),
            kind: "decision",
            text: "Spoofed",
          },
        },
        caller,
      )
      .pipe(Effect.flip);
    assert.equal(spoofed.reason, "not_a_member");
    const approval = yield* service
      .act({ runId: run.id, action: { type: "owner_approve" } }, caller)
      .pipe(Effect.flip);
    assert.equal(approval.reason, "not_a_member");
    yield* service.act(
      {
        runId: run.id,
        action: {
          type: "note",
          byId: TeamMemberId.make("lead-1"),
          kind: "plan",
          text: "Actual plan",
        },
      },
      caller,
    );
    assert.equal(
      (yield* service.list({ parentThreadId: parent })).runs[0]?.notes[0]?.text,
      "Actual plan",
    );
    assert.equal((yield* service.listForCaller(ThreadId.make("unrelated"))).runs.length, 0);
    assert.equal((yield* service.listForCaller(threadId!)).runs.length, 1);
    assert.deepEqual(
      h.recorded.map((entry) => entry.action),
      ["start", "member.start", "note"],
    );
  }).pipe(Effect.provide(h.layer));
});

it.effect("caps member starts and stops active members when time runs out", () => {
  const h = harness();
  return Effect.gen(function* () {
    const service = yield* TeamworkService.TeamworkService;
    const run = yield* service.start(
      { ...startInput, budget: { ...DEFAULT_TEAM_BUDGET, maxMinutes: 1, maxParallelAgents: 1 } },
      owner,
    );
    yield* service.startMember(
      { runId: run.id, memberId: TeamMemberId.make("lead-1"), message: "Plan" },
      owner,
    );
    const capped = yield* service
      .startMember(
        { runId: run.id, memberId: TeamMemberId.make("reviewer-1"), message: "Review" },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(capped.reason, "budget");
    yield* TestClock.adjust("2 minutes");
    yield* service.checkBudgets;
    assert.equal((yield* service.list({})).runs[0]?.status, "over_budget");
    assert.equal(h.stopped.length, 1);
    const denied = yield* service
      .act({ runId: run.id, action: { type: "advance", byId: TeamMemberId.make("lead-1") } }, owner)
      .pipe(Effect.flip);
    assert.equal(denied.reason, "budget");
  }).pipe(Effect.provide(h.layer));
});

it.effect("masks known secrets before saving or returning board content", () => {
  const h = harness();
  const mask = makeSecretMask([{ name: "EXAMPLE_KEY", value: "fake-workspace-credential" }]);
  return Effect.gen(function* () {
    const service = yield* TeamworkService.TeamworkService;
    const run = yield* service.start(
      { ...startInput, request: "Handle fake-workspace-credential" },
      owner,
    );
    assert.equal(run.request, "Handle [secret:EXAMPLE_KEY]");
    const changed = yield* service.act(
      {
        runId: run.id,
        action: {
          type: "note",
          byId: TeamMemberId.make("lead-1"),
          kind: "plan",
          text: "Output fake-workspace-credential",
        },
      },
      owner,
    );
    assert.equal(changed.notes[0]?.text, "Output [secret:EXAMPLE_KEY]");
    assert.notInclude(JSON.stringify(yield* service.list({})), "fake-workspace-credential");
  }).pipe(
    Effect.provide(h.layer),
    Effect.provideService(WorkspaceProcessEnvironment.ActiveSecretMasks, {
      add: () => () => {},
      redactDeep: mask.redactDeep,
    }),
  );
});

it.effect.each([2, null])(
  "parks cost-limited work with measured cost %s and requires owner resumption",
  (cost) => {
    const h = harness(cost);
    return Effect.gen(function* () {
      const service = yield* TeamworkService.TeamworkService;
      const run = yield* service.start(
        { ...startInput, budget: { ...DEFAULT_TEAM_BUDGET, maxCostUsd: 1 } },
        owner,
      );
      yield* service.startMember(
        { runId: run.id, memberId: TeamMemberId.make("lead-1"), message: "Plan" },
        owner,
      );
      yield* service.checkBudgets;
      const parked = (yield* service.list({})).runs[0];
      assert.equal(parked?.status, "over_budget");
      assert.equal(parked?.costUsd, cost);
      assert.equal(h.stopped.length, 1);
      const resumed = yield* service.act(
        {
          runId: run.id,
          action: {
            type: "owner_resume",
            budget: { maxMinutes: 240, maxParallelAgents: 4, maxReviewLoops: 3 },
          },
        },
        owner,
      );
      assert.equal(resumed.status, "running");
    }).pipe(Effect.provide(h.layer));
  },
);
