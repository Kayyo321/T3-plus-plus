import { ScheduledRunCostEstimator } from "../scheduledTasks/ScheduledTaskService.ts";
import { makeSecretMask } from "@t3tools/shared/secretRedaction";
import { DEFAULT_TEAM_SHEET } from "@t3tools/shared/teamSheets";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  DEFAULT_TEAM_BUDGET,
  DEFAULT_TEAM_SHEET_ID,
  ProviderInstanceId,
  RunId,
  TeamNodeId,
  ThreadId,
  type AuditEntryInput,
  type ModelSelection,
  type NestedSessionStartInput,
  type TeamGrowth,
  type TeamSheet,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AuditTrail from "../audit/AuditTrail.ts";
import * as NestedSessionService from "../orchestration-v2/NestedSessionService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TeamworkService from "./TeamworkService.ts";
import * as TeamworkStore from "./TeamworkStore.ts";

const parent = ThreadId.make("parent");
const owner = { kind: "user", createdBy: "user", creationSource: "web" } as const;
const lead = {
  kind: "agent",
  createdBy: "agent",
  creationSource: "mcp",
  threadId: parent,
} as const;
const build = TeamNodeId.make("build");
const review = TeamNodeId.make("review");
const leadModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };

const harness = (
  options: {
    readonly capabilityMode?: "chat" | "code";
    readonly pricedCost?: number | null;
    /** When the priced turn ran, to tell a run's own turns from an earlier round's. */
    readonly turnAt?: number;
  } = {},
) => {
  const started: Array<NestedSessionStartInput> = [];
  const launched: Array<ThreadLaunchService.ThreadLaunchInput> = [];
  const sent: Array<ThreadManagementService.ThreadManagementSendInput> = [];
  const dispatched: Array<{ readonly type: string; readonly threadId?: ThreadId }> = [];
  const interrupted: Array<ThreadId> = [];
  const recorded: Array<AuditEntryInput> = [];
  const shells = new Map<ThreadId, Record<string, unknown>>();
  const addShell = (id: ThreadId, modelSelection: ModelSelection = leadModel) =>
    shells.set(id, {
      id,
      projectId: "project",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      capabilityMode: "code",
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      branch: null,
      worktreePath: null,
      activeRunId: null,
      archivedAt: null,
      deletedAt: null,
    });
  addShell(parent);
  shells.set(parent, { ...shells.get(parent), capabilityMode: options.capabilityMode ?? "code" });
  const layer = TeamworkService.layer.pipe(
    Layer.provideMerge(TeamworkStore.layer),
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
              addShell(input.threadId, input.modelSelection);
              return { threadId: input.threadId, projectId: "project" as never, runId: null };
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input);
              addShell(input.threadId!, input.modelSelection);
              return {} as never;
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed(
              (options.pricedCost === undefined
                ? { attempts: [], runs: [], providerTurns: [] }
                : {
                    attempts: [{ id: "attempt", runId: "run" }],
                    runs: [
                      {
                        id: "run",
                        modelSelection: { model: "test-model" },
                        requestedAt: DateTime.makeUnsafe(options.turnAt ?? 0),
                      },
                    ],
                    providerTurns: [
                      { runAttemptId: "attempt", tokenUsage: { inputTokens: 10, outputTokens: 1 } },
                    ],
                  }) as never,
            ),
          getThreadShell: (id) => Effect.succeed((shells.get(id) ?? null) as never),
          assertProviderInstanceEnabled: () => Effect.void,
          sendToThread: (input) =>
            Effect.sync(() => {
              sent.push(input);
              return {} as never;
            }),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command as never);
              return { sequence: 1 } as never;
            }),
          interruptThread: (input) =>
            Effect.sync(() => {
              interrupted.push(input.threadId);
              return { type: "no_active_run" } as never;
            }),
        }),
      ),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.succeed(ScheduledRunCostEstimator, () => Effect.succeed(options.pricedCost ?? null)),
    ),
  );
  return { layer, started, launched, sent, dispatched, interrupted, recorded, shells, addShell };
};

