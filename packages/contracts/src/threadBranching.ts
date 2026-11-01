import * as Schema from "effect/Schema";

import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  OrchestrationV2Notification,
  OrchestrationV2RewindMode,
  OrchestrationV2ThreadForkSourcePoint,
} from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** Paths a preview names; counts stay exact when the list is cut. */
export const THREAD_REWIND_PREVIEW_MAX_PATHS = 200;

export const ThreadRewindTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("checkpoint"), checkpointId: CheckpointId }),
  /** Back to before a user message, or to the end of an assistant message's turn. */
  Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
]);
export type ThreadRewindTarget = typeof ThreadRewindTarget.Type;

export const ThreadRewindPreviewInput = Schema.Struct({
  threadId: ThreadId,
  target: ThreadRewindTarget,
});
export type ThreadRewindPreviewInput = typeof ThreadRewindPreviewInput.Type;

const ThreadRewindFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});

export const ThreadRewindModePreview = Schema.Struct({
  mode: OrchestrationV2RewindMode,
  available: Schema.Boolean,
  /** Why this mode cannot run, in words for the user. */
  unavailableReason: Schema.NullOr(Schema.String),
});
export type ThreadRewindModePreview = typeof ThreadRewindModePreview.Type;

export const ThreadRewindPreview = Schema.Struct({
  threadId: ThreadId,
  checkpointId: CheckpointId,
  scopeId: CheckpointScopeId,
  /** The turn the thread returns to; zero is before its first turn. */
  turn: NonNegativeInt,
  modes: Schema.Array(ThreadRewindModePreview),
  discardedTurns: NonNegativeInt,
  discardedMessages: NonNegativeInt,
  /** How the provider forgets: `fresh_session` means the agent loses the earlier turns too. */
  conversationRollback: Schema.Literals(["native", "fresh_session", "unsupported"]),
  filesChanged: Schema.Array(ThreadRewindFileChange),
  filesChangedCount: NonNegativeInt,
  /** Changes since the last turn's checkpoint, made outside the agent. */
  outsideChanges: Schema.Array(ThreadRewindFileChange),
  outsideChangesCount: NonNegativeInt,
});
export type ThreadRewindPreview = typeof ThreadRewindPreview.Type;

export const ThreadRewindOutsideChanges = Schema.Literals(["stash", "discard"]);
export type ThreadRewindOutsideChanges = typeof ThreadRewindOutsideChanges.Type;

export const ThreadRewindInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  target: ThreadRewindTarget,
  mode: OrchestrationV2RewindMode,
  /** Required when a files rewind would touch changes made outside the agent. */
  outsideChanges: Schema.optional(ThreadRewindOutsideChanges),
  tailThreadId: ThreadId,
});
export type ThreadRewindInput = typeof ThreadRewindInput.Type;

export const ThreadRewindResult = Schema.Struct({
  sequence: NonNegativeInt,
  tailThreadId: ThreadId,
  /** Set when outside changes went to a stash the user can pop. */
  stashedPaths: NonNegativeInt,
});
export type ThreadRewindResult = typeof ThreadRewindResult.Type;

export const ThreadRewindReopenInput = Schema.Struct({
  threadId: ThreadId,
  /** Checks the branch's files out in a worktree of its own, when it kept a snapshot. */
  restoreFiles: Schema.Boolean,
});
export type ThreadRewindReopenInput = typeof ThreadRewindReopenInput.Type;

export const ThreadRewindReopenResult = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type ThreadRewindReopenResult = typeof ThreadRewindReopenResult.Type;

export const ThreadForkPreviewInput = Schema.Struct({
  threadId: ThreadId,
  sourcePoint: OrchestrationV2ThreadForkSourcePoint,
});
export type ThreadForkPreviewInput = typeof ThreadForkPreviewInput.Type;

export const ThreadForkPreview = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  turn: NonNegativeInt,
  carriedMessages: NonNegativeInt,
  estimatedTokens: NonNegativeInt,
  /** `native` when the same agent continues; `portable` replays a bounded transcript. */
  strategy: Schema.Literals(["native", "portable"]),
  cutsTurn: Schema.Boolean,
  lastMessage: Schema.NullOr(Schema.String),
});
export type ThreadForkPreview = typeof ThreadForkPreview.Type;

export class ThreadBranchError extends Schema.TaggedError<ThreadBranchError>()(
  "ThreadBranchError",
  {
    reason: Schema.Literals([
      "target-invalid",
      "outside-changes",
      "shared-workspace",
      "provider-unsupported",
      "not-a-rewind-branch",
      "thread-busy",
      "failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const NestedSessionInherit = Schema.Union([
  Schema.Struct({ type: Schema.Literal("nothing") }),
  /** `text` is the parent's own summary; without one the server writes a digest. */
  Schema.Struct({
    type: Schema.Literal("summary"),
    text: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("transcript"),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
  }),
  Schema.Struct({
    type: Schema.Literal("selection"),
    messageIds: Schema.Array(MessageId).check(Schema.isMaxLength(50)),
    filePaths: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(25)),
  }),
]);
export type NestedSessionInherit = typeof NestedSessionInherit.Type;

export const NestedSessionWorkspace = Schema.Union([
  /** The parent's checkout. Two agents then write to the same files. */
  Schema.Struct({ type: Schema.Literal("shared") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.optional(TrimmedNonEmptyString),
    branch: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type NestedSessionWorkspace = typeof NestedSessionWorkspace.Type;

export const NestedSessionStartInput = Schema.Struct({
  commandId: CommandId,
  parentThreadId: ThreadId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  inherit: NestedSessionInherit,
  workspace: Schema.optional(NestedSessionWorkspace),
  modelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  message: Schema.optional(TrimmedNonEmptyString),
});
export type NestedSessionStartInput = typeof NestedSessionStartInput.Type;

export const NestedSessionStartResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});
export type NestedSessionStartResult = typeof NestedSessionStartResult.Type;

export const NestedSessionReportInput = Schema.Struct({
  threadId: ThreadId,
  summary: TrimmedNonEmptyString,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
  outcome: Schema.optional(OrchestrationV2Notification.fields.outcome),
  /** Starts a turn in the parent so its agent can act on the report. */
  wakeParent: Schema.optional(Schema.Boolean),
});
export type NestedSessionReportInput = typeof NestedSessionReportInput.Type;

export const NestedSessionChildPolicy = Schema.Literals(["keep", "archive", "stop"]);
export type NestedSessionChildPolicy = typeof NestedSessionChildPolicy.Type;

export const NestedSessionCloseParentInput = Schema.Struct({
  threadId: ThreadId,
  children: NestedSessionChildPolicy,
});
export type NestedSessionCloseParentInput = typeof NestedSessionCloseParentInput.Type;

export const NestedSessionCloseParentResult = Schema.Struct({
  archivedThreadIds: Schema.Array(ThreadId),
  stoppedThreadIds: Schema.Array(ThreadId),
  keptThreadIds: Schema.Array(ThreadId),
});
export type NestedSessionCloseParentResult = typeof NestedSessionCloseParentResult.Type;

export class NestedSessionError extends Schema.TaggedError<NestedSessionError>()(
  "NestedSessionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
