import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type BackgroundTask,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ThreadId,
  WorkspaceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { makeSecretMask } from "@t3tools/shared/secretRedaction";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BackgroundTaskService from "./BackgroundTaskService.ts";

const THREAD = ThreadId.make("thread:background");
const ACTOR = { kind: "user", createdBy: "user", creationSource: "web" } as const;

const shell = (overrides: object = {}) =>
  ({
    id: THREAD,
    projectId: ProjectId.make("project:background"),
    worktreePath: process.cwd(),
    deletedAt: null,
    title: "Thread",
    ...overrides,
  }) as never;

type Card = Extract<OrchestrationV2ServerCommand, { readonly type: "thread.handoff-card.post" }>;

const harness = (input: {
  readonly cards: Deferred.Deferred<Card>;
  readonly overrides?: object;
  readonly workspace?: WorkspaceProcessEnvironment.WorkspaceLaunch;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped();
    return BackgroundTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(WorkspaceProcessEnvironment.WorkspaceProcessEnvironment, {
            forThread: () =>
              input.workspace === undefined
                ? Effect.succeedNone
                : Effect.succeedSome(input.workspace),
          }),
          SqlitePersistence.layerMemory,
          AuditTrail.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadShell: () => Effect.succeed(shell(input.overrides)),
            streamDomainEvents: Stream.never,
            dispatch: (command: OrchestrationV2ServerCommand) =>
              command.type === "thread.handoff-card.post"
                ? Deferred.succeed(input.cards, command).pipe(Effect.as({} as never))
                : Effect.succeed({} as never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedNone as never,
          }),
          Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );
  });

const runTask = (
  command: string,
  options: {
    readonly resumeAgent?: boolean;
    readonly overrides?: object;
    readonly workspace?: WorkspaceProcessEnvironment.WorkspaceLaunch;
  } = {},
) =>
  Effect.gen(function* () {
    const cards = yield* Deferred.make<Card>();
    const layer = yield* harness({
      cards,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
    });
    return yield* Effect.gen(function* () {
      const service = yield* BackgroundTaskService.BackgroundTaskService;
      const started = yield* service.start(
        { threadId: THREAD, command, resumeAgent: options.resumeAgent ?? false },
        ACTOR,
      );
      const card = yield* Deferred.await(cards);
      const { tasks } = yield* service.list({ threadId: THREAD });
      const log = yield* service.readLog({ id: started.id });
      return { card, task: tasks[0] as BackgroundTask, log };
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("BackgroundTaskService", () => {
  it.live("records a finished command, its log, and a card in the thread", () =>
    Effect.gen(function* () {
      const { card, task, log } = yield* runTask("echo first; echo last line");
      assert.equal(task.state, "succeeded");
      assert.equal(task.exitCode, 0);
      assert.equal(task.lastOutputLine, "last line");
      assert.equal(log.text, "first\nlast line\n");
      assert.equal(card.notification.outcome, "completed");
      assert.isUndefined(card.wake);
    }),
  );

  it.live(
    "injects workspace credentials only into the child and redacts logs and handoff cards",
    () =>
      Effect.gen(function* () {
        const secret = "background-secret-value";
        const { task, log, card } = yield* runTask('printf "%s\\n" "$T3PP_TEST_WORKSPACE_TOKEN"', {
          overrides: { worktreePath: null },
          workspace: {
            workspaceId: WorkspaceId.make("workspace"),
            workspaceName: "test",
            workingRoot: process.cwd(),
            environment: Redacted.make({ T3PP_TEST_WORKSPACE_TOKEN: secret }),
            secretNames: ["T3PP_TEST_WORKSPACE_TOKEN"],
            mask: makeSecretMask([{ name: "TOKEN", value: secret }]),
            settings: {},
            fingerprint: "test",
          },
        });
        assert.equal(task.state, "succeeded");
        assert.equal(log.text, "[secret:TOKEN]\n");
        assert.notInclude(JSON.stringify({ task, log, card }), secret);
        assert.isUndefined(process.env.T3PP_TEST_WORKSPACE_TOKEN);
      }),
  );
  it.live("a failing command is failed, and resumeAgent wakes the thread", () =>
    Effect.gen(function* () {
      const { card, task } = yield* runTask("exit 3", { resumeAgent: true });
      assert.equal(task.state, "failed");
      assert.equal(task.exitCode, 3);
      assert.equal(card.notification.outcome, "failed");
      assert.isDefined(card.wake);
    }),
  );

  it.effect("refuses a command in a Chat conversation", () =>
    Effect.gen(function* () {
      const cards = yield* Deferred.make<Card>();
      const layer = yield* harness({ cards, overrides: { capabilityMode: "chat" } });
      const error = yield* Effect.gen(function* () {
        const service = yield* BackgroundTaskService.BackgroundTaskService;
        return yield* service
          .start({ threadId: THREAD, command: "echo hi" }, ACTOR)
          .pipe(Effect.flip);
      }).pipe(Effect.provide(layer));
      assert.equal(error.reason, "chat-mode");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("takes the last real line, without terminal escapes", () => {
    assert.equal(
      BackgroundTaskService.lastOutputLine("\u001b[32mready\u001b[0m in 3ms\r\n\r\n"),
      "ready in 3ms",
    );
    assert.isNull(BackgroundTaskService.lastOutputLine("\n  \n"));
  });

  it("follows a nested session's thread rather than guessing", () => {
    const state = BackgroundTaskService.nestedSessionTaskState;
    const idle = { activityRunStatus: null, pendingRuntimeRequest: null, status: "idle" } as const;
    assert.equal(state({ ...idle, status: "completed" }), "succeeded");
    assert.equal(state({ ...idle, status: "failed" }), "failed");
    assert.equal(state({ ...idle, status: "interrupted" }), "stopped");
    assert.equal(state({ ...idle, activityRunStatus: "running", status: "running" }), "running");
    assert.equal(
      state({
        ...idle,
        activityRunStatus: "running",
        status: "running",
        pendingRuntimeRequest: { kind: "approval" } as never,
      }),
      "needs_input",
    );
  });
});