const service = TeamworkService.TeamworkService;

/** One message's worth of work: a run, staffed or re-invoked, then closed by the owner. */
const round = Effect.fn(function* (sheetId: TeamSheet["id"] = DEFAULT_TEAM_SHEET_ID) {
  const teamwork = yield* service;
  const run = yield* teamwork.start(
    { parentThreadId: parent, request: "Fix the parser", sheetId },
    owner,
  );
  yield* teamwork.startMember({ runId: run.id, nodeId: build, message: "Build it" }, lead);
  yield* teamwork.startMember({ runId: run.id, nodeId: build, slot: "m1", message: "Part" }, lead);
  const staffed = yield* teamwork.startMember(
    { runId: run.id, nodeId: review, message: "Review it" },
    lead,
  );
  yield* teamwork.act(
    { runId: run.id, action: { type: "owner_stop", reason: "Round over" } },
    owner,
  );
  return staffed;
});

const editableSheet = Effect.fn(function* (growth: TeamGrowth = { mode: "off", scope: "session" }) {
  const teamwork = yield* service;
  const sheet = yield* teamwork.createSheet({ name: "Mine" }, owner);
  return yield* teamwork.updateSheet(
    {
      sheetId: sheet.id,
      baseRevision: sheet.revision,
      changes: [{ type: "update_node", nodeId: TeamNodeId.make("lead"), growth }],
    },
    owner,
  );
});

const threadsOf = (run: { readonly members: ReadonlyArray<{ readonly threadId: unknown }> }) =>
  run.members.map((member) => member.threadId);

it.effect("re-invokes the same sessions on a second round and starts none", () => {
  const h = harness();
  return Effect.gen(function* () {
    const first = yield* round();
    assert.equal(h.started.length, 3);
    const second = yield* round();
    assert.equal(h.started.length, 3);
    assert.deepEqual(threadsOf(second), threadsOf(first));
    assert.notEqual(second.id, first.id);
    assert.deepEqual(
      h.sent.map((input) => input.threadId),
      first.members.flatMap((member) =>
        member.threadId === null || member.threadId === parent ? [] : [member.threadId],
      ),
    );
    assert.isTrue(h.sent.every((input) => input.mode === "queue"));
  }).pipe(Effect.provide(h.layer));
});

