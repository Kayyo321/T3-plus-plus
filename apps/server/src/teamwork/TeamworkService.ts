import { ScheduledRunCostEstimator } from "../scheduledTasks/ScheduledTaskService.ts";
import {
  CommandId,
  DEFAULT_TEAM_SHEET_ID,
  MessageId,
  TEAM_SESSION_SLOT,
  TeamGrowthRequestId,
  TeamNodeId,
  TeamSheetId,
  TeamworkError,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type TeamActInput,
  type TeamGrowthDecideInput,
  type TeamGrowthRequest,
  type TeamGrowthRequestInput,
  type TeamListInput,
  type TeamListResult,
  type TeamMember,
  type TeamReplaceSlotInput,
  type TeamRosterInput,
  type TeamRosterResult,
  type TeamRosterSlot,
  type TeamRun,
  type TeamRunId,
  type TeamSheet,
  type TeamSheetCreateInput,
  type TeamSheetDeleteInput,
  type TeamSheetDuplicateInput,
  type TeamSheetGetInput,
  type TeamSheetListResult,
  type TeamSheetUpdateInput,
  type TeamSheetValidateInput,
  type TeamSheetValidateResult,
  type TeamStartInput,
  type TeamStartMemberInput,
  type TeamThreadSheet,
  type TeamThreadSheetInput,
  type TeamThreadSheetSetInput,
  type TeamWorkNode,
  type TeamworkChange,
} from "@t3tools/contracts";
import {
  applyTeamSheetChanges,
  DEFAULT_TEAM_SHEET,
  leadNodeOf,
  teamMemberId,
  teamMemberName,
  teamSheetProblems,
} from "@t3tools/shared/teamSheets";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as NestedSessionService from "../orchestration-v2/NestedSessionService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { applyTeamAction, enforceTeamBudget } from "./teamRunMachine.ts";
import {
  growthAwaitsOwner,
  growthDenied,
  growthOwnerAnswer,
  growthRequestForLead,
  memberSeed,
  memberTurn,
} from "./teamworkBriefs.ts";
import * as TeamworkStore from "./TeamworkStore.ts";

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
    readonly requestGrowth: (
      input: TeamGrowthRequestInput,
      caller: Caller,
    ) => Effect.Effect<TeamRun, TeamworkError>;
    readonly decideGrowth: (
      input: TeamGrowthDecideInput,
      caller: Caller,
    ) => Effect.Effect<TeamRun, TeamworkError>;
    readonly list: (
      input: typeof TeamListInput.Type,
    ) => Effect.Effect<typeof TeamListResult.Type, TeamworkError>;
    readonly listForCaller: (
      threadId: ThreadId,
    ) => Effect.Effect<typeof TeamListResult.Type, TeamworkError>;
    readonly listSheets: Effect.Effect<TeamSheetListResult, TeamworkError>;
    readonly getSheet: (input: TeamSheetGetInput) => Effect.Effect<TeamSheet, TeamworkError>;
    readonly createSheet: (
      input: TeamSheetCreateInput,
      caller: Caller,
    ) => Effect.Effect<TeamSheet, TeamworkError>;
    readonly updateSheet: (
      input: TeamSheetUpdateInput,
      caller: Caller,
    ) => Effect.Effect<TeamSheet, TeamworkError>;
    readonly duplicateSheet: (
      input: TeamSheetDuplicateInput,
      caller: Caller,
    ) => Effect.Effect<TeamSheet, TeamworkError>;
    readonly deleteSheet: (
      input: TeamSheetDeleteInput,
      caller: Caller,
    ) => Effect.Effect<void, TeamworkError>;
    readonly validateSheet: (
      input: TeamSheetValidateInput,
    ) => Effect.Effect<TeamSheetValidateResult, TeamworkError>;
    readonly threadSheet: (
      input: TeamThreadSheetInput,
    ) => Effect.Effect<TeamThreadSheet, TeamworkError>;
    readonly setThreadSheet: (
      input: TeamThreadSheetSetInput,
      caller: Caller,
    ) => Effect.Effect<TeamThreadSheet, TeamworkError>;
    readonly roster: (input: TeamRosterInput) => Effect.Effect<TeamRosterResult, TeamworkError>;
    readonly replaceSlot: (
      input: TeamReplaceSlotInput,
      caller: Caller,
    ) => Effect.Effect<TeamRosterResult, TeamworkError>;
    readonly changes: Stream.Stream<TeamworkChange>;
    readonly checkBudgets: Effect.Effect<void, TeamworkError>;
  }
>()("t3pp/teamwork/TeamworkService") {}

const refused = (reason: TeamworkError["reason"], detail: string) =>
  new TeamworkError({ reason, detail });

const isWorkNode = (node: TeamSheet["nodes"][number]): node is TeamWorkNode => node.kind !== "lead";

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? null) === JSON.stringify(right.options ?? null);

