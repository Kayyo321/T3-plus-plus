import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OrchestratorAgent from "../../../orchestratorAgent/OrchestratorAgent.ts";
import * as SupervisionMonitor from "../../../orchestratorAgent/SupervisionMonitor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { EditorToolkit } from "./tools.ts";

const requireEditor = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.capabilities.has("editor")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "Only the orchestrator can use this tool.",
          }),
        ),
  ),
);

export const layer = McpToolAccess.toLayer(EditorToolkit, {
  editor_ui: McpToolAccess.reads(({ directive }) =>
    Effect.gen(function* () {
      yield* requireEditor;
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      return { clients: yield* agent.directive(directive) };
    }),
  ),
  supervision_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* requireEditor;
      const monitor = yield* SupervisionMonitor.SupervisionMonitor;
      return { threads: yield* monitor.status };
    }),
  ),
  supervision_decide: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      yield* requireEditor;
      const monitor = yield* SupervisionMonitor.SupervisionMonitor;
      yield* monitor.decide(input);
      return { recorded: true as const };
    }),
  ),
  supervision_watch: McpToolAccess.reads(({ threadId, mode }) =>
    Effect.gen(function* () {
      yield* requireEditor;
      const monitor = yield* SupervisionMonitor.SupervisionMonitor;
      yield* monitor.setThreadMode({ threadId, mode });
      return { mode };
    }),
  ),
});