it.effect(
  "nests a member under its team, its team under the thread, with worktrees for builders",
  () => {
    const h = harness();
    return Effect.gen(function* () {
      yield* round();
      const [team, member, reviewer] = h.started;
      assert.equal(team?.parentThreadId, parent);
      assert.equal(member?.parentThreadId, team?.threadId);
      assert.deepEqual(team?.workspace, { type: "worktree" });
      assert.deepEqual(member?.workspace, { type: "worktree" });
      assert.deepEqual(reviewer?.workspace, { type: "shared" });
      assert.equal(team?.inherit.type, "summary");
      assert.notInclude(String(team?.threadId), "teamwork:");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("refuses to add to a staffed team on a later round", () => {
  const h = harness();
  return Effect.gen(function* () {
    yield* round();
    const teamwork = yield* service;
    const run = yield* teamwork.start({ parentThreadId: parent, request: "More" }, owner);
    const refused = yield* teamwork
      .startMember({ runId: run.id, nodeId: build, slot: "m2", message: "Extra" }, lead)
      .pipe(Effect.flip);
    assert.equal(refused.reason, "roster_fixed");
    assert.equal(h.started.length, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect("keeps a session through a rename and through Off then On", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const sheet = yield* editableSheet();
    const first = yield* round(sheet.id);
    yield* teamwork.updateSheet(
      {
        sheetId: sheet.id,
        baseRevision: sheet.revision,
        changes: [{ type: "update_node", nodeId: build, name: "Makers" }],
      },
      owner,
    );
    yield* teamwork.setThreadSheet({ threadId: parent, sheetId: sheet.id }, owner);
    yield* teamwork.setThreadSheet({ threadId: parent, sheetId: null }, owner);
    yield* teamwork.setThreadSheet({ threadId: parent, sheetId: sheet.id }, owner);
    const second = yield* round(sheet.id);
    assert.equal(h.started.length, 3);
    assert.deepEqual(threadsOf(second), threadsOf(first));
    assert.equal(second.members.find((member) => member.nodeId === build)?.name, "Makers");
  }).pipe(Effect.provide(h.layer));
});

it.effect("leaves a removed node's session in place and says so on the run", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const sheet = yield* editableSheet();
    const first = yield* round(sheet.id);
    const reviewer = first.members.find((member) => member.nodeId === review);
    yield* teamwork.updateSheet(
      {
        sheetId: sheet.id,
        baseRevision: sheet.revision,
        changes: [
          { type: "remove_node", nodeId: review },
          {
            type: "connect",
            edge: { from: build, to: TeamNodeId.make("validate"), kind: "handoff" },
          },
        ],
      },
      owner,
    );
    const next = yield* teamwork.start(
      { parentThreadId: parent, request: "Again", sheetId: sheet.id },
      owner,
    );
    const kept = next.members.find((member) => member.id === reviewer?.id);
    assert.equal(kept?.state, "removed");
    assert.equal(kept?.threadId, reviewer?.threadId);
    assert.isTrue(next.notes.some((note) => note.kind === "roster"));
    assert.equal(h.sent.length, 0);
    assert.isFalse(h.interrupted.includes(reviewer?.threadId as ThreadId));
  }).pipe(Effect.provide(h.layer));
});

it.effect("restores an archived session before sending to it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const first = yield* round();
    const team = first.members.find((member) => member.nodeId === review)?.threadId as ThreadId;
    h.shells.set(team, { ...h.shells.get(team), archivedAt: DateTime.makeUnsafe(0) });
    yield* round();
    assert.deepEqual(
      h.dispatched.filter((command) => command.type === "thread.unarchive").map((c) => c.threadId),
      [team],
    );
    assert.equal(h.started.length, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect("blocks a deleted session's slot until the owner replaces it", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const first = yield* round();
    const reviewer = first.members.find((member) => member.nodeId === review)!;
    h.shells.delete(reviewer.threadId!);
    const run = yield* teamwork.start({ parentThreadId: parent, request: "Again" }, owner);
    const blocked = yield* teamwork
      .startMember({ runId: run.id, nodeId: review, message: "Review" }, lead)
      .pipe(Effect.flip);
    assert.equal(blocked.reason, "slot_blocked");
    assert.equal(h.started.length, 3);
    const board = (yield* teamwork.list({ parentThreadId: parent })).runs[0];
    assert.equal(board?.members.find((m) => m.id === reviewer.id)?.state, "blocked");
    const notLead = yield* teamwork
      .replaceSlot({ threadId: parent, sheetId: run.sheetId, nodeId: review, slot: "team" }, lead)
      .pipe(Effect.flip);
    assert.equal(notLead.reason, "not_a_member");
    yield* teamwork.replaceSlot(
      { threadId: parent, sheetId: run.sheetId, nodeId: review, slot: "team" },
      owner,
    );
    yield* teamwork.startMember({ runId: run.id, nodeId: review, message: "Review" }, lead);
    assert.equal(h.started.length, 4);
  }).pipe(Effect.provide(h.layer));
});

it.effect("switches a bound session's model and keeps the session", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const first = yield* round();
    const run = yield* teamwork.start({ parentThreadId: parent, request: "Again" }, owner);
    yield* teamwork.startMember(
      {
        runId: run.id,
        nodeId: review,
        message: "Review",
        modelSelection: { ...leadModel, model: "smaller" },
      },
      lead,
    );
    const reviewer = first.members.find((member) => member.nodeId === review)?.threadId;
    expect(h.dispatched.filter((c) => c.type === "thread.model-selection.set")).toMatchObject([
      { threadId: reviewer, modelSelection: { model: "smaller" } },
    ]);
    assert.equal(h.started.length, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect("holds a team to its model option and snapshots the lead's model", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const pinned = { type: "pinned", instanceId: leadModel.instanceId, model: "fixed" } as const;
    const sheet = yield* editableSheet();
    yield* teamwork.updateSheet(
      {
        sheetId: sheet.id,
        baseRevision: sheet.revision,
        changes: [{ type: "update_node", nodeId: build, modelChoice: pinned }],
      },
      owner,
    );
    const run = yield* teamwork.start(
      { parentThreadId: parent, request: "Go", sheetId: sheet.id },
      owner,
    );
    assert.deepEqual(run.leadModel, leadModel);
    const refused = yield* teamwork
      .startMember(
        {
          runId: run.id,
          nodeId: build,
          message: "Build",
          modelSelection: { ...leadModel, model: "other" },
        },
        lead,
      )
      .pipe(Effect.flip);
    assert.equal(refused.reason, "model_not_allowed");
    yield* teamwork.startMember(
      {
        runId: run.id,
        nodeId: build,
        message: "Build",
        modelSelection: { ...leadModel, model: "fixed", options: [] },
      },
      lead,
    );
    assert.equal(h.started[0]?.modelSelection?.model, "fixed");
  }).pipe(Effect.provide(h.layer));
});

it.effect("runs members as plain threads with nested sessions off, under the same roster", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const sheet = yield* editableSheet();
    yield* teamwork.updateSheet(
      {
        sheetId: sheet.id,
        baseRevision: sheet.revision,
        changes: [{ type: "set_nested_sessions", enabled: false }],
      },
      owner,
    );
    yield* round(sheet.id);
    assert.equal(h.started.length, 0);
    assert.equal(h.launched.length, 3);
    yield* round(sheet.id);
    assert.equal(h.launched.length, 3);
  }).pipe(Effect.provide(h.layer));
});

