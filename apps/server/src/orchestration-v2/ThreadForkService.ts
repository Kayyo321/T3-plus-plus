import {
  ContextTransferId,
  OrchestrationV2Actor,
  OrchestrationV2AppThread,
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ContextTransfer,
  OrchestrationV2ConversationMessage,
  OrchestrationV2CreationSource,
  OrchestrationV2NestedForkOptions,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2RewindTail,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface ThreadForkPlanV2 {
  readonly targetThread: OrchestrationV2AppThread;
  /** Null for a nested session that inherits nothing: there is nothing to carry over. */
  readonly transfer: OrchestrationV2ContextTransfer | null;
}

export class ThreadForkPlanError extends Schema.TaggedError<ThreadForkPlanError>()(
  "ThreadForkPlanError",
  {
    sourceThreadId: ThreadId,
    targetThreadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** waiting means provider-finished with checkpoint capture pending. */
export function isForkableSourceRunStatus(status: OrchestrationV2Run["status"]): boolean {
  return (
    status === "completed" ||
    status === "waiting" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled"
  );
}

export function forkableSourceRunStatusError(
  run: Pick<OrchestrationV2Run, "id" | "status">,
): string {
  return `Fork source run ${run.id} is ${run.status}; in-progress and rolled-back runs cannot be forked.`;
}

/**
 * Where a fork from a message lands. A user message that opened its run forks at the end of the
 * run before it. Anything later in a run cuts that run, which only a portable transfer can honor.
 */
export function messageForkPoint(input: {
  readonly message: Pick<OrchestrationV2ConversationMessage, "id" | "role">;
  readonly run: OrchestrationV2Run;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly runItems: ReadonlyArray<OrchestrationV2TurnItem>;
}):
  | { readonly run: OrchestrationV2Run; readonly throughTurnItemId: TurnItemId | undefined }
  | { readonly refused: string } {
  const { message, run } = input;
  if (message.role === "user" && run.userMessageId === message.id) {
    const previous = input.runs
      .filter((candidate) => candidate.ordinal < run.ordinal)
      .filter((candidate) => isForkableSourceRunStatus(candidate.status))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    return previous === undefined
      ? { refused: "Nothing comes before this message, so there is nothing to fork." }
      : { run: previous, throughTurnItemId: undefined };
  }
  const ordered = input.runItems.toSorted((left, right) => left.ordinal - right.ordinal);
  const index = ordered.findIndex(
    (item) =>
      (item.type === "assistant_message" || item.type === "user_message") &&
      item.messageId === message.id,
  );
  if (index === -1) return { refused: `Message ${message.id} has no timeline row.` };
  const later = ordered.slice(message.role === "user" ? index : index + 1);
  if (message.role === "assistant" && !later.some(isTurnWork)) {
    return { run, throughTurnItemId: undefined };
  }
  const through = message.role === "user" ? ordered[index - 1] : ordered[index];
  return { run, throughTurnItemId: through?.id };
}

/** Checkpoints and notices follow a turn's last reply without being part of what it said. */
const isTurnWork = (item: OrchestrationV2TurnItem) =>
  item.type === "assistant_message" ||
  item.type === "user_message" ||
  item.type === "command_execution" ||
  item.type === "file_change" ||
  item.type === "dynamic_tool";

export interface ThreadForkServiceV2Shape {
  readonly plan: (input: {
    readonly sourceProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
    /** Null only for a side chat whose parent has no stable run yet. */
    readonly sourceRun: OrchestrationV2Run | null;
    readonly sourceProviderThread: OrchestrationV2ProviderThread | undefined;
    readonly sourceTokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
    readonly canonicalSourcePoint: OrchestrationV2ContextSourcePoint;
    readonly transferId: ContextTransferId;
    readonly targetThreadId: ThreadId;
    readonly title?: string;
    readonly sideChat?: boolean;
    readonly nested?: OrchestrationV2NestedForkOptions;
    /** The fork point inside `sourceRun`, when the fork cuts it short. */
    readonly throughTurnItemId?: TurnItemId;
    /** Rewind branches keep their rolled-back source run and, until reopened, stay archived. */
    readonly rewindTail?: {
      readonly tail: OrchestrationV2RewindTail;
      readonly archived: boolean;
    };
    readonly createdBy: OrchestrationV2Actor;
    readonly creationSource: OrchestrationV2CreationSource;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<ThreadForkPlanV2, ThreadForkPlanError>;
}

export class ThreadForkServiceV2 extends Context.Service<
  ThreadForkServiceV2,
  ThreadForkServiceV2Shape
>()("t3pp/orchestration-v2/ThreadForkService/ThreadForkServiceV2") {}

export const layer: Layer.Layer<ThreadForkServiceV2> = Layer.succeed(
  ThreadForkServiceV2,
  ThreadForkServiceV2.of({
    plan: Effect.fn("ThreadForkService.plan")(function* (input) {
      const { sourceRun } = input;
      const sourceLineage = input.sourceProjection.thread.lineage;
      // A task a linked environment delegated here is a subagent of a remote thread.
      if (
        input.sideChat &&
        (sourceLineage.sideChat ||
          sourceLineage.relationshipToParent === "subagent" ||
          input.sourceProjection.thread.delegatedFrom !== undefined)
      ) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: sourceLineage.sideChat
            ? "A side chat cannot start another side chat."
            : "A subagent cannot start a side chat.",
        });
      }
      if (
        sourceRun !== null &&
        input.rewindTail === undefined &&
        !isForkableSourceRunStatus(sourceRun.status)
      ) {
        return yield* new ThreadForkPlanError({
          sourceThreadId: input.sourceProjection.thread.id,
          targetThreadId: input.targetThreadId,
          cause: forkableSourceRunStatusError(sourceRun),
        });
      }
      const { nested } = input;
      const { filesRewound: _filesRewound, ...sourceThread } = input.sourceProjection.thread;
      const targetThread: OrchestrationV2AppThread = {
        ...sourceThread,
        // PR context follows the conversation; watching remains the source thread's responsibility.
        pullRequests: input.sourceProjection.thread.pullRequests?.map(
          ({ watch: _watch, ...link }) => link,
        ),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
        id: input.targetThreadId,
        title: input.title ?? `${input.sourceProjection.thread.title} fork`,
        // The source's title job completes only on the source thread.
        titleRegeneration: null,
        // Side chats share the parent's worktree, so they start supervised.
        ...(input.sideChat ? { runtimeMode: "approval-required" as const } : {}),
        ...(nested?.modelSelection === undefined
          ? {}
          : {
              modelSelection: nested.modelSelection,
              providerInstanceId: nested.modelSelection.instanceId,
            }),
        ...(nested?.runtimeMode === undefined ? {} : { runtimeMode: nested.runtimeMode }),
        ...(nested?.interactionMode === undefined
          ? {}
          : { interactionMode: nested.interactionMode }),
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.sourceProjection.thread.id,
          relationshipToParent: "fork",
          rootThreadId: input.sourceProjection.thread.lineage.rootThreadId,
          ...(input.sideChat ? { sideChat: true } : {}),
          ...(nested === undefined ? {} : { nestedSession: true }),
        },
        ...(input.rewindTail === undefined ? {} : { rewindTail: input.rewindTail.tail }),
        forkedFrom:
          sourceRun === null
            ? null
            : {
                type: "run",
                threadId: input.sourceProjection.thread.id,
                runId: sourceRun.id,
                ...(input.throughTurnItemId === undefined
                  ? {}
                  : { throughTurnItemId: input.throughTurnItemId }),
              },
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        archivedAt: input.rewindTail?.archived === true ? input.createdAt : null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        // A guest link belongs to the thread it was made for.
        guestShare: null,
        lastVisitedAt: null,
        // A fork is a new thread; it does not inherit how often the source was opened.
        opens: null,
        deletedAt: null,
      };
      if (nested?.inherit === "none") return { targetThread, transfer: null };
      const transfer: OrchestrationV2ContextTransfer = {
        id: input.transferId,
        type: "fork",
        sourceThreadId: input.sourceProjection.thread.id,
        targetThreadId: input.targetThreadId,
        sourcePoint: input.canonicalSourcePoint,
        basePoint: null,
        sourceProviderInstanceId:
          sourceRun?.providerInstanceId ?? input.sourceProjection.thread.providerInstanceId,
        // Only native forks retain this context; portable handoffs rebuild it.
        sourceTokenUsage:
          (sourceRun?.status === "completed" || sourceRun?.status === "waiting") &&
          input.throughTurnItemId === undefined &&
          input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
            ? input.sourceTokenUsage
            : undefined,
        ...(nested?.contextSeed === undefined ? {} : { contextSeed: nested.contextSeed }),
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending",
        resolution: null,
        createdBy: input.createdBy,
        error:
          input.sourceProviderThread?.nativeThreadRef?.strength === "strong"
            ? null
            : "Source provider thread does not expose a strong native thread ref.",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        consumedAt: null,
      };
      return { targetThread, transfer };
    }),
  }),
);
