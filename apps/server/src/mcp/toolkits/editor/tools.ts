import {
  ORCHESTRATOR_SILENT_REPLY,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpFailure,
  OrchestratorReactionEmoji,
  OrchestratorUiDirective,
  SupervisionMode,
  SupervisionModeSource,
  SupervisionThreadState,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorAgent from "../../../orchestratorAgent/OrchestratorAgent.ts";
import * as SupervisionMonitor from "../../../orchestratorAgent/SupervisionMonitor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestratorAgent.OrchestratorAgent,
    SupervisionMonitor.SupervisionMonitor,
  ],
};

const EditorUiTool = Tool.make("editor_ui", {
  ...shared,
  description:
    "Act on the owner's open app: open or close a panel, apply a saved layout, open a conversation, or split one beside the current view. Reports how many clients received it; zero means no client is open.",
  parameters: Schema.Struct({ directive: OrchestratorUiDirective }),
  success: Schema.Struct({ clients: Schema.Number }),
});

const OrchestratorReactTool = Tool.make("orchestrator_react", {
  ...shared,
  description: `React to the owner's latest message with one emoji. When their message needs no answer, such as thanks, this is your whole response: call it, then reply exactly ${ORCHESTRATOR_SILENT_REPLY}. The same emoji again removes it; a different one replaces yours.`,
  parameters: Schema.Struct({ emoji: OrchestratorReactionEmoji }),
  success: Schema.Struct({ emoji: OrchestratorReactionEmoji, reacted: Schema.Boolean }),
});

const SupervisionStatusTool = Tool.make("supervision_status", {
  ...shared,
  description:
    "List the conversations under supervision, with their effective mode and review counts.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({ threadId: ThreadId, mode: SupervisionMode, state: SupervisionThreadState }),
    ),
  }),
});

const SupervisionDecideTool = Tool.make("supervision_decide", {
  ...shared,
  description:
    "Record your verdict on a supervision review. `leave` with `snoozeMinutes` when the work is fine, with why. `escalate` tells the owner, with a short diagnosis and options.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    decision: Schema.Literals(["leave", "escalate"]),
    note: TrimmedNonEmptyString,
    snoozeMinutes: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
    ),
  }),
  success: Schema.Struct({ recorded: Schema.Literal(true) }),
});

const SupervisionWatchTool = Tool.make("supervision_watch", {
  ...shared,
  description:
    "Set a conversation's supervision: off (let it run), modest, or aggressive, or null to follow the default. A project's setting wins over this; the result says which mode applies and why. Use it only when the owner asks.",
  parameters: Schema.Struct({ threadId: ThreadId, mode: Schema.NullOr(SupervisionMode) }),
  success: Schema.Struct({ mode: SupervisionMode, source: SupervisionModeSource }),
});

const ThreadDeleteTool = Tool.make("t3_thread_delete", {
  ...shared,
  description:
    "Delete a conversation and its side chats for good, stopping anything it is running. Its files and worktree stay on disk. This cannot be undone, so archive with t3_thread_organize unless the owner asked to delete. You cannot delete your own conversation.",
  parameters: Schema.Struct({ threadId: ThreadId }),
  success: OrchestrationV2DispatchCommandResult,
  dependencies: [
    ...shared.dependencies,
    ThreadManagementService.ThreadManagementService,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Title, "Delete a thread")
  .annotate(Tool.Destructive, true);

export const EditorToolkit = Toolkit.make(
  EditorUiTool,
  OrchestratorReactTool,
  SupervisionStatusTool,
  SupervisionDecideTool,
  SupervisionWatchTool,
  ThreadDeleteTool,
);