it.effect("refuses teamwork on a chat thread", () => {
  const h = harness({ capabilityMode: "chat" });
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const started = yield* teamwork
      .start({ parentThreadId: parent, request: "Go" }, owner)
      .pipe(Effect.flip);
    assert.equal(started.reason, "chat_thread");
    const enabled = yield* teamwork
      .setThreadSheet({ threadId: parent, sheetId: DEFAULT_TEAM_SHEET_ID }, owner)
      .pipe(Effect.flip);
    assert.equal(enabled.reason, "chat_thread");
  }).pipe(Effect.provide(h.layer));
});

it.effect("keeps a draft's choice for the thread it becomes", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const draft = ThreadId.make("draft");
    yield* teamwork.setThreadSheet({ threadId: draft, sheetId: DEFAULT_TEAM_SHEET_ID }, owner);
    assert.equal((yield* teamwork.threadSheet({ threadId: draft })).sheetName, "Default teamwork");
  }).pipe(Effect.provide(h.layer));
});

it.effect("keeps the default sheet read-only and refuses a stale edit", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const readOnly = yield* teamwork
      .updateSheet(
        {
          sheetId: DEFAULT_TEAM_SHEET_ID,
          baseRevision: 0,
          changes: [{ type: "rename", name: "Mine" }],
        },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(readOnly.reason, "read_only_sheet");
    const gone = yield* teamwork
      .deleteSheet({ sheetId: DEFAULT_TEAM_SHEET_ID, baseRevision: 0 }, owner)
      .pipe(Effect.flip);
    assert.equal(gone.reason, "read_only_sheet");
    const sheet = yield* teamwork.createSheet({ name: "Mine" }, owner);
    yield* teamwork.updateSheet(
      { sheetId: sheet.id, baseRevision: 1, changes: [{ type: "rename", name: "Two" }] },
      owner,
    );
    const stale = yield* teamwork
      .updateSheet(
        { sheetId: sheet.id, baseRevision: 1, changes: [{ type: "rename", name: "Three" }] },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(stale.reason, "revision_conflict");
    const invalid = yield* teamwork
      .updateSheet(
        {
          sheetId: sheet.id,
          baseRevision: 2,
          changes: [{ type: "remove_node", nodeId: review }],
        },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(invalid.reason, "invalid_sheet");
    assert.equal(
      DEFAULT_TEAM_SHEET.revision,
      (yield* teamwork.getSheet({ sheetId: DEFAULT_TEAM_SHEET_ID })).revision,
    );
  }).pipe(Effect.provide(h.layer));
});

