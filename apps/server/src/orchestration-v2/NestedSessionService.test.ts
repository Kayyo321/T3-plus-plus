import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NestedSessionChildPolicy,
  type OrchestrationV2ServerCommand,
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
