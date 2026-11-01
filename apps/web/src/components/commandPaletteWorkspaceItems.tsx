import { conversationFolderChoices } from "@t3tools/client-runtime/state/conversationFolders";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { BoxesIcon, FolderInputIcon, FoldersIcon } from "lucide-react";

import { useConversationFolderViewStore } from "../conversationFolderViewStore";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";

const ICON_CLASS = "size-4 shrink-0 text-muted-foreground/80";
const ADDON_ICON_CLASS = "size-4 shrink-0";

/** Palette entries for workspaces and folders, for the conversation the palette opened over. */
export function useWorkspacePaletteItems(
  activeThread: EnvironmentThreadShell | undefined,
): ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const navigate = useNavigate();
  const environmentId = activeThread?.environmentId ?? null;
  const catalog = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workspacesLive({ environmentId, input: {} }),
  ).data;
  const folders = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.conversationFoldersLive({ environmentId, input: {} }),
  ).data;
  const foldersVisible = useConversationFolderViewStore((state) => state.foldersVisible);
  const toggleFoldersVisible = useConversationFolderViewStore(
    (state) => state.toggleFoldersVisible,
  );
  const attach = useAtomCommand(serverEnvironment.attachWorkspace, {
    label: "conversation workspace",
  });
  const mutateFolders = useAtomCommand(serverEnvironment.mutateConversationFolders, {
    label: "conversation folder change",
  });

  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:workspaces-manage",
      searchTerms: ["workspaces", "secrets", "credentials", "environment variables", "settings"],
      title: "Manage workspaces",
      icon: <BoxesIcon className={ICON_CLASS} />,
      run: async () => {
        await navigate({ to: "/settings/workspaces" });
      },
    },
    {
      kind: "action",
      value: "action:conversation-folders-toggle",
      searchTerms: ["folders", "sidebar", "organize", "projects", "tree"],
      title: foldersVisible ? "Show projects in the sidebar" : "Show folders in the sidebar",
      icon: <FoldersIcon className={ICON_CLASS} />,
      shortcutCommand: "conversationFolders.toggleView",
      run: async () => toggleFoldersVisible(),
    },
  ];

  if (activeThread === undefined || environmentId === null) return items;
  const threadId = activeThread.id;

  const liveWorkspaces =
    catalog?.workspaces.filter((workspace) => workspace.deletedAt === null) ?? [];
  if (liveWorkspaces.length > 0) {
    items.push({
      kind: "submenu",
      value: "action:workspace-switch",
      searchTerms: ["workspace", "switch", "secrets", "attach", "credentials"],
      title: "Change this conversation's workspace...",
      icon: <BoxesIcon className={ICON_CLASS} />,
      addonIcon: <BoxesIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "workspaces",
          label: "Workspaces",
          items: [
            ...liveWorkspaces.map((workspace): CommandPaletteActionItem => ({
              kind: "action",
              value: `workspace-switch:${workspace.id}`,
              searchTerms: [workspace.name, ...workspace.secrets.map((secret) => secret.name)],
              title: workspace.name,
              description: workspace.workingRoot,
              icon: <BoxesIcon className={ICON_CLASS} />,
              run: async () => {
                await attach({
                  environmentId,
                  input: { target: { kind: "thread", threadId }, workspaceId: workspace.id },
                });
              },
            })),
            {
              kind: "action",
              value: "workspace-switch:project",
              searchTerms: ["none", "detach", "project"],
              title: "Use the project's workspace",
              icon: <BoxesIcon className={ICON_CLASS} />,
              run: async () => {
                await attach({
                  environmentId,
                  input: { target: { kind: "thread", threadId }, workspaceId: null },
                });
              },
            },
          ],
        },
      ],
    });
  }

  if (folders !== null) {
    items.push({
      kind: "submenu",
      value: "action:conversation-folder-move",
      searchTerms: ["folder", "move", "file", "organize"],
      title: "Move this conversation to a folder...",
      icon: <FolderInputIcon className={ICON_CLASS} />,
      addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
      groups: [
        {
          value: "folders",
          label: "Folders",
          items: [
            ...conversationFolderChoices(folders).map((choice): CommandPaletteActionItem => ({
              kind: "action",
              value: `conversation-folder-move:${choice.id}`,
              searchTerms: [choice.path],
              title: choice.path,
              icon: <FolderInputIcon className={ICON_CLASS} />,
              run: async () => {
                await mutateFolders({
                  environmentId,
                  input: { type: "move-threads", threadIds: [threadId], folderId: choice.id },
                });
              },
            })),
            {
              kind: "action",
              value: "conversation-folder-move:unfiled",
              searchTerms: ["unfiled", "remove", "none"],
              title: "Unfiled",
              icon: <FolderInputIcon className={ICON_CLASS} />,
              run: async () => {
                await mutateFolders({
                  environmentId,
                  input: { type: "move-threads", threadIds: [threadId], folderId: null },
                });
              },
            },
          ],
        },
      ],
    });
  }
  return items;
}