/** Keeps the lead inside the node's model option. Effort is the lead's in all three. */
const allowedModel = Effect.fn("TeamworkService.allowedModel")(function* (
  node: TeamWorkNode,
  requested: ModelSelection | undefined,
  fallback: ModelSelection,
) {
  const choice = node.modelChoice;
  switch (choice.type) {
    case "lead":
      return requested ?? fallback;
    case "provider": {
      const selection = requested ?? fallback;
      if (selection.instanceId === choice.instanceId) return selection;
      return yield* refused(
        "model_not_allowed",
        `${node.name} uses provider instance ${choice.instanceId}. Pick one of its models.`,
      );
    }
    case "pinned":
      if (
        requested !== undefined &&
        (requested.instanceId !== choice.instanceId || requested.model !== choice.model)
      ) {
        return yield* refused(
          "model_not_allowed",
          `${node.name} is pinned to ${choice.instanceId} ${choice.model}.`,
        );
      }
      return {
        instanceId: choice.instanceId,
        model: choice.model,
        ...(requested?.options === undefined ? {} : { options: requested.options }),
      };
  }
});

const nextMemberSlot = (slots: ReadonlyArray<TeamRosterSlot>, nodeId: TeamRosterSlot["nodeId"]) => {
  const used = new Set(slots.filter((slot) => slot.nodeId === nodeId).map((slot) => slot.slot));
  let index = 1;
  while (used.has(`m${index}`)) index += 1;
  return `m${index}`;
};

