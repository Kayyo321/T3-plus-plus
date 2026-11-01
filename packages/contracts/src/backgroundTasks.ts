import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BackgroundTaskId = TrimmedNonEmptyString.pipe(Schema.brand("BackgroundTaskId"));
export type BackgroundTaskId = typeof BackgroundTaskId.Type;

export const BackgroundTaskKind = Schema.Literals([
  "command",
  "dev_server",
  "watcher",
  "nested_session",
]);
export type BackgroundTaskKind = typeof BackgroundTaskKind.Type;

/**
 * `lost` means the server restarted under the task, so nobody knows how it ended. Commands run
 * with stdin closed and cannot ask for anything; only a nested session reaches `needs_input`.
 */
export const BackgroundTaskState = Schema.Literals([
  "running",
  "needs_input",
  "succeeded",
  "failed",
  "stopped",
  "lost",
]);
export type BackgroundTaskState = typeof BackgroundTaskState.Type;

export const isBackgroundTaskLive = (state: BackgroundTaskState): boolean =>
  state === "running" || state === "needs_input";

export const BACKGROUND_TASK_LAST_LINE_MAX_CHARS = 200;
export const BACKGROUND_TASK_LOG_PAGE_MAX_BYTES = 256 * 1024;
export const BACKGROUND_TASK_LIST_MAX = 200;

export const BackgroundTask = Schema.Struct({
  id: BackgroundTaskId,
  threadId: ThreadId,
  kind: BackgroundTaskKind,
  name: TrimmedNonEmptyString,
  command: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  childThreadId: Schema.NullOr(ThreadId),
  state: BackgroundTaskState,
  exitCode: Schema.NullOr(Schema.Int),
  lastOutputLine: Schema.NullOr(Schema.String),
  resumeAgent: Schema.Boolean,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type BackgroundTask = typeof BackgroundTask.Type;

export const BackgroundTaskStartInput = Schema.Struct({
  threadId: ThreadId,
  kind: Schema.optional(BackgroundTaskKind),
  name: Schema.optional(TrimmedNonEmptyString),
  /** A shell command. Absent for a task that follows a nested session. */
  command: Schema.optional(TrimmedNonEmptyString),
  /** The nested session this task follows. */
  childThreadId: Schema.optional(ThreadId),
  /** Starts a turn in the thread when the task ends. */
  resumeAgent: Schema.optional(Schema.Boolean),
});
export type BackgroundTaskStartInput = typeof BackgroundTaskStartInput.Type;

export const BackgroundTaskRefInput = Schema.Struct({ id: BackgroundTaskId });
export type BackgroundTaskRefInput = typeof BackgroundTaskRefInput.Type;

export const BackgroundTaskListInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
});
export type BackgroundTaskListInput = typeof BackgroundTaskListInput.Type;

export const BackgroundTaskListResult = Schema.Struct({
  tasks: Schema.Array(BackgroundTask),
});
export type BackgroundTaskListResult = typeof BackgroundTaskListResult.Type;

export const BackgroundTaskLogInput = Schema.Struct({
  id: BackgroundTaskId,
  /** How much of the end of the log to return; capped per page. */
  tailBytes: Schema.optional(NonNegativeInt),
});
export type BackgroundTaskLogInput = typeof BackgroundTaskLogInput.Type;

export const BackgroundTaskLogResult = Schema.Struct({
  id: BackgroundTaskId,
  text: Schema.String,
  /** Older output exists in the file, or was rotated away. */
  truncated: Schema.Boolean,
  logPath: Schema.NullOr(Schema.String),
});
export type BackgroundTaskLogResult = typeof BackgroundTaskLogResult.Type;

export const BackgroundTaskStreamItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), tasks: Schema.Array(BackgroundTask) }),
  Schema.Struct({ type: Schema.Literal("upsert"), task: BackgroundTask }),
  Schema.Struct({ type: Schema.Literal("remove"), id: BackgroundTaskId }),
]);
export type BackgroundTaskStreamItem = typeof BackgroundTaskStreamItem.Type;

export class BackgroundTaskError extends Schema.TaggedError<BackgroundTaskError>()(
  "BackgroundTaskError",
  {
    reason: Schema.Literals(["not-found", "invalid", "chat-mode", "failed"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
