import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  NestedSessionChildPolicy,
  type NestedSessionStartInput,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as NestedSessionService from "./NestedSessionService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const ACTOR = { kind: "user", createdBy: "user", creationSource: "web" } as const;
const PARENT = ThreadId.make("thread:parent");
const CHILD = ThreadId.make("thread:child");
const GRANDCHILD = ThreadId.make("thread:grandchild");
const UNRELATED = ThreadId.make("thread:plain-fork");
const PROJECT = ProjectId.make("project:parent");
const DISABLED = ProviderInstanceId.make("codex-disabled");

const shell = (
  id: ThreadId,
  parentThreadId: ThreadId | null,
  options: { readonly nested: boolean; readonly running?: boolean },
) =>
  ({
    id,
    title: id,
    archivedAt: null,
    activityRunStatus: options.running ? "running" : null,
    lineage: {
      parentThreadId,
      relationshipToParent: parentThreadId === null ? null : "fork",
      rootThreadId: PARENT,
      ...(options.nested ? { nestedSession: true } : {}),
    },
  }) as never;

const family = [
  shell(PARENT, null, { nested: false }),
  shell(CHILD, PARENT, { nested: true, running: true }),
  shell(GRANDCHILD, CHILD, { nested: true }),
  shell(UNRELATED, PARENT, { nested: false }),
];

const closeWith = (children: typeof NestedSessionChildPolicy.Type) => {
  const archived: Array<ThreadId> = [];
  const stopped: Array<ThreadId> = [];
  const layer = NestedSessionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          readShellSnapshot: () => Effect.succeed(Effect.succeed({ threads: family } as never)),
          dispatch: (command: OrchestrationV2ServerCommand) =>
            Effect.sync(() => {
              if (command.type === "thread.archive") archived.push(command.threadId);
              return {} as never;
            }),
          forceStopThread: (input) =>
            Effect.sync(() => {
              stopped.push(input.threadId);
              return {} as never;
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
        Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
        NodeServices.layer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* NestedSessionService.NestedSessionService;
    const result = yield* service.closeParent({ threadId: PARENT, children }, ACTOR);
    return { result, archived, stopped };
  }).pipe(Effect.provide(layer));
};

describe("closing a parent", () => {
  it.effect("keep leaves every nested session running and archives only the parent", () =>
    Effect.gen(function* () {
      const { result, archived, stopped } = yield* closeWith("keep");
      assert.deepEqual(archived, [PARENT]);
      assert.deepEqual(stopped, []);
      assert.deepEqual(result.keptThreadIds, [CHILD, GRANDCHILD]);
    }),
  );

  it.effect("archive stops live work and archives children deepest first", () =>
    Effect.gen(function* () {
      const { result, archived, stopped } = yield* closeWith("archive");
      assert.deepEqual(archived, [GRANDCHILD, CHILD, PARENT]);
      assert.deepEqual(stopped, [CHILD]);
      assert.deepEqual(result.keptThreadIds, []);
    }),
  );

  it.effect("stop ends live work but keeps the children in the list", () =>
    Effect.gen(function* () {
      const { result, archived, stopped } = yield* closeWith("stop");
      assert.deepEqual(archived, [PARENT]);
      assert.deepEqual(stopped, [CHILD]);
      assert.deepEqual(result.keptThreadIds, [CHILD, GRANDCHILD]);
    }),
  );
});

const startInput = (overrides: Partial<NestedSessionStartInput> = {}) =>
  ({
    commandId: CommandId.make("command:start-nested"),
    parentThreadId: PARENT,
    threadId: CHILD,
    inherit: { type: "nothing" },
    modelSelection: { instanceId: DISABLED, model: "gpt-5" },
    ...overrides,
  }) as NestedSessionStartInput;

