import {
  type ConversationFolderError,
  OrchestratorMcpFailure,
  type WorkspaceAttachmentTarget,
  type WorkspaceError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ConversationFolders from "../../../conversationFolders/ConversationFolderService.ts";
import * as Workspaces from "../../../workspace/WorkspaceService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkspacesToolkit } from "./tools.ts";

const AGENT_ACTOR = { actor: "agent" } as const;
const workspacesRefused = "change this environment's workspaces";

const invalidRequest = (error: WorkspaceError | ConversationFolderError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const notAttachable = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "Name exactly one of threadId or projectId.",
  });

export const layer = McpToolAccess.toLayer(WorkspacesToolkit, {
  t3_workspace_upsert: McpToolAccess.writesEnvironment(
    (params, check) =>
      Effect.gen(function* () {
        yield* check;
        const workspaces = yield* Workspaces.WorkspaceService;
        const workspace = yield* workspaces
          .upsert({ ...params, settings: {} }, AGENT_ACTOR)
          .pipe(Effect.mapError(invalidRequest));
        return { id: workspace.id };
      }),
    { refused: workspacesRefused },
  ),
  t3_workspace_delete: McpToolAccess.writesEnvironment(
    (params, check) =>
      Effect.gen(function* () {
        yield* check;
        yield* (yield* Workspaces.WorkspaceService)
          .remove(params, AGENT_ACTOR)
          .pipe(Effect.mapError(invalidRequest));
        return {};
      }),
    { refused: workspacesRefused },
  ),
  t3_workspace_restore: McpToolAccess.writesEnvironment(
    (params, check) =>
      Effect.gen(function* () {
        yield* check;
        const workspace = yield* (yield* Workspaces.WorkspaceService)
          .restore(params, AGENT_ACTOR)
          .pipe(Effect.mapError(invalidRequest));
        return { id: workspace.id };
      }),
    { refused: workspacesRefused },
  ),
  t3_workspace_list: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const workspaces = yield* Workspaces.WorkspaceService;
      const catalog = yield* workspaces.catalog.pipe(Effect.mapError(invalidRequest));
      return {
        workspaces: catalog.workspaces
          .filter((workspace) => params.includeDeleted || workspace.deletedAt === null)
          .map((workspace) => {
            const attached = catalog.attachments.filter(
              (attachment) => attachment.workspaceId === workspace.id,
            );
            return {
              id: workspace.id,
              deletedAt: workspace.deletedAt,
              name: workspace.name,
              folders: workspace.folders,
              workingRoot: workspace.workingRoot,
              secretNames: workspace.secrets.map((secret) => secret.name),
              projectIds: attached.flatMap(({ target }) =>
                target.kind === "project" ? [target.projectId] : [],
              ),
              threadIds: attached.flatMap(({ target }) =>
                target.kind === "thread" ? [target.threadId] : [],
              ),
            };
          }),
      };
    }),
  ),
  // Which credentials a process receives is an environment setting, not thread metadata.
  t3_workspace_attach: McpToolAccess.writesEnvironment(
    (params, check) =>
      Effect.gen(function* () {
        yield* check;
        const workspaces = yield* Workspaces.WorkspaceService;
        const target: WorkspaceAttachmentTarget | undefined =
          params.threadId !== undefined && params.projectId === undefined
            ? { kind: "thread", threadId: params.threadId }
            : params.projectId !== undefined && params.threadId === undefined
              ? { kind: "project", projectId: params.projectId }
              : undefined;
        if (target === undefined) return yield* notAttachable();
        if (params.name === null) {
          yield* workspaces
            .attach({ target, workspaceId: null }, AGENT_ACTOR)
            .pipe(Effect.mapError(invalidRequest));
          return { attached: false };
        }
        const catalog = yield* workspaces.catalog.pipe(Effect.mapError(invalidRequest));
        const workspace = catalog.workspaces.find(
          (candidate) => candidate.deletedAt === null && candidate.name === params.name,
        );
        if (workspace === undefined) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "No workspace has that name. t3_workspace_list shows them.",
          });
        }
        yield* workspaces
          .attach({ target, workspaceId: workspace.id }, AGENT_ACTOR)
          .pipe(Effect.mapError(invalidRequest));
        return { attached: true };
      }),
    { refused: workspacesRefused },
  ),
  t3_folder_list: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const folders = yield* ConversationFolders.ConversationFolderService;
      const snapshot = yield* folders.snapshot.pipe(Effect.mapError(invalidRequest));
      const counts = new Map(
        snapshot.placements.map(({ folderId, threadIds }) => [folderId, threadIds] as const),
      );
      return {
        folders: snapshot.folders
          .filter((folder) => folder.deletedAt === null)
          .map((folder) => ({
            id: folder.id,
            parentId: folder.parentId,
            name: folder.name,
            ...(folder.smartFilter === undefined ? {} : { smartFilter: folder.smartFilter }),
            capabilityMode: folder.capabilityMode ?? "code",
            threadCount: counts.get(folder.id)?.length ?? 0,
          })),
        ...(params.folderId === undefined ? {} : { threadIds: counts.get(params.folderId) ?? [] }),
      };
    }),
  ),
  t3_folder_update: McpToolAccess.writes(
    (params) =>
      Effect.gen(function* () {
        const folders = yield* ConversationFolders.ConversationFolderService;
        const result = yield* folders
          .mutate(params.mutation, AGENT_ACTOR)
          .pipe(Effect.mapError(invalidRequest));
        return result.folder === undefined ? {} : { folderId: result.folder.id };
      }),
    { refused: "change this environment's conversation folders" },
  ),
});
