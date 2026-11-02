import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as OrchestratorAgent from "../../../orchestratorAgent/OrchestratorAgent.ts";
import * as SupervisionMonitor from "../../../orchestratorAgent/SupervisionMonitor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { dispatchFailure, newCommandId, readThread } from "../../threadAccess.ts";
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
  orchestrator_react: McpToolAccess.reads(({ emoji }) =>
    Effect.gen(function* () {
      yield* requireEditor;
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      return yield* agent.reactToOwner(emoji);
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
      const { effectiveMode, modeSource } = yield* monitor.threadState(threadId);
      return { mode: effectiveMode, source: modeSource };
    }),
  ),
  t3_thread_delete: McpToolAccess.writesThreads(
    ({ threadId }) => [threadId],
    ({ threadId }) =>
      Effect.gen(function* () {
        yield* requireEditor;
        const { threads, projection, caller } = yield* readThread(threadId);
        if (caller?.id === projection.thread.id) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "You cannot delete your own conversation.",
          });
        }
        const result = yield* threads
          .dispatch({
            type: "thread.delete",
            commandId: yield* newCommandId(),
            threadId: projection.thread.id,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
  ),
});
