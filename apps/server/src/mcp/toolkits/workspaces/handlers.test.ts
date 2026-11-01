import { expect, it } from "@effect/vitest";
import {
  ConversationFolderId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceId,
  type WorkspaceAttachInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ConversationFolders from "../../../conversationFolders/ConversationFolderService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Workspaces from "../../../workspace/WorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorkspacesHandlers from "./handlers.ts";
import { WorkspacesToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:workspaces");
const threadId = ThreadId.make("thread:workspaces");
const projectId = ProjectId.make("project:workspaces");
const workspaceId = WorkspaceId.make("workspace:staging");
const folderId = ConversationFolderId.make("folder:inbox");

const catalog = {
  workspaces: [
    {
      id: workspaceId,
      name: "staging",
      folders: ["/srv/staging"],
      workingRoot: "/srv/staging",
      secrets: [
        { name: "DATABASE_URL", source: "stored", unmasked: false, updatedAt: "2026-11-01" },
      ],
      settings: {},
      createdAt: "2026-11-01",
      updatedAt: "2026-11-01",
      deletedAt: null,
    },
  ],
  attachments: [{ target: { kind: "project", projectId }, workspaceId }],
} as unknown as Workspaces.WorkspaceService["Service"]["catalog"] extends Effect.Effect<
  infer A,
  infer _E,
  infer _R
>
  ? A
  : never;

const call = <Name extends "t3_workspace_list" | "t3_folder_list">(
  name: Name,
  params: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const toolkit = yield* WorkspacesToolkit;
    const results = yield* toolkit
      .handle(name, params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  });

const layerFor = (attached: Ref.Ref<ReadonlyArray<WorkspaceAttachInput>>) =>
  McpToolAccess.HandlersLayer.layer(WorkspacesHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:workspaces",
          thread: {
            threadId,
            providerSessionId: "provider:workspaces",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
        Layer.mock(Workspaces.WorkspaceService)({
          catalog: Effect.succeed(catalog),
          attach: (input) => Ref.update(attached, (inputs) => [...inputs, input]),
        }),
        Layer.mock(ConversationFolders.ConversationFolderService)({
          snapshot: Effect.succeed({
            folders: [
              {
                id: folderId,
                parentId: null,
                name: "Inbox" as never,
                createdAt: "2026-11-01",
                updatedAt: "2026-11-01",
                deletedAt: null,
              },
            ],
            placements: [{ folderId, threadIds: [threadId] }],
            tags: [],
          }),
        }),
      ),
    ),
  );

it.effect("lists a workspace by name with its secret names and nothing else about them", () =>
  Effect.gen(function* () {
    const attached = yield* Ref.make<ReadonlyArray<WorkspaceAttachInput>>([]);
    yield* Effect.gen(function* () {
      expect(yield* call("t3_workspace_list")).toStrictEqual({
        workspaces: [
          {
            id: workspaceId,
            deletedAt: null,
            name: "staging",
            folders: ["/srv/staging"],
            workingRoot: "/srv/staging",
            secretNames: ["DATABASE_URL"],
            projectIds: [projectId],
            threadIds: [],
          },
        ],
      });
    }).pipe(Effect.provide(layerFor(attached)));
  }),
);

it.effect("resolves an attach by name and refuses a name that does not exist", () =>
  Effect.gen(function* () {
    const attached = yield* Ref.make<ReadonlyArray<WorkspaceAttachInput>>([]);
    yield* Effect.gen(function* () {
      const toolkit = yield* WorkspacesToolkit;
      const attach = (name: string | null) =>
        toolkit
          .handle("t3_workspace_attach", { name: name as never, threadId })
          .pipe(Stream.unwrap, Stream.runCollect);
      expect((yield* attach("staging")).at(-1)?.result).toStrictEqual({ attached: true });
      expect((yield* attach("nope")).at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect((yield* attach(null)).at(-1)?.result).toStrictEqual({ attached: false });
      expect(yield* Ref.get(attached)).toStrictEqual([
        { target: { kind: "thread", threadId }, workspaceId },
        { target: { kind: "thread", threadId }, workspaceId: null },
      ]);
    }).pipe(Effect.provide(layerFor(attached)));
  }),
);

it.effect("counts a folder's threads and lists them only when asked", () =>
  Effect.gen(function* () {
    const attached = yield* Ref.make<ReadonlyArray<WorkspaceAttachInput>>([]);
    yield* Effect.gen(function* () {
      expect(yield* call("t3_folder_list")).toStrictEqual({
        folders: [{ id: folderId, parentId: null, name: "Inbox", threadCount: 1 }],
      });
      expect(yield* call("t3_folder_list", { folderId })).toMatchObject({ threadIds: [threadId] });
    }).pipe(Effect.provide(layerFor(attached)));
  }),
);