const make = Effect.gen(function* () {
  const store = yield* TeamworkStore.TeamworkStore;
  const crypto = yield* Crypto.Crypto;
  const sessions = yield* NestedSessionService.NestedSessionService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const audit = yield* AuditTrail.AuditTrail;
  const estimateCost = yield* ScheduledRunCostEstimator;
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const { withLock } = store;

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const isoNow = Effect.map(DateTime.now, DateTime.formatIso);

  const get = Effect.fn("TeamworkService.get")(function* (id: TeamRunId) {
    const run = yield* store.getRun(id);
    return Option.isSome(run)
      ? run.value
      : yield* refused("not_found", "The teamwork run was not found.");
  });

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(() => refused("start_failed", "A conversation could not be read.")),
      Effect.map((shell) => (shell === null || shell.deletedAt !== null ? null : shell)),
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

  const interrupt = Effect.fn("TeamworkService.interrupt")(function* (
    shell: OrchestrationV2ThreadShell,
    reason: string,
  ) {
    yield* threads
      .interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`command:team-stop:${yield* newId}`),
        threadId: shell.id,
        reason,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not interrupt a team session", { threadId: shell.id, cause }),
        ),
      );
  });

  /** Interrupts turns. Sessions stay: a later message re-invokes them. */
  const stopMembers = Effect.fn("TeamworkService.stopMembers")(function* (run: TeamRun) {
    for (const member of run.members) {
      if (member.threadId === null) continue;
      const shell = yield* shellOf(member.threadId);
      if (shell === null || shell.activeRunId === null) continue;
      yield* interrupt(shell, run.waitingFor ?? "The team run stopped.");
    }
  });

  /** A session outlives its run, so only turns this run asked for count against it. */
  const measureCost = Effect.fn("TeamworkService.measureCost")(function* (run: TeamRun) {
    const startedAt = Date.parse(run.startedAt);
    let total = 0;
    for (const member of run.members) {
      if (member.threadId === null) continue;
      const { attempts, runs, providerTurns } = yield* threads
        .getThreadRecords(member.threadId, ["attempts", "runs", "providerTurns"])
        .pipe(Effect.mapError(() => refused("store_failed", "Team usage could not be read.")));
      const inRun = runs.filter((entry) => DateTime.toEpochMillis(entry.requestedAt) >= startedAt);
      for (const turn of providerTurns) {
        const usage = turn.turnTokenUsage ?? turn.tokenUsage;
        if (usage === undefined) continue;
        const attempt = attempts.find((entry) => entry.id === turn.runAttemptId);
        if (attempt === undefined) continue;
        const orchestrationRun = inRun.find((entry) => entry.id === attempt.runId);
        if (orchestrationRun === undefined) continue;
        const cost = yield* estimateCost({
          model: orchestrationRun.modelSelection.model,
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
        : yield* store.saveRun({ ...input, ...(costUsd === undefined ? {} : { costUsd }) });
    const parked = enforceTeamBudget(run, DateTime.toEpochMillis(yield* DateTime.now));
    if (parked === null) return run;
    yield* store.saveRun(parked);
    yield* stopMembers(parked);
    yield* record(
      parked,
      { kind: "system", createdBy: "system", creationSource: "server" },
      "budget.park",
    );
    return parked;
  });

  const requireParent = Effect.fn("TeamworkService.requireParent")(function* (threadId: ThreadId) {
    const parent = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => refused("not_found", "The conversation was not found.")));
    if (parent === null || parent.deletedAt !== null) {
      return yield* refused("not_found", "The conversation was not found.");
    }
    if (parent.capabilityMode === "chat") {
      return yield* refused(
        "chat_thread",
        "Teamwork runs in Code mode. Switch this conversation to Code first.",
      );
    }
    if (parent.lineage.orchestrator === true || parent.lineage.relationshipToParent === "subagent")
      return yield* refused("chat_thread", "Teamwork runs in a conversation of your own.");
    return parent;
  });

  const requireSheet = Effect.fn("TeamworkService.requireSheet")(function* (id: TeamSheetId) {
    const sheet = yield* store.getSheet(id);
    return sheet ?? (yield* refused("not_found", "The sheet was not found."));
  });

  const start: TeamworkService["Service"]["start"] = Effect.fn("TeamworkService.start")(function* (
    input,
    caller,
  ) {
    if (caller.threadId !== undefined && caller.threadId !== input.parentThreadId)
      return yield* refused("not_a_member", "Start teamwork under your own conversation.");
    const parent = yield* requireParent(input.parentThreadId);
    const active = yield* store.activeRun(input.parentThreadId);
    if (active !== null)
      return yield* refused("wrong_phase", "This conversation already has an active run.");
    const sheetId =
      input.sheetId ?? (yield* store.threadSheetId(input.parentThreadId)) ?? DEFAULT_TEAM_SHEET_ID;
    const run = yield* store.beginRun({
      threadId: input.parentThreadId,
      sheet: yield* requireSheet(sheetId),
      request: input.request,
      leadModel: parent.modelSelection,
      budget: input.budget,
    });
    yield* record(run, caller, "start");
    return run;
  }, withLock);

  const notify = Effect.fn("TeamworkService.notify")(function* (threadId: ThreadId, text: string) {
    const shell = yield* shellOf(threadId);
    if (shell === null) return;
    const id = yield* newId;
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`command:team-note:${id}`),
        threadId,
        messageId: MessageId.make(`message:team-note:${id}`),
        text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not reach a team session", { threadId, cause }),
        ),
      );
  });

  const act: TeamworkService["Service"]["act"] = Effect.fn("TeamworkService.act")(function* (
    input,
    caller,
  ) {
    const run = yield* checkBudget(yield* get(input.runId));
    const { action } = input;
    const ownerAction =
      action.type === "owner_stop" ||
      action.type === "owner_resume" ||
      action.type === "owner_growth_answer";
    if (caller.threadId !== undefined) {
      if (ownerAction) return yield* refused("not_a_member", "Only the owner controls this.");
      const id = action.type === "handoff" ? action.fromId : action.byId;
      if (!run.members.some((member) => member.id === id && member.threadId === caller.threadId))
        return yield* refused("not_a_member", "A team member may act only as itself.");
    }
    if (run.status === "over_budget" && !ownerAction)
      return yield* refused("budget", run.waitingFor ?? "The run is over budget.");
    const result = applyTeamAction(run, action, yield* isoNow);
    if (!result.ok) return yield* refused(result.refusal.reason, result.refusal.detail);
    const saved = yield* store.saveRun(result.run);
    if (result.run.status === "stopped" || result.run.status === "over_budget")
      yield* stopMembers(result.run);
    yield* record(result.run, caller, action.type);
    if (action.type === "owner_growth_answer") {
      const request = saved.growth.find((entry) => entry.id === action.requestId);
      if (request !== undefined) {
        yield* notify(saved.parentThreadId, growthOwnerAnswer(saved, request));
        const from = saved.members.find((member) => member.id === request.fromId);
        if (request.status === "denied" && from?.threadId != null) {
          yield* notify(from.threadId, growthDenied(request));
        }
      }
    }
    return saved;
  }, withLock);

  const countActive = Effect.fn("TeamworkService.countActive")(function* (
    slots: ReadonlyArray<TeamRosterSlot>,
  ) {
    let active = 0;
    for (const slot of slots) {
      if (slot.sessionThreadId === null) continue;
      const shell = yield* shellOf(slot.sessionThreadId);
      if (shell !== null && shell.activeRunId !== null) active += 1;
    }
    return active;
  });

  const withMember = (run: TeamRun, member: TeamMember): TeamRun => ({
    ...run,
    members: run.members.some((candidate) => candidate.id === member.id)
      ? run.members.map((candidate) => (candidate.id === member.id ? member : candidate))
      : [...run.members, member],
  });

  const memberFor = (run: TeamRun, node: TeamWorkNode, slot: string): TeamMember => {
    const id = teamMemberId(node.id, slot);
    return (
      run.members.find((member) => member.id === id) ?? {
        id,
        nodeId: node.id,
        slot,
        kind: node.kind,
        name: teamMemberName(node.name, slot),
        threadId: null,
        state: "idle",
      }
    );
  };

  /** The only place a session is created. Callers reach it only for an empty slot. */
  const createSession = Effect.fn("TeamworkService.createSession")(function* (input: {
    readonly run: TeamRun;
    readonly parent: OrchestrationV2ThreadShell;
    readonly parentThreadId: ThreadId;
    readonly node: TeamWorkNode;
    readonly member: TeamMember;
    readonly modelSelection: ModelSelection;
    readonly message: string | undefined;
    readonly caller: Caller;
  }) {
    const { run, parent, node, member, modelSelection, message, caller } = input;
    const id = yield* newId;
    const threadId = ThreadId.make(`thread:team:${id}`);
    const seed = memberSeed(run, node, member);
    const title = `${member.name}: ${run.flow.sheetName}`;
    const failed = (cause: { readonly message: string }) => refused("start_failed", cause.message);
    if (run.flow.nestedSessions) {
      yield* sessions
        .start(
          {
            commandId: CommandId.make(`command:team-session:${id}`),
            parentThreadId: input.parentThreadId,
            threadId,
            title,
            inherit: { type: "summary", text: seed },
            workspace: node.kind === "build" ? { type: "worktree" } : { type: "shared" },
            modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            ...(message === undefined ? {} : { message }),
          },
          caller,
        )
        .pipe(Effect.mapError(failed));
      return threadId;
    }
    const branch = parent.branch === null ? {} : { branch: parent.branch };
    yield* launcher
      .launch({
        commandId: CommandId.make(`command:team-thread:${id}`),
        threadId,
        projectId: parent.projectId,
        title,
        modelSelection,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        workspaceStrategy:
          node.kind === "build"
            ? { type: "worktree", baseRef: parent.branch ?? "HEAD" }
            : parent.worktreePath === null
              ? { type: "root", ...branch }
              : { type: "existing_worktree", worktreePath: parent.worktreePath, ...branch },
        initialMessage: {
          text: message === undefined ? seed : `${seed}\n\n${message}`,
          attachments: [],
          senderThreadId: run.parentThreadId,
        },
        createdBy: caller.createdBy,
        creationSource: caller.creationSource,
      })
      .pipe(Effect.mapError(failed));
    return threadId;
  });

  const blockSlot = Effect.fn("TeamworkService.blockSlot")(function* (
    run: TeamRun,
    slot: TeamRosterSlot,
    member: TeamMember,
  ) {
    const detail = `${member.name}'s session was deleted. Replace it from the run board to continue.`;
    yield* store.putSlot({ ...slot, status: "blocked", detail });
    const at = yield* isoNow;
    yield* store.saveRun({
      ...withMember(run, { ...member, state: "blocked", detail }),
      notes: [...run.notes, { kind: "roster", byId: member.id, text: detail, at }],
      updatedAt: at,
    });
    return yield* refused("slot_blocked", detail);
  });

  /** Re-invocation. Never reaches `createSession`. */
  const invoke = Effect.fn("TeamworkService.invoke")(function* (input: {
    readonly run: TeamRun;
    readonly slot: TeamRosterSlot;
    readonly member: TeamMember;
    readonly node: TeamWorkNode;
    readonly message: string;
    readonly modelSelection: ModelSelection | undefined;
    readonly caller: Caller;
  }) {
    const { run, slot, member, node, caller } = input;
    if (slot.sessionThreadId === null)
      return yield* refused("slot_blocked", "This slot has no session.");
    const shell = yield* shellOf(slot.sessionThreadId);
    if (shell === null) return yield* blockSlot(run, slot, member);
    const dispatchFailed = () => refused("start_failed", `${member.name} could not be reached.`);
    if (shell.archivedAt !== null) {
      yield* threads
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`command:team-restore:${yield* newId}`),
          threadId: shell.id,
        })
        .pipe(Effect.mapError(dispatchFailed));
    }
    if (input.modelSelection !== undefined) {
      const allowed = yield* allowedModel(node, input.modelSelection, shell.modelSelection);
      if (!sameModel(allowed, shell.modelSelection)) {
        yield* threads
          .dispatch({
            type: modelSelectionCommandType(shell.providerInstanceId, allowed),
            commandId: CommandId.make(`command:team-model:${yield* newId}`),
            threadId: shell.id,
            modelSelection: allowed,
          })
          .pipe(Effect.mapError(dispatchFailed));
      }
    }
    const id = yield* newId;
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`command:team-turn:${id}`),
        threadId: shell.id,
        senderThreadId: run.parentThreadId,
        messageId: MessageId.make(`message:team-turn:${id}`),
        text: memberTurn(run, member, input.message),
        attachments: [],
        // A session still in a turn takes this behind that turn.
        mode: "queue",
        createdBy: caller.createdBy,
        creationSource: caller.creationSource,
      })
      .pipe(Effect.mapError(dispatchFailed));
    const saved = yield* store.saveRun({
      ...withMember(run, {
        ...member,
        threadId: shell.id,
        state: "invoked",
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      }),
      updatedAt: yield* isoNow,
    });
    yield* record(saved, caller, "member.invoke");
    return saved;
  });

  const requireProvider = Effect.fn("TeamworkService.requireProvider")(function* (
    parent: OrchestrationV2ThreadShell,
    selection: ModelSelection,
  ) {
    yield* threads
      .assertProviderInstanceEnabled({
        projectId: parent.projectId,
        commandId: CommandId.make(`command:team-provider:${yield* newId}`),
        instanceId: selection.instanceId,
      })
      .pipe(Effect.mapError((cause) => refused("model_not_allowed", cause.message)));
  });

  /** The team's session, created first when a member is staffed before the team is. */
  const ensureTeamSession = Effect.fn("TeamworkService.ensureTeamSession")(function* (input: {
    readonly run: TeamRun;
    readonly parent: OrchestrationV2ThreadShell;
    readonly node: TeamWorkNode;
    readonly modelSelection: ModelSelection;
    readonly caller: Caller;
  }) {
    const { run, parent, node, modelSelection, caller } = input;
    const slots = yield* store.roster(run.parentThreadId, run.sheetId);
    const bound = slots.find((slot) => slot.nodeId === node.id && slot.slot === TEAM_SESSION_SLOT);
    if (bound?.sessionThreadId != null) return { run, teamThreadId: bound.sessionThreadId };
    const member = memberFor(run, node, TEAM_SESSION_SLOT);
    const threadId = yield* createSession({
      run,
      parent,
      parentThreadId: run.parentThreadId,
      node,
      member,
      modelSelection,
      message: undefined,
      caller,
    });
    yield* store.putSlot({
      threadId: run.parentThreadId,
      sheetId: run.sheetId,
      nodeId: node.id,
      slot: TEAM_SESSION_SLOT,
      sessionThreadId: threadId,
      status: "bound",
      createdRunId: bound?.createdRunId ?? run.id,
      origin: "staffed",
      detail: null,
    });
    return {
      run: withMember(run, { ...member, threadId, modelSelection }),
      teamThreadId: threadId,
    };
  });

  const startMember: TeamworkService["Service"]["startMember"] = Effect.fn(
    "TeamworkService.startMember",
  )(function* (input, caller) {
    const run = yield* checkBudget(yield* get(input.runId));
    if (run.status !== "running")
      return yield* refused("wrong_phase", run.waitingFor ?? "This run is not running.");
    if (caller.threadId !== undefined && caller.threadId !== run.parentThreadId)
      return yield* refused("not_lead", "Only the Project Lead invokes team sessions.");
    const node = run.flow.nodes.find((candidate) => candidate.id === input.nodeId);
    if (node === undefined || !isWorkNode(node))
      return yield* refused("not_found", "That team is not on this run's sheet.");
    const slotName = input.slot ?? TEAM_SESSION_SLOT;
    const slots = yield* store.roster(run.parentThreadId, run.sheetId);
    const existing = slots.find((slot) => slot.nodeId === node.id && slot.slot === slotName);
    const member = memberFor(run, node, slotName);
    if (existing?.status === "blocked")
      return yield* refused("slot_blocked", existing.detail ?? "This slot is blocked.");
    if (existing?.status === "bound") {
      return yield* invoke({
        run,
        slot: existing,
        member,
        node,
        message: input.message,
        modelSelection: input.modelSelection,
        caller,
      });
    }
    const addedEarlier = slots.some(
      (slot) => slot.nodeId === node.id && slot.createdRunId !== run.id,
    );
    if (existing === undefined && addedEarlier)
      return yield* refused(
        "roster_fixed",
        `${node.name} was staffed by an earlier run. Pick among its bound members; more capacity means a growth request or a sheet edit.`,
      );
    if ((yield* countActive(slots)) >= run.budget.maxParallelAgents)
      return yield* refused("budget", "The parallel agent limit was reached.");
    const parent = yield* requireParent(run.parentThreadId);
    const modelSelection = yield* allowedModel(node, input.modelSelection, run.leadModel);
    yield* requireProvider(parent, modelSelection);
    const staffing =
      slotName === TEAM_SESSION_SLOT || !run.flow.nestedSessions
        ? { run, teamThreadId: run.parentThreadId }
        : yield* ensureTeamSession({ run, parent, node, modelSelection, caller });
    const threadId = yield* createSession({
      run: staffing.run,
      parent,
      parentThreadId: staffing.teamThreadId,
      node,
      member,
      modelSelection,
      message: input.message,
      caller,
    });
    yield* store.putSlot({
      threadId: run.parentThreadId,
      sheetId: run.sheetId,
      nodeId: node.id,
      slot: slotName,
      sessionThreadId: threadId,
      status: "bound",
      createdRunId: existing?.createdRunId ?? run.id,
      origin: existing?.origin ?? "staffed",
      detail: null,
    });
    const saved = yield* store.saveRun({
      ...withMember(staffing.run, { ...member, threadId, modelSelection, state: "invoked" }),
      updatedAt: yield* isoNow,
    });
    yield* record(saved, caller, "member.start");
    return saved;
  }, withLock);

  const currentGrowth = Effect.fn("TeamworkService.currentGrowth")(function* (run: TeamRun) {
    const sheet = yield* store.getSheet(run.sheetId);
    return {
      sheet,
      growth: (sheet === null ? undefined : leadNodeOf(sheet))?.growth ?? {
        mode: "off" as const,
        scope: "session" as const,
      },
    };
  });

  const requestGrowth: TeamworkService["Service"]["requestGrowth"] = Effect.fn(
    "TeamworkService.requestGrowth",
  )(function* (input, caller) {
    const run = yield* get(input.runId);
    if (run.status === "stopped" || run.status === "done")
      return yield* refused("run_closed", "This run has ended.");
    const from = run.members.find(
      (member) => member.threadId === caller.threadId && member.kind !== "lead",
    );
    if (caller.threadId === undefined || from === undefined)
      return yield* refused("not_a_member", "Only a team's session or member asks for growth.");
    const at = yield* isoNow;
    const { growth } = yield* currentGrowth(run);
    const request: TeamGrowthRequest = {
      id: TeamGrowthRequestId.make(yield* newId),
      nodeId: from.nodeId,
      fromId: from.id,
      capacity: input.capacity,
      why: input.why,
      tried: input.tried,
      status: "open",
      decidedBy: null,
      reason: null,
      memberId: null,
      scope: null,
      requestedAt: at,
      decidedAt: null,
    };
    if (growth.mode === "off") {
      const reason = "Growth is off for this sheet. Solve this with the members you have.";
      yield* store.saveRun({
        ...run,
        growth: [
          ...run.growth,
          { ...request, status: "refused", decidedBy: "system", reason, decidedAt: at },
        ],
        updatedAt: at,
      });
      return yield* refused("growth_off", reason);
    }
    if (run.growth.some((entry) => entry.nodeId === from.nodeId && entry.status !== "refused")) {
      return yield* refused(
        "growth_refused",
        "This team already made its growth request this round.",
      );
    }
    const asksOwner = growth.mode === "ask";
    const saved = yield* store.saveRun({
      ...run,
      growth: [...run.growth, asksOwner ? { ...request, status: "awaiting_owner" } : request],
      ...(asksOwner
        ? { waitingFor: `Answer ${from.name}'s growth request: ${input.capacity}.` }
        : {}),
      updatedAt: at,
    });
    const filed = saved.growth.at(-1) ?? request;
    yield* notify(
      saved.parentThreadId,
      asksOwner ? growthAwaitsOwner(saved, filed) : growthRequestForLead(saved, filed),
    );
    yield* record(saved, caller, "growth.request");
    return saved;
  }, withLock);

  const updateRequest = (
    run: TeamRun,
    id: TeamGrowthRequest["id"],
    update: Partial<TeamGrowthRequest>,
  ): TeamRun => ({
    ...run,
    growth: run.growth.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)),
  });

  /** New rosters get the node; this thread's roster binds it to the session just started. */
  const growthNode = (sheet: TeamSheet, team: TeamWorkNode, capacity: string): TeamWorkNode => {
    const taken = new Set(sheet.nodes.map((node) => node.name.toLocaleLowerCase()));
    const base = capacity.slice(0, 76);
    let name = base;
    for (let index = 2; taken.has(name.toLocaleLowerCase()); index += 1) {
      name = `${base} ${index}`;
    }
    return {
      id: TeamNodeId.make(`growth-${sheet.revision + 1}-${team.id}`),
      kind: team.kind,
      name,
      instructions: `${team.instructions}\n\nAdded for: ${capacity}`,
      position: { x: team.position.x + 240, y: team.position.y },
      modelChoice: team.modelChoice,
    };
  };

  const decideGrowth: TeamworkService["Service"]["decideGrowth"] = Effect.fn(
    "TeamworkService.decideGrowth",
  )(function* (input, caller) {
    const run = yield* checkBudget(yield* get(input.runId));
    if (caller.threadId === undefined || caller.threadId !== run.parentThreadId)
      return yield* refused("not_lead", "Only the Project Lead's session decides growth.");
    const request = run.growth.find((entry) => entry.id === input.requestId);
    if (request === undefined)
      return yield* refused("not_found", "That growth request was not found.");
    if (request.status === "awaiting_owner")
      return yield* refused("growth_refused", "The owner has not answered this request yet.");
    if (request.status !== "open" && request.status !== "owner_allowed")
      return yield* refused("growth_refused", "This growth request is already closed.");
    const at = yield* isoNow;
    const from = run.members.find((member) => member.id === request.fromId);
    if (!input.accept) {
      const denied = {
        status: "denied",
        decidedBy: "lead",
        reason: input.reason,
        decidedAt: at,
      } as const;
      const saved = yield* store.saveRun({
        ...updateRequest(run, request.id, denied),
        updatedAt: at,
      });
      if (from?.threadId != null) {
        yield* notify(from.threadId, growthDenied({ ...request, ...denied }));
      }
      yield* record(saved, caller, "growth.deny");
      return saved;
    }
    if (input.brief === undefined)
      return yield* refused("growth_refused", "Accepting needs the new member's brief.");
    if (run.status !== "running")
      return yield* refused("budget", run.waitingFor ?? "This run is not running.");
    const slots = yield* store.roster(run.parentThreadId, run.sheetId);
    if ((yield* countActive(slots)) >= run.budget.maxParallelAgents)
      return yield* refused("budget", "The parallel agent limit was reached.");
    const team = run.flow.nodes.find((node) => node.id === request.nodeId);
    if (team === undefined || !isWorkNode(team))
      return yield* refused("not_found", "The requesting team is not on this sheet.");
    const parent = yield* requireParent(run.parentThreadId);
    const modelSelection = yield* allowedModel(team, input.modelSelection, run.leadModel);
    yield* requireProvider(parent, modelSelection);
    const { sheet, growth } = yield* currentGrowth(run);
    const savesToSheet = growth.scope === "sheet" && sheet !== null && !sheet.builtIn;
    const nodeForSlot = savesToSheet ? growthNode(sheet, team, request.capacity) : team;
    const slotName = savesToSheet ? TEAM_SESSION_SLOT : nextMemberSlot(slots, team.id);
    const member = memberFor(run, nodeForSlot, slotName);
    const teamSlot = slots.find(
      (slot) => slot.nodeId === team.id && slot.slot === TEAM_SESSION_SLOT,
    );
    const threadId = yield* createSession({
      run,
      parent,
      parentThreadId:
        run.flow.nestedSessions && teamSlot?.sessionThreadId != null
          ? teamSlot.sessionThreadId
          : run.parentThreadId,
      node: nodeForSlot,
      member,
      modelSelection,
      message: input.brief,
      caller,
    });
    let nextFlow = run.flow;
    if (savesToSheet) {
      const edges = sheet.edges.flatMap((edge) =>
        edge.from === team.id
          ? [{ ...edge, from: nodeForSlot.id }]
          : edge.to === team.id
            ? [{ ...edge, to: nodeForSlot.id }]
            : [],
      );
      const updated = applyTeamSheetChanges(sheet, [
        { type: "add_node", node: nodeForSlot },
        ...edges.map((edge) => ({ type: "connect" as const, edge })),
      ]);
      const written = yield* store.writeSheet(
        { ...updated, revision: sheet.revision + 1, updatedAt: at },
        sheet.revision,
      );
      if (!written)
        yield* Effect.logWarning("A growth node lost a revision race", { sheetId: sheet.id });
      nextFlow = { ...run.flow, nodes: updated.nodes, edges: updated.edges };
    }
    yield* store.putSlot({
      threadId: run.parentThreadId,
      sheetId: run.sheetId,
      nodeId: nodeForSlot.id,
      slot: slotName,
      sessionThreadId: threadId,
      status: "bound",
      createdRunId: run.id,
      origin: "growth",
      detail: null,
    });
    const saved = yield* store.saveRun({
      ...updateRequest(
        withMember(
          { ...run, flow: nextFlow },
          { ...member, threadId, modelSelection, state: "invoked" },
        ),
        request.id,
        {
          status: "accepted",
          decidedBy: "lead",
          reason: input.reason,
          memberId: member.id,
          scope: savesToSheet ? "sheet" : "session",
          decidedAt: at,
        },
      ),
      updatedAt: at,
    });
    yield* record(saved, caller, "growth.accept");
    return saved;
  }, withLock);

  const instanceOptions = Effect.gen(function* () {
    if (Option.isNone(providers)) return {};
    const entries = yield* providers.value.getProviders;
    return { instanceIds: new Set<string>(entries.map((entry) => entry.instanceId)) };
  });

  const requireValid = Effect.fn("TeamworkService.requireValid")(function* (
    sheet: Pick<TeamSheet, "nodes" | "edges">,
  ) {
    const problems = teamSheetProblems(sheet, yield* instanceOptions);
    if (problems[0] !== undefined) return yield* refused("invalid_sheet", problems[0]);
  });

  const recordSheet = (sheet: TeamSheet, caller: Caller, action: string) =>
    audit.record({
      actor: caller.kind,
      domain: "teamwork",
      action,
      target: { kind: "teamwork-sheet", id: sheet.id },
      outcome: "succeeded",
    });

  const createSheet: TeamworkService["Service"]["createSheet"] = Effect.fn(
    "TeamworkService.createSheet",
  )(function* (input, caller) {
    const sheet: TeamSheet = {
      id: TeamSheetId.make(yield* newId),
      name: input.name,
      revision: 1,
      builtIn: false,
      nestedSessions: input.design?.nestedSessions ?? DEFAULT_TEAM_SHEET.nestedSessions,
      nodes: input.design?.nodes ?? DEFAULT_TEAM_SHEET.nodes,
      edges: input.design?.edges ?? DEFAULT_TEAM_SHEET.edges,
      updatedAt: yield* isoNow,
    };
    yield* requireValid(sheet);
    yield* store.insertSheet(sheet);
    yield* recordSheet(sheet, caller, "sheet.create");
    return sheet;
  });

  const updateSheet: TeamworkService["Service"]["updateSheet"] = Effect.fn(
    "TeamworkService.updateSheet",
  )(function* (input, caller) {
    const sheet = yield* requireSheet(input.sheetId);
    if (sheet.builtIn)
      return yield* refused("read_only_sheet", "The default sheet is read-only. Duplicate it.");
    const conflict = refused(
      "revision_conflict",
      "This sheet changed since you read it. Read it again.",
    );
    if (sheet.revision !== input.baseRevision) return yield* conflict;
    const next: TeamSheet = {
      ...applyTeamSheetChanges(sheet, input.changes),
      revision: sheet.revision + 1,
      updatedAt: yield* isoNow,
    };
    yield* requireValid(next);
    if (!(yield* store.writeSheet(next, input.baseRevision))) return yield* conflict;
    yield* recordSheet(next, caller, "sheet.update");
    return next;
  });

  const duplicateSheet: TeamworkService["Service"]["duplicateSheet"] = Effect.fn(
    "TeamworkService.duplicateSheet",
  )(function* (input, caller) {
    const source = yield* requireSheet(input.sheetId);
    const sheet: TeamSheet = {
      ...source,
      id: TeamSheetId.make(yield* newId),
      name: input.name ?? `${source.name.slice(0, 74)} copy`,
      revision: 1,
      builtIn: false,
      updatedAt: yield* isoNow,
    };
    yield* store.insertSheet(sheet);
    yield* recordSheet(sheet, caller, "sheet.duplicate");
    return sheet;
  });

  const deleteSheet: TeamworkService["Service"]["deleteSheet"] = Effect.fn(
    "TeamworkService.deleteSheet",
  )(function* (input, caller) {
    const sheet = yield* requireSheet(input.sheetId);
    if (sheet.builtIn)
      return yield* refused("read_only_sheet", "The default sheet cannot be deleted.");
    if (!(yield* store.removeSheet(sheet.id, input.baseRevision)))
      return yield* refused(
        "revision_conflict",
        "This sheet changed since you read it. Read it again.",
      );
    yield* recordSheet(sheet, caller, "sheet.delete");
  });

  const threadSheet: TeamworkService["Service"]["threadSheet"] = Effect.fn(
    "TeamworkService.threadSheet",
  )(function* ({ threadId }) {
    const sheetId = yield* store.threadSheetId(threadId);
    const sheet = sheetId === null ? null : yield* store.getSheet(sheetId);
    return { threadId, sheetId: sheet?.id ?? null, sheetName: sheet?.name ?? null };
  });

  const setThreadSheet: TeamworkService["Service"]["setThreadSheet"] = Effect.fn(
    "TeamworkService.setThreadSheet",
  )(function* (input, caller) {
    if (caller.threadId !== undefined && caller.threadId !== input.threadId)
      return yield* refused("not_a_member", "Turn teamwork on for your own conversation.");
    if (input.sheetId === null) {
      yield* store.setThreadSheetId(input.threadId, null);
      return { threadId: input.threadId, sheetId: null, sheetName: null };
    }
    const thread = yield* threads
      .getThreadShell(input.threadId)
      .pipe(Effect.mapError(() => refused("not_found", "The conversation was not found.")));
    // A draft has no thread yet. Its id is the one its thread takes when it first sends.
    if (thread !== null) yield* requireParent(input.threadId);
    const sheet = yield* requireSheet(input.sheetId);
    yield* store.setThreadSheetId(input.threadId, sheet.id);
    return { threadId: input.threadId, sheetId: sheet.id, sheetName: sheet.name };
  });

  const replaceSlot: TeamworkService["Service"]["replaceSlot"] = Effect.fn(
    "TeamworkService.replaceSlot",
  )(function* (input, caller) {
    if (caller.threadId !== undefined)
      return yield* refused("not_a_member", "Only the owner replaces a deleted session.");
    const slots = yield* store.roster(input.threadId, input.sheetId);
    const slot = slots.find(
      (candidate) => candidate.nodeId === input.nodeId && candidate.slot === input.slot,
    );
    if (slot?.status !== "blocked") return yield* refused("not_found", "That slot is not blocked.");
    yield* store.putSlot({ ...slot, sessionThreadId: null, status: "vacant", detail: null });
    const active = yield* store.activeRun(input.threadId);
    const memberId = teamMemberId(input.nodeId, input.slot);
    if (active !== null) {
      const member = active.members.find((candidate) => candidate.id === memberId);
      if (member !== undefined) {
        const { detail: _detail, ...rest } = member;
        yield* store.saveRun({
          ...withMember(active, { ...rest, threadId: null, state: "idle" }),
          updatedAt: yield* isoNow,
        });
      }
    }
    return { slots: yield* store.roster(input.threadId, input.sheetId) };
  }, withLock);

  const checkBudgets = Effect.gen(function* () {
    for (const run of yield* store.listRunningRuns) yield* checkBudget(run);
  }).pipe(withLock);
  yield* checkBudgets.pipe(
    Effect.catch(() => Effect.logWarning("A teamwork budget check failed.")),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );

  return TeamworkService.of({
    start,
    act,
    startMember,
    requestGrowth,
    decideGrowth,
    list: Effect.fn("TeamworkService.list")(function* (input) {
      return { runs: yield* store.listRuns(input.parentThreadId) };
    }),
    listForCaller: Effect.fn("TeamworkService.listForCaller")(function* (threadId) {
      return { runs: yield* store.listRunsForCaller(threadId) };
    }),
    listSheets: store.listSheets.pipe(Effect.map((sheets) => ({ sheets }))),
    getSheet: Effect.fn("TeamworkService.getSheet")(function* ({ sheetId }) {
      return yield* requireSheet(sheetId);
    }),
    createSheet,
    updateSheet,
    duplicateSheet,
    deleteSheet,
    validateSheet: Effect.fn("TeamworkService.validateSheet")(function* (input) {
      const sheet = input.design ?? (yield* requireSheet(input.sheetId ?? DEFAULT_TEAM_SHEET_ID));
      const problems = teamSheetProblems(sheet, yield* instanceOptions);
      return { valid: problems.length === 0, problems };
    }),
    threadSheet,
    setThreadSheet,
    roster: Effect.fn("TeamworkService.roster")(function* ({ threadId, sheetId }) {
      return { slots: yield* store.roster(threadId, sheetId) };
    }),
    replaceSlot,
    changes: store.changes,
    checkBudgets,
  });
});

export const layer = Layer.effect(TeamworkService, make);