const startWith = (
  input: NestedSessionStartInput,
  mocks: {
    readonly assertEnabled?: () => Effect.Effect<
      void,
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
    readonly launch?: () => Effect.Effect<never, ThreadLaunchService.ThreadLaunchError>;
  },
) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const thread = {
    id: PARENT,
    title: "Parent",
    projectId: PROJECT,
    branch: null,
    worktreePath: null,
    modelSelection: { instanceId: DISABLED, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
  } as never;
  const layer = NestedSessionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          assertProviderInstanceEnabled: mocks.assertEnabled ?? (() => Effect.void),
          dispatch: (command: OrchestrationV2ServerCommand) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 1 } as never;
            }),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: mocks.launch ?? (() => Effect.succeed({} as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread: () => Effect.succeed(thread) }),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
        Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
        NodeServices.layer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* NestedSessionService.NestedSessionService;
    const error = yield* service.start(input, ACTOR).pipe(Effect.flip);
    return { error, dispatched };
  }).pipe(Effect.provide(layer));
};

describe("deleting a parent", () => {
  const deleteWith = (children: "keep" | "delete") => {
    const deleted: Array<ThreadId> = [];
    const layer = NestedSessionService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            readShellSnapshot: () => Effect.succeed(Effect.succeed({ threads: family } as never)),
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Effect.sync(() => {
                if (command.type === "thread.delete") deleted.push(command.threadId);
                return {} as never;
              }),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          Layer.mock(ProjectStore.ProjectStoreV2)({}),
          Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
          Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
          NodeServices.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* NestedSessionService.NestedSessionService;
      const result = yield* service.deleteParent({ threadId: PARENT, children }, ACTOR);
      return { result, deleted };
    }).pipe(Effect.provide(layer));
  };

  it.effect("delete removes nested sessions deepest first, then the parent", () =>
    Effect.gen(function* () {
      const { result, deleted } = yield* deleteWith("delete");
      assert.deepEqual(deleted, [GRANDCHILD, CHILD, PARENT]);
      assert.deepEqual(result.deletedThreadIds, deleted);
    }),
  );

  it.effect("keep removes only the parent", () =>
    Effect.gen(function* () {
      const { deleted } = yield* deleteWith("keep");
      assert.deepEqual(deleted, [PARENT]);
    }),
  );
});

describe("starting a nested session", () => {
  it.effect("refuses a disabled provider before forking the thread", () =>
    Effect.gen(function* () {
      const { error, dispatched } = yield* startWith(startInput(), {
        assertEnabled: () =>
          Effect.fail(
            new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
              projectId: PROJECT,
              instanceId: DISABLED,
            }),
          ),
      });
      assert.deepEqual(
        dispatched.map((command) => command.type),
        [],
      );
      assert.include(error.detail, "is disabled for project");
    }),
  );

  it.effect(
    "removes the child and reports the launch failure when its first turn cannot start",
    () =>
      Effect.gen(function* () {
        const launchFailure = new ThreadLaunchService.ThreadLaunchError({
          operation: "dispatch-message",
          commandId: CommandId.make("command:launch"),
          projectId: PROJECT,
          threadId: CHILD,
          cause: new Error("Provider refused the first turn."),
        });
        const { error, dispatched } = yield* startWith(startInput({ message: "hello" }), {
          launch: () => Effect.fail(launchFailure),
        });
        assert.deepEqual(
          dispatched.map((command) => command.type),
          ["thread.fork", "thread.delete"],
        );
        const removed = dispatched.flatMap((command) =>
          command.type === "thread.delete" ? [command.threadId] : [],
        );
        assert.deepEqual(removed, [CHILD]);
        assert.equal(error.detail, launchFailure.message);
      }),
  );
});

describe("digesting a parent for a summary", () => {
  it("keeps the newest lines when the conversation is too long", () => {
    const item = (text: string) => ({ type: "user_message", text }) as never;
    const digest = NestedSessionService.digestConversation(
      Array.from({ length: 2_000 }, (_, index) => item(`message ${index} ${"x".repeat(100)}`)),
    );
    assert.include(digest, "Earlier items truncated");
    assert.include(digest, "message 1999");
    assert.notInclude(digest, "message 0 ");
  });
});
