import {
  CommandId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2RewindMode,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadForkSourcePoint,
  THREAD_REWIND_PREVIEW_MAX_PATHS,
  ThreadBranchError,
  type ThreadForkPreview,
  type ThreadForkPreviewInput,
  type ThreadId,
  type ThreadRewindInput,
  type ThreadRewindModePreview,
  type ThreadRewindPreview,
  type ThreadRewindPreviewInput,
  type ThreadRewindReopenInput,
  type ThreadRewindReopenResult,
  type ThreadRewindResult,
  type ThreadRewindTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { isCheckpointRestoreIsolated } from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CommandPolicyCapabilityUnsupportedError,
  CommandPolicyV2,
  isActiveRun,
} from "./CommandPolicy.ts";
import { readForkHistoryItems } from "./ContextHandoffService.ts";
import type { DispatchActor } from "./NestedSessionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { messageForkPoint, isForkableSourceRunStatus } from "./ThreadForkService.ts";

const fail = (reason: ThreadBranchError["reason"], detail: string) =>
  new ThreadBranchError({ reason, detail });

/** Checkpoints restore whole checkouts, so a turn is the finest point files can return to. */
export function checkpointForTarget(input: {
  readonly target: ThreadRewindTarget;
  readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly message:
    | { readonly role: string; readonly runId: OrchestrationV2Run["id"] | null }
    | undefined;
}): OrchestrationV2Checkpoint | undefined {
  const { target, checkpoints, runs } = input;
  if (target.type === "checkpoint") {
    return checkpoints.find((checkpoint) => checkpoint.id === target.checkpointId);
  }
  const run = runs.find((candidate) => candidate.id === input.message?.runId);
  if (run === undefined) return undefined;
  const ceiling = input.message?.role === "assistant" ? run.ordinal + 1 : run.ordinal;
  const liveOrdinals = new Set(
    runs.filter((candidate) => candidate.status !== "rolled_back").map(({ ordinal }) => ordinal),
  );
  const ready = checkpoints.filter((checkpoint) => checkpoint.status === "ready");
  return (
    ready
      .filter(
        (checkpoint) =>
          checkpoint.appRunOrdinal !== null &&
          checkpoint.appRunOrdinal < ceiling &&
          liveOrdinals.has(checkpoint.appRunOrdinal),
      )
      .toSorted((left, right) => (right.appRunOrdinal ?? 0) - (left.appRunOrdinal ?? 0))[0] ??
    ready.find(
      (checkpoint) => checkpoint.appRunOrdinal === null && checkpoint.ordinalWithinScope === 0,
    )
  );
}

export class ThreadBranchService extends Context.Service<
  ThreadBranchService,
  {
    readonly previewRewind: (
      input: ThreadRewindPreviewInput,
    ) => Effect.Effect<ThreadRewindPreview, ThreadBranchError>;
    readonly rewind: (
      input: ThreadRewindInput,
      actor: DispatchActor,
    ) => Effect.Effect<ThreadRewindResult, ThreadBranchError>;
    /** Brings an archived rewind branch back, optionally in a worktree of its own. */
    readonly reopenRewindBranch: (
      input: ThreadRewindReopenInput,
      actor: DispatchActor,
    ) => Effect.Effect<ThreadRewindReopenResult, ThreadBranchError>;
    readonly previewFork: (
      input: ThreadForkPreviewInput,
    ) => Effect.Effect<ThreadForkPreview, ThreadBranchError>;
  }