const growthRun = Effect.fn(function* (growth: TeamGrowth, budget = DEFAULT_TEAM_BUDGET) {
  const teamwork = yield* service;
  const sheet = yield* editableSheet(growth);
  const run = yield* teamwork.start(
    { parentThreadId: parent, request: "Go", sheetId: sheet.id, budget },
    owner,
  );
  const staffed = yield* teamwork.startMember(
    { runId: run.id, nodeId: build, message: "Build" },
    lead,
  );
  const team = staffed.members.find((member) => member.nodeId === build)!;
  const asTeam = {
    kind: "agent",
    createdBy: "agent",
    creationSource: "mcp",
    threadId: team.threadId!,
  } as const;
  return { teamwork, sheet, run, team, asTeam };
});

const ask = { capacity: "A parser specialist", why: "Nobody knows the grammar", tried: "Reading" };

it.effect("refuses growth while it is off and starts nothing", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, run, asTeam } = yield* growthRun({ mode: "off", scope: "session" });
    const refused = yield* teamwork
      .requestGrowth({ runId: run.id, ...ask }, asTeam)
      .pipe(Effect.flip);
    assert.equal(refused.reason, "growth_off");
    assert.equal(h.started.length, 1);
    assert.equal(h.sent.length, 0);
    const board = (yield* teamwork.list({ parentThreadId: parent })).runs[0];
    assert.equal(board?.growth[0]?.status, "refused");
  }).pipe(Effect.provide(h.layer));
});

it.effect("accepts on the lead's word, starting exactly one session and touching no slot", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, sheet, run, team, asTeam } = yield* growthRun({
      mode: "on",
      scope: "session",
    });
    const filed = yield* teamwork.requestGrowth({ runId: run.id, ...ask }, asTeam);
    assert.equal(h.started.length, 1);
    assert.equal(h.sent[0]?.threadId, parent);
    const requestId = filed.growth[0]!.id;
    const notLead = yield* teamwork
      .decideGrowth(
        { runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" },
        asTeam,
      )
      .pipe(Effect.flip);
    assert.equal(notLead.reason, "not_lead");
    const fromClient = yield* teamwork
      .decideGrowth(
        { runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" },
        owner,
      )
      .pipe(Effect.flip);
    assert.equal(fromClient.reason, "not_lead");
    const decided = yield* teamwork.decideGrowth(
      { runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" },
      lead,
    );
    assert.equal(h.started.length, 2);
    assert.equal(h.started[1]?.parentThreadId, team.threadId);
    assert.deepEqual(h.started[1]?.workspace, { type: "worktree" });
    assert.equal(decided.growth[0]?.status, "accepted");
    assert.equal(decided.growth[0]?.decidedBy, "lead");
    assert.equal(decided.members.find((member) => member.id === team.id)?.threadId, team.threadId);
    const unchanged = yield* teamwork.getSheet({ sheetId: sheet.id });
    assert.equal(unchanged.revision, sheet.revision);
    const roster = yield* teamwork.roster({ threadId: parent, sheetId: sheet.id });
    assert.deepEqual(
      roster.slots.map((slot) => [slot.slot, slot.origin]),
      [
        ["team", "staffed"],
        ["m1", "growth"],
      ],
    );
    const again = yield* teamwork
      .requestGrowth({ runId: run.id, ...ask }, asTeam)
      .pipe(Effect.flip);
    assert.equal(again.reason, "growth_refused");
  }).pipe(Effect.provide(h.layer));
});

