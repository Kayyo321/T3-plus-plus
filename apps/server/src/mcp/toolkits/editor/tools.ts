import {
  OrchestratorMcpFailure,
  OrchestratorUiDirective,
  SupervisionThreadMode,
  SupervisionThreadState,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

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

const SupervisionStatusTool = Tool.make("supervision_status", {
  ...shared,
  description: "List the conversations under supervision, with their review counts.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    threads: Schema.Array(Schema.Struct({ threadId: ThreadId, state: SupervisionThreadState })),
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
    "Turn supervision on or off for a conversation. Off means let it run. Use it only when the owner asks.",
  parameters: Schema.Struct({ threadId: ThreadId, mode: SupervisionThreadMode }),
  success: Schema.Struct({ mode: SupervisionThreadMode }),
});

export const EditorToolkit = Toolkit.make(
  EditorUiTool,
  SupervisionStatusTool,
  SupervisionDecideTool,
  SupervisionWatchTool,
);