>()("t3pp/orchestration-v2/ThreadBranchService") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const checkpoints = yield* CheckpointServiceV2;
  const commandPolicy = yield* CommandPolicyV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const audit = yield* AuditTrail.AuditTrail;

  const unexpected = (cause: unknown) =>
    fail(
      "failed",
      cause instanceof Error && cause.message.length > 0
        ? cause.message
        : "The rewind could not be completed.",
    );

  const loadRewind = Effect.fn("ThreadBranchService.loadRewind")(function* (
    threadId: ThreadId,
    target: ThreadRewindTarget,
  ) {
    const projection = yield* projections
      .getThreadRecords(threadId, [
        "runs",
        "checkpoints",
        "checkpointScopes",
        "messages",
        "providerThreads",
      ])
      .pipe(Effect.mapError(unexpected));
    const message =
      target.type === "message"
        ? projection.messages.find((candidate) => candidate.id === target.messageId)
        : undefined;
    const checkpoint = checkpointForTarget({
      target,
      checkpoints: projection.checkpoints,
      runs: projection.runs,
      message,
    });
    const scope = projection.checkpointScopes.find(
      (candidate) => candidate.id === checkpoint?.scopeId,
    );
    if (checkpoint === undefined || scope === undefined || checkpoint.status !== "ready") {
      return yield* fail("target-invalid", "That point has no checkpoint to return to.");
    }
    if (projection.runs.some(isActiveRun)) {
      return yield* fail("thread-busy", "Stop the running turn before rewinding.");
    }
    return { projection, checkpoint, scope };
  });

  const latestReadyCheckpoint = (
    checkpointList: ReadonlyArray<OrchestrationV2Checkpoint>,
    scope: OrchestrationV2CheckpointScope,
  ) =>
    checkpointList
      .filter((candidate) => candidate.scopeId === scope.id && candidate.status === "ready")
      .toSorted((left, right) => right.ordinalWithinScope - left.ordinalWithinScope)[0];

  /** What differs between the last checkpoint and the workspace, read from a throwaway ref. */
  const readOutsideChanges = Effect.fn("ThreadBranchService.readOutsideChanges")(function* (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly latest: OrchestrationV2Checkpoint;
    readonly target: OrchestrationV2Checkpoint;
    readonly name: string;
  }) {
    const snapshotRef = yield* checkpoints.snapshotWorkspace({
      scope: input.scope,
      name: input.name,
    });
    if (snapshotRef === null) {
      return { snapshotRef, outside: [], changed: [] };
    }
    return {
      snapshotRef,
      outside: yield* checkpoints.listChanges({
        scope: input.scope,
        from: input.latest.ref,
        to: snapshotRef,
      }),
      changed: yield* checkpoints.listChanges({
        scope: input.scope,
        from: input.target.ref,
        to: snapshotRef,
      }),
    };
  });

  const previewRewind: ThreadBranchService["Service"]["previewRewind"] = Effect.fn(
    "ThreadBranchService.previewRewind",
  )(function* (input) {
    const { projection, checkpoint, scope } = yield* loadRewind(input.threadId, input.target);
    const { thread, runs, messages } = projection;
    const targetOrdinal = checkpoint.appRunOrdinal ?? 0;
    const capabilities = yield* adapters.get(thread.modelSelection.instanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.option,
    );
    const canRollback = yield* Option.match(capabilities, {
      onNone: () => Effect.succeed(false),
      onSome: (resolved) =>
        commandPolicy
          .ensureRollback({
            commandId: CommandId.make(`preview:${input.threadId}`),
            threadId: input.threadId,
            providerInstanceId: thread.modelSelection.instanceId,
            capabilities: resolved,
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
    });
    const hasProviderThread = projection.providerThreads.some(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    const isolated = yield* isCheckpointRestoreIsolated(thread, scope, {
      fileSystem,
      projections,
      projects,
      path,
    }).pipe(Effect.mapError(unexpected));
    const latest = latestReadyCheckpoint(projection.checkpoints, scope) ?? checkpoint;
    const reads = isolated
      ? yield* readOutsideChanges({
          scope,
          latest,
          target: checkpoint,
          name: `preview-${input.threadId}`,
        }).pipe(Effect.mapError(unexpected))
      : { snapshotRef: null, outside: [], changed: [] };
    if (reads.snapshotRef !== null) {
      yield* checkpoints
        .deleteRef({ scope, ref: reads.snapshotRef })
        .pipe(Effect.mapError(unexpected));
    }

    const conversationBlock = !canRollback
      ? "This agent cannot rewind its conversation."
      : !hasProviderThread
        ? "This conversation has no agent session to rewind."
        : null;
    const filesBlock = isolated
      ? null
      : "Restoring files needs a worktree this conversation has to itself.";
    const modePreview = (
      mode: OrchestrationV2RewindMode,
      blocks: ReadonlyArray<string | null>,
    ): ThreadRewindModePreview => {
      const unavailableReason = blocks.find((block) => block !== null) ?? null;
      return { mode, available: unavailableReason === null, unavailableReason };
    };
    const discardedRuns = runs.filter(
      (run) =>
        run.ordinal > targetOrdinal &&
        run.status !== "rolled_back" &&
        run.status !== "queued" &&
        run.status !== "preparing",
    );
    const discardedRunIds = new Set(discardedRuns.map((run) => run.id));
    return {
      threadId: input.threadId,
      checkpointId: checkpoint.id,
      scopeId: scope.id,
      turn: targetOrdinal,
      modes: [
        modePreview("conversation", [conversationBlock]),
        modePreview("files", [filesBlock]),
        modePreview("both", [conversationBlock, filesBlock]),
      ],
      discardedTurns: discardedRuns.length,
      discardedMessages: messages.filter(
        (message) => message.runId !== null && discardedRunIds.has(message.runId),
      ).length,
      conversationRollback: !canRollback
        ? "unsupported"
        : Option.exists(
              capabilities,
              (resolved) => resolved.checkpointing.rollbackStartsFreshSession === true,
            )
          ? "fresh_session"
          : "native",
      filesChanged: reads.changed.slice(0, THREAD_REWIND_PREVIEW_MAX_PATHS),
      filesChangedCount: reads.changed.length,
      outsideChanges: reads.outside.slice(0, THREAD_REWIND_PREVIEW_MAX_PATHS),
      outsideChangesCount: reads.outside.length,
    };
  });

  const rewind: ThreadBranchService["Service"]["rewind"] = Effect.fn("ThreadBranchService.rewind")(
    function* (input, actor) {
      const { projection, checkpoint, scope } = yield* loadRewind(input.threadId, input.target);
      const restoresFiles = input.mode !== "conversation";
      const latest = latestReadyCheckpoint(projection.checkpoints, scope) ?? checkpoint;
      const reads = restoresFiles
        ? yield* readOutsideChanges({
            scope,
            latest,
            target: checkpoint,
            name: input.tailThreadId,
          }).pipe(Effect.mapError(unexpected))
        : { snapshotRef: null, outside: [], changed: [] };
      if (reads.outside.length > 0 && input.outsideChanges === undefined) {
        if (reads.snapshotRef !== null) {
          yield* checkpoints.deleteRef({ scope, ref: reads.snapshotRef }).pipe(Effect.ignore);
        }
        return yield* fail(
          "outside-changes",
          `${reads.outside.length} ${reads.outside.length === 1 ? "file has" : "files have"} changed outside the agent. Choose to stash or discard before rewinding.`,
        );
      }
      const stashPaths =
        input.outsideChanges === "stash" ? reads.outside.map((change) => change.path) : [];
      const dispatched = yield* orchestrator
        .dispatch({
          type: "checkpoint.rollback",
          commandId: input.commandId,
          threadId: input.threadId,
          scopeId: scope.id,
          checkpointId: checkpoint.id,
          restoreFiles: restoresFiles,
          ...(input.mode === "files" ? { filesOnly: true } : {}),
          keepTail: {
            targetThreadId: input.tailThreadId,
            snapshotRef: reads.snapshotRef,
            ...(stashPaths.length === 0 ? {} : { stashPaths }),
          },
        })
        .pipe(
          Effect.tapError(() =>
            reads.snapshotRef === null
              ? Effect.void
              : checkpoints.deleteRef({ scope, ref: reads.snapshotRef }).pipe(Effect.ignore),
          ),
          Effect.tap(() =>
            audit.record({
              actor: actor.kind,
              ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
              domain: "rewind",
              action: `rewind.${input.mode}`,
              outcome: "pending",
              threadId: input.threadId,
              target: { kind: "checkpoint", id: checkpoint.id },
              result: `Back to turn ${checkpoint.appRunOrdinal ?? 0}. What it discards stays on an archived branch.`,
              undo: {
                tool: "t3_thread_rewind",
                input: { action: "reopen", threadId: input.tailThreadId },
                label: "Reopen the archived branch",
              },
            }),
          ),
          Effect.mapError(rewindDispatchError),
        );
      return {
        sequence: dispatched.sequence,
        tailThreadId: input.tailThreadId,
        stashedPaths: stashPaths.length,
      };
    },
  );

  const reopenRewindBranch: ThreadBranchService["Service"]["reopenRewindBranch"] = Effect.fn(
    "ThreadBranchService.reopenRewindBranch",
  )(function* (input, actor) {
    const thread = yield* projections.getThread(input.threadId).pipe(Effect.mapError(unexpected));
    const tail = thread.rewindTail;
    if (tail === undefined) {
      return yield* fail("not-a-rewind-branch", "This conversation is not a rewind branch.");
    }
    const worktree =
      input.restoreFiles && tail.snapshotRef !== null
        ? yield* Effect.gen(function* () {
            const project = yield* projects.get(thread.projectId).pipe(Effect.mapError(unexpected));
            if (Option.isNone(project)) {
              return yield* fail("failed", "This conversation's project no longer exists.");
            }
            const created = yield* gitWorkflow
              .createWorktree({
                cwd: project.value.workspaceRoot,
                refName: tail.snapshotRef!,
                newRefName: `t3pp/rewind-${input.threadId.slice(-12)}`,
                path: null,
              })
              .pipe(Effect.mapError(unexpected));
            return created.worktree;
          })
        : null;
    // A branch can be archived and reopened again, so these must not replay an earlier receipt.
    const reopenedAt = DateTime.toEpochMillis(yield* DateTime.now);
    if (thread.archivedAt !== null) {
      yield* orchestrator
        .dispatch({
          type: "thread.unarchive",
          commandId: CommandId.make(`command:rewind-reopen:${input.threadId}:${reopenedAt}`),
          threadId: input.threadId,
        })
        .pipe(Effect.mapError(unexpected));
    }
    if (worktree !== null) {
      yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(
            `command:rewind-reopen-workspace:${input.threadId}:${reopenedAt}`,
          ),
          threadId: input.threadId,
          worktreePath: worktree.path,
          branch: worktree.refName,
        })
        .pipe(Effect.mapError(unexpected));
    }
    yield* audit.record({
      actor: actor.kind,
      ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
      domain: "rewind",
      action: "rewind.reopen",
      outcome: "succeeded",
      threadId: input.threadId,
    });
    return { threadId: input.threadId, worktreePath: worktree?.path ?? null };
  });

  const resolveForkRun = Effect.fn("ThreadBranchService.resolveForkRun")(function* (
    threadId: ThreadId,
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  ) {
    const projection = yield* projections
      .getThreadRecords(threadId, ["runs", "attempts", "messages", "checkpoints"])
      .pipe(Effect.mapError(unexpected));
    const stable = projection.runs.filter((run) => isForkableSourceRunStatus(run.status));
    const refuse = fail("target-invalid", "That point cannot be forked.");
    switch (sourcePoint.type) {
      case "latest_stable": {
        const run = stable.at(-1);
        return run === undefined
          ? yield* refuse
          : { projection, run, throughTurnItemId: undefined };
      }
      case "run": {
        const run = stable.find((candidate) => candidate.id === sourcePoint.runId);
        return run === undefined
          ? yield* refuse
          : { projection, run, throughTurnItemId: undefined };
      }
      case "checkpoint": {
        const checkpoint = projection.checkpoints.find(
          (candidate) => candidate.id === sourcePoint.checkpointId,
        );
        const run = stable.find((candidate) => candidate.id === checkpoint?.runId);
        return run === undefined
          ? yield* refuse
          : { projection, run, throughTurnItemId: undefined };
      }
      case "message": {
        const message = projection.messages.find(
          (candidate) => candidate.id === sourcePoint.messageId,
        );
        const run = projection.runs.find((candidate) => candidate.id === message?.runId);
        if (message === undefined || run === undefined) return yield* refuse;
        const { turnItems } = yield* projections
          .getThreadRecords(threadId, ["turnItems"], { turnItemRunIds: [run.id] })
          .pipe(Effect.mapError(unexpected));
        const point = messageForkPoint({
          message,
          run,
          runs: projection.runs,
          runItems: turnItems,
        });
        return "refused" in point
          ? yield* fail("target-invalid", point.refused)
          : { projection, ...point };
      }
    }
  });

  const previewFork: ThreadBranchService["Service"]["previewFork"] = Effect.fn(
    "ThreadBranchService.previewFork",
  )(function* (input) {
    const { projection, run, throughTurnItemId } = yield* resolveForkRun(
      input.threadId,
      input.sourcePoint,
    );
    const items = yield* readForkHistoryItems(projections, projection, run, {
      throughTurnItemId,
    }).pipe(Effect.mapError(unexpected));
    const messages = items.filter(
      (item) => item.type === "user_message" || item.type === "assistant_message",
    );
    const capabilities = yield* adapters.get(projection.thread.modelSelection.instanceId).pipe(
      Effect.flatMap((adapter) => adapter.getCapabilities()),
      Effect.option,
    );
    const native =
      throughTurnItemId === undefined &&
      run.providerInstanceId === projection.thread.modelSelection.instanceId &&
      (run.status === "completed" || run.status === "waiting") &&
      Option.exists(
        capabilities,
        (resolved) =>
          resolved.threads.canForkThread &&
          resolved.threads.canForkFromTurn &&
          resolved.identity.nativeThreadIds === "strong",
      );
    const characters = messages.reduce((total, item) => total + item.text.length, 0);
    return {
      threadId: input.threadId,
      runId: run.id,
      turn: run.ordinal,
      carriedMessages: messages.length,
      estimatedTokens: Math.ceil(characters / 4),
      strategy: native ? "native" : "portable",
      cutsTurn: throughTurnItemId !== undefined,
      lastMessage: messages.at(-1)?.text.slice(0, 200) ?? null,
    };
  });

  return ThreadBranchService.of({ previewRewind, rewind, reopenRewindBranch, previewFork });
});

const isCapabilityUnsupported = Schema.is(CommandPolicyCapabilityUnsupportedError);

/** The orchestrator's refusals are already written for people; everything else is not. */
const rewindDispatchError = (cause: unknown) => {
  const inner = cause instanceof Error ? cause.cause : undefined;
  if (isCapabilityUnsupported(inner)) {
    return fail("provider-unsupported", "This agent cannot rewind its conversation.");
  }
  const detail =
    typeof inner === "string"
      ? inner
      : cause instanceof Error
        ? cause.message
        : "The rewind could not be started.";
  return fail(detail.includes("isolated worktree") ? "shared-workspace" : "failed", detail);
};

export const layer = Layer.effect(ThreadBranchService, make);