it.effect("denies with a recorded reason and leaves the requester without a session", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, run, team, asTeam } = yield* growthRun({ mode: "on", scope: "session" });
    const filed = yield* teamwork.requestGrowth({ runId: run.id, ...ask }, asTeam);
    const denied = yield* teamwork.decideGrowth(
      { runId: run.id, requestId: filed.growth[0]!.id, accept: false, reason: "Reviewer is idle" },
      lead,
    );
    assert.equal(h.started.length, 1);
    assert.equal(denied.growth[0]?.status, "denied");
    assert.equal(denied.growth[0]?.reason, "Reviewer is idle");
    assert.isTrue(h.sent.some((input) => input.threadId === team.threadId));
    const again = yield* teamwork
      .requestGrowth({ runId: run.id, ...ask }, asTeam)
      .pipe(Effect.flip);
    assert.equal(again.reason, "growth_refused");
  }).pipe(Effect.provide(h.layer));
});

it.effect("waits for the owner in Ask mode, and an owner denial creates nothing", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, run, asTeam } = yield* growthRun({ mode: "ask", scope: "session" });
    const filed = yield* teamwork.requestGrowth({ runId: run.id, ...ask }, asTeam);
    const requestId = filed.growth[0]!.id;
    assert.equal(filed.growth[0]?.status, "awaiting_owner");
    assert.isNotNull(filed.waitingFor);
    const early = yield* teamwork
      .decideGrowth({ runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" }, lead)
      .pipe(Effect.flip);
    assert.equal(early.reason, "growth_refused");
    const answered = yield* teamwork.act(
      {
        runId: run.id,
        action: { type: "owner_growth_answer", requestId, allow: false, note: "Not now" },
      },
      owner,
    );
    assert.equal(answered.growth[0]?.status, "denied");
    assert.equal(answered.growth[0]?.decidedBy, "owner");
    const late = yield* teamwork
      .decideGrowth({ runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" }, lead)
      .pipe(Effect.flip);
    assert.equal(late.reason, "growth_refused");
    assert.equal(h.started.length, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect("saves accepted growth to the sheet, and a new roster binds the new node", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, sheet, run, asTeam } = yield* growthRun({ mode: "on", scope: "sheet" });
    const filed = yield* teamwork.requestGrowth({ runId: run.id, ...ask }, asTeam);
    const decided = yield* teamwork.decideGrowth(
      {
        runId: run.id,
        requestId: filed.growth[0]!.id,
        accept: true,
        reason: "Yes",
        brief: "Parse",
      },
      lead,
    );
    assert.equal(decided.growth[0]?.scope, "sheet");
    const saved = yield* teamwork.getSheet({ sheetId: sheet.id });
    assert.equal(saved.revision, sheet.revision + 1);
    const added = saved.nodes.find((node) => node.name === ask.capacity);
    assert.isDefined(added);
    assert.deepEqual((yield* teamwork.validateSheet({ sheetId: sheet.id })).problems, []);
    const thisThread = yield* teamwork.roster({ threadId: parent, sheetId: sheet.id });
    assert.isTrue(thisThread.slots.some((slot) => slot.nodeId === added?.id));
    assert.equal(h.started.length, 2);

    const other = ThreadId.make("other");
    h.addShell(other);
    const fresh = yield* teamwork.start(
      { parentThreadId: other, request: "Fresh", sheetId: sheet.id },
      owner,
    );
    yield* teamwork.startMember(
      { runId: fresh.id, nodeId: added!.id, message: "Go" },
      { ...lead, threadId: other },
    );
    assert.equal(h.started.length, 3);
    assert.equal(h.started[2]?.parentThreadId, other);
  }).pipe(Effect.provide(h.layer));
});

it.effect("does not let growth pass the parallel limit or the budget", () => {
  const h = harness();
  return Effect.gen(function* () {
    const { teamwork, run, team, asTeam } = yield* growthRun(
      { mode: "on", scope: "session" },
      { ...DEFAULT_TEAM_BUDGET, maxParallelAgents: 1, maxMinutes: 1 },
    );
    const filed = yield* teamwork.requestGrowth({ runId: run.id, ...ask }, asTeam);
    const requestId = filed.growth[0]!.id;
    h.shells.set(team.threadId!, { ...h.shells.get(team.threadId!), activeRunId: "busy" });
    const limited = yield* teamwork
      .decideGrowth({ runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" }, lead)
      .pipe(Effect.flip);
    assert.equal(limited.reason, "budget");
    h.shells.set(team.threadId!, { ...h.shells.get(team.threadId!), activeRunId: null });
    yield* TestClock.adjust("2 minutes");
    const parked = yield* teamwork
      .decideGrowth({ runId: run.id, requestId, accept: true, reason: "Yes", brief: "Parse" }, lead)
      .pipe(Effect.flip);
    assert.equal(parked.reason, "budget");
    assert.equal(h.started.length, 1);
  }).pipe(Effect.provide(h.layer));
});

it.effect.each([2, null])(
  "parks cost-limited work with measured cost %s until the owner resumes it",
  (cost) => {
    const h = harness({ pricedCost: cost });
    return Effect.gen(function* () {
      const teamwork = yield* service;
      const run = yield* teamwork.start(
        {
          parentThreadId: parent,
          request: "Go",
          budget: { ...DEFAULT_TEAM_BUDGET, maxCostUsd: 1 },
        },
        owner,
      );
      yield* teamwork.checkBudgets;
      const parked = (yield* teamwork.list({})).runs[0];
      assert.equal(parked?.status, "over_budget");
      assert.equal(parked?.costUsd, cost);
      const denied = yield* teamwork
        .startMember({ runId: run.id, nodeId: review, message: "Again" }, lead)
        .pipe(Effect.flip);
      assert.equal(denied.reason, "wrong_phase");
      const resumed = yield* teamwork.act(
        {
          runId: run.id,
          action: {
            type: "owner_resume",
            budget: { maxMinutes: 240, maxParallelAgents: 4, maxCorrectionCycles: 3 },
          },
        },
        owner,
      );
      assert.equal(resumed.status, "running");
    }).pipe(Effect.provide(h.layer));
  },
);

it.effect("counts only the turns a run asked for against its budget", () => {
  const h = harness({ pricedCost: 2, turnAt: 0 });
  return Effect.gen(function* () {
    const teamwork = yield* service;
    yield* TestClock.adjust("1 minute");
    const run = yield* teamwork.start(
      {
        parentThreadId: parent,
        request: "Go",
        budget: { ...DEFAULT_TEAM_BUDGET, maxCostUsd: 1 },
      },
      owner,
    );
    yield* teamwork.startMember({ runId: run.id, nodeId: review, message: "Review" }, lead);
    yield* teamwork.checkBudgets;
    const board = (yield* teamwork.list({})).runs[0];
    assert.equal(board?.status, "running");
    assert.equal(board?.costUsd, 0);
  }).pipe(Effect.provide(h.layer));
});

it.effect("caps new sessions at the parallel limit, and a run past its time parks", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const run = yield* teamwork.start(
      {
        parentThreadId: parent,
        request: "Go",
        budget: { ...DEFAULT_TEAM_BUDGET, maxMinutes: 1, maxParallelAgents: 1 },
      },
      owner,
    );
    const staffed = yield* teamwork.startMember(
      { runId: run.id, nodeId: review, message: "Review" },
      lead,
    );
    const reviewer = staffed.members.find((member) => member.nodeId === review)!;
    h.shells.set(reviewer.threadId!, { ...h.shells.get(reviewer.threadId!), activeRunId: "busy" });
    const capped = yield* teamwork
      .startMember({ runId: run.id, nodeId: build, message: "Build" }, lead)
      .pipe(Effect.flip);
    assert.equal(capped.reason, "budget");
    yield* TestClock.adjust("2 minutes");
    yield* teamwork.checkBudgets;
    assert.equal((yield* teamwork.list({})).runs[0]?.status, "over_budget");
    assert.deepEqual(h.interrupted, [reviewer.threadId]);
  }).pipe(Effect.provide(h.layer));
});

