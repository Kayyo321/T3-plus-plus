import { CommandId, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import * as BackgroundTaskService from "../../../backgroundTasks/BackgroundTaskService.ts";
import * as NestedSessionService from "../../../orchestration-v2/NestedSessionService.ts";
import type { DispatchActor } from "../../../orchestration-v2/NestedSessionService.ts";
import * as ThreadBranchService from "../../../orchestration-v2/ThreadBranchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SessionsToolkit } from "./tools.ts";

const toFailure = (cause: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: cause.message });

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(invalid(`This action needs \`${name}\`.`))
    : Effect.succeed(value);

const agentActor = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return {
    kind: "agent",
    label: scope.thread?.providerInstanceId ?? scope.client?.label,
    createdBy: "agent",
    creationSource: "mcp",
  } satisfies DispatchActor;
});

const callerThreadId = (threadId: ThreadId | undefined, operation: string) =>
  threadId === undefined
    ? McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
        Effect.map((scope) => scope.thread.threadId),
      )
    : Effect.succeed(threadId);

const newId = (prefix: string) =>
  Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4()).pipe(
    Effect.orDie,
    Effect.map((id) => `${prefix}:${id}`),
  );

export const layer = McpToolAccess.toLayer(SessionsToolkit, {
  start_nested_session: McpToolAccess.startsThreads(
    (input) => input,
    (input, modes) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const caller = yield* McpInvocationContext.requireThreadScope(
          scope,
          "start_nested_session",
        );
        const sessions = yield* NestedSessionService.NestedSessionService;
        const started = yield* sessions
          .start(
            {
              ...input,
              ...(modes.runtimeMode === undefined ? {} : { runtimeMode: modes.runtimeMode }),
              ...(modes.interactionMode === undefined
                ? {}
                : { interactionMode: modes.interactionMode }),
              commandId: CommandId.make(yield* newId("command:mcp-nested-session")),
              parentThreadId: caller.thread.threadId,
              threadId: ThreadId.make(yield* newId("thread:nested")),
            },
            yield* agentActor,
          )
          .pipe(Effect.mapError(toFailure));
        return {
          threadId: started.threadId,
          runId: started.runId,
          link: McpInvocationContext.threadLinkFor(scope, started.threadId),
        };
      }),
    { refused: "A linked environment cannot nest sessions under a thread here." },
  ),
  report_to_parent: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId(undefined, "report_to_parent");
      const sessions = yield* NestedSessionService.NestedSessionService;
      yield* sessions
        .report({ ...input, threadId }, yield* agentActor)
        .pipe(Effect.mapError(toFailure));
      return {};
    }),
  ),
  t3_thread_close: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThreadId(input.threadId, "t3_thread_close");
        const sessions = yield* NestedSessionService.NestedSessionService;
        return yield* sessions
          .closeParent({ threadId, children: input.children }, yield* agentActor)
          .pipe(Effect.mapError(toFailure));
      }),
  ),
  t3_thread_rewind: McpToolAccess.either(
    (input) => input.action === "preview",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const threadId = yield* callerThreadId(input.threadId, "t3_thread_rewind");
        const branches = yield* ThreadBranchService.ThreadBranchService;
        return yield* branches
          .previewRewind({ threadId, target: yield* required(input.target, "target") })
          .pipe(Effect.mapError(toFailure));
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId],
      (input) =>
        Effect.gen(function* () {
          const threadId = yield* callerThreadId(input.threadId, "t3_thread_rewind");
          const branches = yield* ThreadBranchService.ThreadBranchService;
          const actor = yield* agentActor;
          if (input.action === "reopen") {
            return yield* branches
              .reopenRewindBranch({ threadId, restoreFiles: input.restoreFiles ?? false }, actor)
              .pipe(Effect.mapError(toFailure));
          }
          return yield* branches
            .rewind(
              {
                commandId: CommandId.make(yield* newId("command:mcp-rewind")),
                threadId,
                target: yield* required(input.target, "target"),
                mode: yield* required(input.mode, "mode"),
                tailThreadId: ThreadId.make(yield* newId("thread:rewind")),
                ...(input.outsideChanges === undefined
                  ? {}
                  : { outsideChanges: input.outsideChanges }),
              },
              actor,
            )
            .pipe(Effect.mapError(toFailure));
        }),
    ),
  ),
  t3_thread_fork_preview: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId(input.threadId, "t3_thread_fork_preview");
      const branches = yield* ThreadBranchService.ThreadBranchService;
      return yield* branches
        .previewFork({ threadId, sourcePoint: input.sourcePoint })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  background_task_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId(undefined, "background_task_start");
      const tasks = yield* BackgroundTaskService.BackgroundTaskService;
      return yield* tasks
        .start({ ...input, threadId }, yield* agentActor)
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  background_task_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId(input.threadId, "background_task_list");
      const tasks = yield* BackgroundTaskService.BackgroundTaskService;
      return yield* tasks.list({ threadId }).pipe(Effect.mapError(toFailure));
    }),
  ),
  background_task_log: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const tasks = yield* BackgroundTaskService.BackgroundTaskService;
      return yield* tasks.readLog(input).pipe(Effect.mapError(toFailure));
    }),
  ),
  background_task_stop: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const tasks = yield* BackgroundTaskService.BackgroundTaskService;
      return yield* tasks.stop(input, yield* agentActor).pipe(Effect.mapError(toFailure));
    }),
  ),
});
