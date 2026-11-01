import {
  BackgroundTask,
  BackgroundTaskId,
  BackgroundTaskKind,
  BackgroundTaskListResult,
  BackgroundTaskLogResult,
  ModelSelection,
  NestedSessionChildPolicy,
  NestedSessionCloseParentResult,
  NestedSessionInherit,
  NestedSessionReportInput,
  NestedSessionWorkspace,
  OrchestrationV2RewindMode,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RunId,
  RuntimeMode,
  ThreadForkPreview,
  ThreadId,
  ThreadRewindOutsideChanges,
  ThreadRewindPreview,
  ThreadRewindReopenResult,
  ThreadRewindResult,
  ThreadRewindTarget,
  TrimmedNonEmptyString,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BackgroundTaskService from "../../../backgroundTasks/BackgroundTaskService.ts";
import * as NestedSessionService from "../../../orchestration-v2/NestedSessionService.ts";
import * as ThreadBranchService from "../../../orchestration-v2/ThreadBranchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};

const nestedDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  NestedSessionService.NestedSessionService,
  Crypto.Crypto,
];
const branchDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadBranchService.ThreadBranchService,
  Crypto.Crypto,
];
const backgroundDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BackgroundTaskService.BackgroundTaskService,
];

const StartNestedSessionTool = Tool.make("start_nested_session", {
  ...base,
  description:
    "Start a nested session under this thread on the user's behalf: a durable child conversation the user can open and talk to. Not for a task whose result only you need; use `delegate_task`. `inherit`: nothing, summary, transcript, or selection. Its `threadId` works with `t3_thread_send`, `t3_thread_wait`, and `t3_thread_read`. Depth is limited.",
  parameters: Schema.Struct({
    title: Schema.optional(TrimmedNonEmptyString),
    inherit: NestedSessionInherit,
    workspace: Schema.optional(NestedSessionWorkspace),
    modelSelection: Schema.optional(ModelSelection),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
    message: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    runId: Schema.NullOr(RunId),
    link: Schema.optional(Schema.String),
  }),
  dependencies: nestedDependencies,
})
  .annotate(Tool.Title, "Start a nested session")
  .annotate(Tool.Destructive, true);

const ReportToParentTool = Tool.make("report_to_parent", {
  ...base,
  description:
    "From a nested session: leave a summary card in the parent thread. Say what changed and what it needs, not your transcript. `wakeParent` starts a turn there.",
  parameters: Schema.Struct({
    summary: NestedSessionReportInput.fields.summary,
    detail: NestedSessionReportInput.fields.detail,
    outcome: NestedSessionReportInput.fields.outcome,
    wakeParent: NestedSessionReportInput.fields.wakeParent,
  }),
  success: Schema.Struct({}),
  dependencies: nestedDependencies,
})
  .annotate(Tool.Title, "Report to the parent thread")
  .annotate(Tool.Destructive, false);

const ThreadCloseTool = Tool.make("t3_thread_close", {
  ...base,
  description:
    "Archive a thread and say what happens to its nested sessions. `children`: keep, archive, or stop them. Ask the user which unless they said.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    children: NestedSessionChildPolicy,
  }),
  success: NestedSessionCloseParentResult,
  dependencies: nestedDependencies,
})
  .annotate(Tool.Title, "Close a thread and its nested sessions")
  .annotate(Tool.Destructive, true);

const ThreadRewindTool = Tool.make("t3_thread_rewind", {
  ...base,
  description:
    "Return a thread to an earlier point. preview: what each mode would change. rewind: `mode` conversation, files, or both. What it discards stays on an archived branch; `outsideChanges` is required when files changed outside the agent. reopen: bring that branch back. Omit `threadId` for this thread, but you cannot rewind your own running turn.",
  parameters: Schema.Struct({
    action: Schema.Literals(["preview", "rewind", "reopen"]),
    threadId: Schema.optional(ThreadId),
    target: Schema.optional(ThreadRewindTarget),
    mode: Schema.optional(OrchestrationV2RewindMode),
    outsideChanges: Schema.optional(ThreadRewindOutsideChanges),
    restoreFiles: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([ThreadRewindPreview, ThreadRewindResult, ThreadRewindReopenResult]),
  dependencies: branchDependencies,
})
  .annotate(Tool.Title, "Rewind a thread")
  .annotate(Tool.Destructive, true);

const ThreadForkPreviewTool = Tool.make("t3_thread_fork_preview", {
  ...base,
  description:
    "What a fork from `sourcePoint` would carry: messages, estimated tokens, and whether the same agent continues. `sourcePoint` may name a message. Fork with `t3_thread_transfer`.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  }),
  success: ThreadForkPreview,
  dependencies: branchDependencies,
})
  .annotate(Tool.Title, "Preview a fork")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BackgroundTaskStartTool = Tool.make("background_task_start", {
  ...base,
  description:
    "Run a shell command attached to this thread without blocking it: a test run, dev server, or watcher. Stdin is closed, so it cannot prompt. It outlives your turn. Or pass `childThreadId` to follow a nested session instead. `resumeAgent` starts a turn here when it ends.",
  parameters: Schema.Struct({
    command: Schema.optional(TrimmedNonEmptyString),
    childThreadId: Schema.optional(ThreadId),
    name: Schema.optional(TrimmedNonEmptyString),
    kind: Schema.optional(BackgroundTaskKind),
    resumeAgent: Schema.optional(Schema.Boolean),
  }),
  success: BackgroundTask,
  dependencies: backgroundDependencies,
})
  .annotate(Tool.Title, "Start a background task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const BackgroundTaskListTool = Tool.make("background_task_list", {
  ...base,
  description: "List background tasks and their state. Omit `threadId` for this thread's.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: BackgroundTaskListResult,
  dependencies: backgroundDependencies,
})
  .annotate(Tool.Title, "List background tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BackgroundTaskLogTool = Tool.make("background_task_log", {
  ...base,
  description:
    "Read the end of a background task's log. Bounded; older output may be rotated away.",
  parameters: Schema.Struct({
    id: BackgroundTaskId,
    tailBytes: Schema.optional(NonNegativeInt),
  }),
  success: BackgroundTaskLogResult,
  dependencies: backgroundDependencies,
})
  .annotate(Tool.Title, "Read a background task's log")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const BackgroundTaskStopTool = Tool.make("background_task_stop", {
  ...base,
  description: "Stop a running background task and everything it started.",
  parameters: Schema.Struct({ id: BackgroundTaskId }),
  success: BackgroundTask,
  dependencies: backgroundDependencies,
})
  .annotate(Tool.Title, "Stop a background task")
  .annotate(Tool.Destructive, true);

export const SessionsToolkit = Toolkit.make(
  StartNestedSessionTool,
  ReportToParentTool,
  ThreadCloseTool,
  ThreadRewindTool,
  ThreadForkPreviewTool,
  BackgroundTaskStartTool,
  BackgroundTaskListTool,
  BackgroundTaskLogTool,
  BackgroundTaskStopTool,
);