it.effect("interrupts a stopped run's turns without deleting its sessions", () => {
  const h = harness();
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const run = yield* teamwork.start({ parentThreadId: parent, request: "Go" }, owner);
    const staffed = yield* teamwork.startMember(
      { runId: run.id, nodeId: review, message: "Review" },
      lead,
    );
    const reviewer = staffed.members.find((member) => member.nodeId === review)!;
    h.shells.set(reviewer.threadId!, { ...h.shells.get(reviewer.threadId!), activeRunId: "busy" });
    yield* teamwork.act({ runId: run.id, action: { type: "owner_stop", reason: "Stop" } }, owner);
    assert.deepEqual(h.interrupted, [reviewer.threadId]);
    assert.isTrue(h.shells.has(reviewer.threadId!));
  }).pipe(Effect.provide(h.layer));
});

it.effect("opens one run per message, and treats a message during a run as an owner note", () => {
  const h = harness();
  const turn = (id: string, text: string, fromUser = true) => ({
    threadId: parent,
    capabilityMode: "code" as const,
    orchestrationRunId: RunId.make(id),
    modelSelection: leadModel,
    text,
    fromUser,
  });
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const store = yield* TeamworkStore.TeamworkStore;
    assert.isNull(yield* store.takeTurnContext(turn("off", "Hello")));
    yield* teamwork.setThreadSheet({ threadId: parent, sheetId: DEFAULT_TEAM_SHEET_ID }, owner);
    assert.isNull(yield* store.takeTurnContext(turn("wake", "From a child", false)));
    assert.include(yield* store.takeTurnContext(turn("one", "Fix it")), "Project Lead");
    assert.include(yield* store.takeTurnContext(turn("one", "Fix it")), "Project Lead");
    assert.equal((yield* teamwork.list({ parentThreadId: parent })).runs.length, 1);
    assert.include(yield* store.takeTurnContext(turn("two", "Also this")), "owner note");
    const runs = (yield* teamwork.list({ parentThreadId: parent })).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.request, "Fix it");
    assert.equal(runs[0]?.notes[0]?.kind, "owner");
    assert.equal(runs[0]?.notes[0]?.text, "Also this");
  }).pipe(Effect.provide(h.layer));
});

it.effect("masks known secrets before saving or returning run content", () => {
  const h = harness();
  const mask = makeSecretMask([{ name: "EXAMPLE_KEY", value: "fake-workspace-credential" }]);
  return Effect.gen(function* () {
    const teamwork = yield* service;
    const run = yield* teamwork.start(
      { parentThreadId: parent, request: "Handle fake-workspace-credential" },
      owner,
    );
    assert.equal(run.request, "Handle [secret:EXAMPLE_KEY]");
    assert.notInclude(JSON.stringify(yield* teamwork.list({})), "fake-workspace-credential");
  }).pipe(
    Effect.provide(h.layer),
    Effect.provideService(WorkspaceProcessEnvironment.ActiveSecretMasks, {
      add: () => () => {},
      redactDeep: mask.redactDeep,
    }),
  );
});
