import {
  ComputerUseActInput,
  ComputerUseActResult,
  ComputerUseState,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ComputerUseService.ComputerUseService,
  PreviewAutomationBroker.PreviewAutomationBroker,
];

const enabledWithComputerUse = McpInvocationContext.enabledWithCapability("computer-use");

const ComputerStatusTool = Tool.make("computer_status", {
  description:
    "Whether computer use is on for this conversation, and on which target. It is off until the user turns it on. `display` names a virtual display: start apps on it from your shell.",
  parameters: Tool.EmptyParams,
  success: ComputerUseState,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get computer use status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, enabledWithComputerUse);

export const ComputerScreenshotTool = Tool.make("computer_screenshot", {
  description: "Take a screenshot of this conversation's computer use target.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    stepId: Schema.String,
    screenshot: Schema.Struct({ mimeType: Schema.Literal("image/png"), data: Schema.String }),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Screenshot the computer")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabledWithComputerUse);

const ComputerActTool = Tool.make("computer_act", {
  description:
    "Do one step on this conversation's computer use target: click, type, press a key, scroll, or navigate. Every step is logged for the user. Buying, sending, and deleting wait for their approval. Never type a credential: ask the user to take over.",
  parameters: ComputerUseActInput,
  success: ComputerUseActResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Act on the computer")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, enabledWithComputerUse);

export const ComputerUseStandardToolkit = Toolkit.make(ComputerStatusTool, ComputerActTool);
export const ComputerScreenshotToolkit = Toolkit.make(ComputerScreenshotTool);
