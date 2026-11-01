import {
  ConversationFolderId,
  ConversationFolderMutation,
  ConversationFolderName,
  ConversationSmartFilter,
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  WorkspaceName,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ConversationFolderService from "../../../conversationFolders/ConversationFolderService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceService from "../../../workspace/WorkspaceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    WorkspaceService.WorkspaceService,
    ConversationFolderService.ConversationFolderService,
  ],
};

const WorkspaceListTool = Tool.make("t3_workspace_list", {
  ...shared,
  description:
    "List workspaces: folders, working root, secret names, and what each is attached to. Secret values are never available here or anywhere else; programs read them from their environment.",
  parameters: Schema.Struct({ environmentId: OrchestratorMcpEnvironmentTarget }),
  success: Schema.Struct({
    workspaces: Schema.Array(
      Schema.Struct({
        name: WorkspaceName,
        folders: Schema.Array(Schema.String),
        workingRoot: Schema.String,
        secretNames: Schema.Array(Schema.String),
        projectIds: Schema.Array(ProjectId),
        threadIds: Schema.Array(ThreadId),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkspaceAttachTool = Tool.make("t3_workspace_attach", {
  ...shared,
  description:
    "Attach a workspace by name to a thread or project, or detach with `name: null`. It decides where the target's processes run and which secrets they receive from their next launch.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    name: Schema.NullOr(WorkspaceName),
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({ attached: Schema.Boolean }),
}).annotate(Tool.Destructive, false);

const FolderListTool = Tool.make("t3_folder_list", {
  ...shared,
  description:
    "List conversation folders with their thread counts. Pass `folderId` for the threads in one folder.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    folderId: Schema.optional(ConversationFolderId),
  }),
  success: Schema.Struct({
    folders: Schema.Array(
      Schema.Struct({
        id: ConversationFolderId,
        parentId: Schema.NullOr(ConversationFolderId),
        name: ConversationFolderName,
        smartFilter: Schema.optional(ConversationSmartFilter),
        threadCount: NonNegativeInt,
      }),
    ),
    threadIds: Schema.optional(Schema.Array(ThreadId)),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const FolderUpdateTool = Tool.make("t3_folder_update", {
  ...shared,
  description:
    "Reorganize conversation folders: create, rename, move, delete, restore, move-threads (bulk filing; `folderId: null` unfiles), or set-thread-tags. Deleting a folder never deletes conversations and can be restored.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    mutation: ConversationFolderMutation,
  }),
  success: Schema.Struct({ folderId: Schema.optional(ConversationFolderId) }),
}).annotate(Tool.Destructive, false);

export const WorkspacesToolkit = Toolkit.make(
  WorkspaceListTool,
  WorkspaceAttachTool,
  FolderListTool,
  FolderUpdateTool,
);
