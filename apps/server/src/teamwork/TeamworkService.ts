import { ScheduledRunCostEstimator } from "../scheduledTasks/ScheduledTaskService.ts";
import {
  BUILT_IN_TEAM_PRESETS,
  CommandId,
  DEFAULT_TEAM_BUDGET,
  TeamMemberId,
  TeamRun,
  TeamRunId,
  TeamworkError,
  ThreadId,
  type TeamActInput,
  type TeamListInput,
  type TeamListResult,
  type TeamStartInput,
  type TeamStartMemberInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as NestedSessionService from "../orchestration-v2/NestedSessionService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { applyTeamAction, enforceTeamBudget } from "./teamRunMachine.ts";

interface Caller extends NestedSessionService.DispatchActor {
  readonly threadId?: ThreadId;
}

export class TeamworkService extends Context.Service<
  TeamworkService,
  {
    readonly start: (
      input: TeamStartInput,
      caller: Caller,
    ) => Effect.Effect<TeamRun, TeamworkError>;
    readonly act: (input: TeamActInput, caller: Caller) => Effect.Effect<TeamRun, TeamworkError>;
    readonly startMember: (
      input: TeamStartMemberInput,
      caller: Caller,
    ) => Effect.Effect<TeamRun, TeamworkError>;
    readonly list: (
      input: typeof TeamListInput.Type,
    ) => Effect.Effect<typeof TeamListResult.Type, TeamworkError>;
    readonly listForCaller: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof TeamListResult.Type, TeamworkError>;
    readonly changes: Stream.Stream<TeamRun>;
    readonly checkBudgets: Effect.Effect<void, TeamworkError>;
  }
>()("t3pp/teamwork/TeamworkService") {}

const RunJson = Schema.fromJsonString(TeamRun);
const encode = Schema.encodeSync(RunJson);
const decode = Schema.decodeUnknownEffect(RunJson);
const storeError = () =>
  new TeamworkError({
    reason: "store_failed",
    detail: "Teamwork state could not be stored or read.",
  });
const refused = (reason: TeamworkError["reason"], detail: string) =>
  new TeamworkError({ reason, detail });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* NestedSessionService.NestedSessionService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const audit = yield* AuditTrail.AuditTrail;
  const estimateCost = yield* ScheduledRunCostEstimator;
  const processEnvironment = yield* WorkspaceProcessEnvironment.WorkspaceProcessEnvironment;
  const masks = yield* WorkspaceProcessEnvironment.ActiveSecretMasks;
  const changes = yield* PubSub.sliding<TeamRun>(256);
  const lock = yield* Semaphore.make(1);

  const get = Effect.fn("TeamworkService.get")(function* (id: TeamRunId) {
    const rows = yield* sql<{
      readonly json: string;
    }>`SELECT run_json AS json FROM teamwork_runs WHERE id = ${id}`.pipe(
      Effect.mapError(storeError),
    );
    if (rows[0] === undefined)
      return yield* refused("not_found", "The teamwork run was not found.");
    return yield* decode(rows[0].json).pipe(Effect.mapError(storeError));
  });

  const sanitize = Effect.fn("TeamworkService.sanitize")(function* <A>(
    threadId: ThreadId,
    value: A,
  ) {
    const launch = yield* processEnvironment.forThread(threadId);
    return masks.redactDeep(Option.isSome(launch) ? launch.value.mask.redactDeep(value) : value);
  });

  const save = Effect.fn("TeamworkService.save")(function* (input: TeamRun) {
    const run = yield* sanitize(input.parentThreadId, input);
    yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json) VALUES (${run.id}, ${run.parentThreadId}, ${encode(run)}) ON CONFLICT (id) DO UPDATE SET run_json = excluded.run_json`.pipe(
      Effect.mapError(storeError),
    );
    yield* PubSub.publish(changes, run);
    return run;
  });

  const list: TeamworkService["Service"]["list"] = Effect.fn("TeamworkService.list")(
    function* (input) {
      const rows = yield* sql<{
        readonly json: string;
      }>`SELECT run_json AS json FROM teamwork_runs ${input.parentThreadId === undefined ? sql`` : sql`WHERE parent_thread_id = ${input.parentThreadId}`} ORDER BY rowid DESC LIMIT 100`.pipe(
        Effect.mapError(storeError),
      );
      return {
        runs: yield* Effect.forEach(rows, (row) =>
          decode(row.json).pipe(Effect.mapError(storeError)),
        ),
      };
    },
  );

  const record = (run: TeamRun, caller: Caller, action: string) =>
    audit.record({
      actor: caller.kind,
      domain: "teamwork",
      action,
      threadId: run.parentThreadId,
      target: { kind: "teamwork-run", id: run.id },
      outcome: "succeeded",
    });

  const stopMembers = Effect.fn("TeamworkService.stopMembers")(function* (run: TeamRun) {
    for (const member of run.members) {
      if (member.threadId === null) continue;
      const shell = yield* threads
        .getThreadShell(member.threadId)
        .pipe(Effect.mapError(() => refused("start_failed", "A team member could not be read.")));
      if (shell === null || shell.activeRunId === null) continue;
      yield* threads
        .forceStopThread({ threadId: member.threadId })
        .pipe(
          Effect.mapError(() => refused("start_failed", "A team member could not be stopped.")),
        );
    }
  });

  const measureCost = Effect.fn("TeamworkService.measureCost")(function* (run: TeamRun) {
    let total = 0;
    for (const member of run.members) {
      if (member.threadId === null) continue;
      const { attempts, runs, providerTurns } = yield* threads
        .getThreadRecords(member.threadId, ["attempts", "runs", "providerTurns"])
        .pipe(Effect.mapError(() => refused("store_failed", "Team usage could not be read.")));
      for (const turn of providerTurns) {
        const usage = turn.turnTokenUsage ?? turn.tokenUsage;
        if (usage === undefined) continue;
        const attempt = attempts.find((entry) => entry.id === turn.runAttemptId);
        const model = runs.find((entry) => entry.id === attempt?.runId)?.modelSelection.model;
        if (model === undefined) return null;
        const cost = yield* estimateCost({
          model,
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
        });
        if (cost === null) return null;
        total += cost;
      }
    }
    return total;
  });

  const checkBudget = Effect.fn("TeamworkService.checkBudget")(function* (input: TeamRun) {
    if (input.status !== "running") return input;
    const costUsd =
      input.budget.maxCostUsd === undefined ? input.costUsd : yield* measureCost(input);
    const run =
      costUsd === input.costUsd
        ? input
        : yield* save({ ...input, ...(costUsd === undefined ? {} : { costUsd }) });
    const parked = enforceTeamBudget(run, DateTime.toEpochMillis(yield* DateTime.now));
    if (parked === null) return run;
    yield* save(parked);
    yield* stopMembers(parked);
    yield* record(
      parked,
      { kind: "system", createdBy: "system", creationSource: "server" },
      "budget.park",
    );
    return parked;
  });

  const start: TeamworkService["Service"]["start"] = Effect.fn("TeamworkService.start")(function* (
    input,
    caller,
  ) {
    if (caller.threadId !== undefined && caller.threadId !== input.parentThreadId)
      return yield* refused("not_a_member", "Start teamwork under your own conversation.");
    const parent = yield* threads
      .getThreadShell(input.parentThreadId)
      .pipe(Effect.mapError(() => refused("not_found", "The parent conversation was not found.")));
    if (parent === null)
      return yield* refused("not_found", "The parent conversation was not found.");
    const preset = BUILT_IN_TEAM_PRESETS.find((candidate) => candidate.id === input.presetId);
    if (preset === undefined)
      return yield* refused("unknown_preset", "Choose a built-in team preset.");
    const roles = input.roles ?? preset.roles;
    if (
      new Set(roles.map((role) => role.role)).size !== roles.length ||
      roles
        .filter((role) => role.role === "lead")
        .reduce((count, role) => count + role.count, 0) !== 1 ||
      roles.reduce((count, role) => count + role.count, 0) > 16
    )
      return yield* refused(
        "invalid_team",
        "Use distinct roles, exactly one lead, and at most sixteen members.",
      );
    if (
      !input.dryRun &&
      (!roles.some((role) => role.role === "reviewer" && role.count > 0) ||
        (preset.id !== "audit" && !roles.some((role) => role.role === "tester" && role.count > 0)))
    )
      return yield* refused(
        "invalid_team",
        "This team needs an independent reviewer and, for building presets, a tester.",
      );
    const at = DateTime.formatIso(yield* DateTime.now);
    const run: TeamRun = {
      id: TeamRunId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
      parentThreadId: input.parentThreadId,
      request: input.request,
      presetId: preset.id,
      dial: input.dial,
      budget: input.budget ?? DEFAULT_TEAM_BUDGET,
      costUsd: 0,
      dryRun: input.dryRun ?? false,
      phase: "intake",
      status: "running",
      waitingFor: null,
      reviewLoops: 0,
      members: roles.flatMap((role) =>
        Array.from({ length: role.count }, (_, i) => ({
          id: TeamMemberId.make(`${role.role}-${i + 1}`),
          role: role.role,
          threadId: null,
          ...(role.modelSelection === undefined ? {} : { modelSelection: role.modelSelection }),
        })),
      ),
      tasks: [],
      notes: [],
      handoffs: [],
      evidence: [],
      verdicts: [],
      report: null,
      startedAt: at,
      updatedAt: at,
    };
    const saved = yield* save(run);
    yield* record(saved, caller, "start");
    return saved;
  }, lock.withPermits(1));

  const act: TeamworkService["Service"]["act"] = Effect.fn("TeamworkService.act")(function* (
    input,
    caller,
  ) {
    const run = yield* checkBudget(yield* get(input.runId));
    const action = input.action;
    if (caller.threadId !== undefined) {
      if (
        action.type === "owner_approve" ||
        action.type === "owner_stop" ||
        action.type === "owner_resume"
      )
        return yield* refused("not_a_member", "Only the owner controls this gate.");
      const id = action.type === "handoff" ? action.fromId : action.byId;
      if (!run.members.some((member) => member.id === id && member.threadId === caller.threadId))
        return yield* refused("not_a_member", "A team member may act only as itself.");
    }
    if (
      run.status === "over_budget" &&
      action.type !== "owner_stop" &&
      action.type !== "owner_resume"
    )
      return yield* refused("budget", run.waitingFor ?? "The run is over budget.");
    const result = applyTeamAction(run, action, DateTime.formatIso(yield* DateTime.now));
    if (!result.ok) return yield* refused(result.refusal.reason, result.refusal.detail);
    const saved = yield* save(result.run);
    if (result.run.status === "stopped" || result.run.status === "completed")
      yield* stopMembers(result.run);
    yield* record(result.run, caller, action.type);
    return saved;
  }, lock.withPermits(1));

  const startMember: TeamworkService["Service"]["startMember"] = Effect.fn(
    "TeamworkService.startMember",
  )(function* (input, caller) {
    const run = yield* checkBudget(yield* get(input.runId));
    if (run.status !== "running")
      return yield* refused("wrong_phase", run.waitingFor ?? "This run is not running.");
    if (
      caller.threadId !== undefined &&
      caller.threadId !== run.parentThreadId &&
      !run.members.some((member) => member.threadId === caller.threadId && member.role === "lead")
    )
      return yield* refused("not_a_member", "Only the lead starts team members.");
    const member = run.members.find((candidate) => candidate.id === input.memberId);
    if (member === undefined)
      return yield* refused("not_a_member", "The team member was not found.");
    if (member.role === "builder" && run.phase !== "build")
      return yield* refused(
        "wrong_phase",
        "Builders start only after the plan passes review and owner approval.",
      );
    if (run.dryRun && member.role !== "lead")
      return yield* refused("wrong_phase", "A dry run only drafts the plan.");
    let active = 0;
    for (const candidate of run.members) {
      if (candidate.threadId === null) continue;
      const shell = yield* threads
        .getThreadShell(candidate.threadId)
        .pipe(Effect.mapError(() => refused("start_failed", "A team member could not be read.")));
      if (shell !== null && shell.activeRunId !== null) active += 1;
    }
    if (active >= run.budget.maxParallelAgents)
      return yield* refused("budget", "The parallel agent limit was reached.");
    if (member.threadId !== null)
      return yield* refused(
        "wrong_phase",
        "Send another message to the existing member conversation.",
      );
    const parent = yield* threads
      .getThreadShell(run.parentThreadId)
      .pipe(Effect.mapError(() => refused("not_found", "The parent conversation was not found.")));
    if (parent === null)
      return yield* refused("not_found", "The parent conversation was not found.");
    const started = yield* sessions
      .start(
        {
          commandId: CommandId.make(`teamwork:${run.id}:${member.id}`),
          parentThreadId: run.parentThreadId,
          threadId: ThreadId.make(`teamwork:${run.id}:${member.id}`),
          title: `${member.role}: ${run.request.slice(0, 100)}`,
          inherit: { type: "nothing" },
          workspace: member.role === "builder" ? { type: "worktree" } : { type: "shared" },
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          ...(member.modelSelection === undefined ? {} : { modelSelection: member.modelSelection }),
          message: yield* sanitize(
            run.parentThreadId,
            `Teamwork run: ${run.id}\nMember: ${member.id}\nRole: ${member.role}\nRead the board with t3_team_list and record handoffs and evidence with t3_team_act.\n\n${input.message}`,
          ),
        },
        caller,
      )
      .pipe(Effect.mapError(() => refused("start_failed", "The team member could not start.")));
    const updated = {
      ...run,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
      members: run.members.map((candidate) =>
        candidate.id === member.id ? { ...candidate, threadId: started.threadId } : candidate,
      ),
    };
    const saved = yield* save(updated);
    yield* record(saved, caller, "member.start");
    return saved;
  }, lock.withPermits(1));

  const checkBudgets = Effect.gen(function* () {
    const rows = yield* sql<{
      readonly json: string;
    }>`SELECT run_json AS json FROM teamwork_runs`.pipe(Effect.mapError(storeError));
    for (const row of rows)
      yield* checkBudget(yield* decode(row.json).pipe(Effect.mapError(storeError)));
  }).pipe(lock.withPermits(1));
  yield* checkBudgets.pipe(
    Effect.catch(() => Effect.logWarning("A teamwork budget check failed.")),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
  return TeamworkService.of({
    start,
    act,
    startMember,
    list,
    listForCaller: Effect.fn("TeamworkService.listForCaller")(function* (threadId) {
      const rows = yield* sql<{
        readonly json: string;
      }>`SELECT run_json AS json FROM teamwork_runs WHERE parent_thread_id = ${threadId} OR EXISTS (SELECT 1 FROM json_each(run_json, '$.members') WHERE json_extract(value, '$.threadId') = ${threadId}) ORDER BY rowid DESC LIMIT 100`.pipe(
        Effect.mapError(storeError),
      );
      return {
        runs: yield* Effect.forEach(rows, (row) =>
          decode(row.json).pipe(Effect.mapError(storeError)),
        ),
      };
    }),
    changes: Stream.fromPubSub(changes),
    checkBudgets,
  });
});

export const layer = Layer.effect(TeamworkService, make);
