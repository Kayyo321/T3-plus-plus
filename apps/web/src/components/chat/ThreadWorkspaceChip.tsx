import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadWorkspace } from "@t3tools/client-runtime/state/workspaces";
import {
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type WorkspaceCatalog,
  type WorkspaceId,
  workspaceSecretsReachDriver,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { BoxesIcon, TriangleAlertIcon } from "lucide-react";
import { create } from "zustand";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { readThreadShell, useThreadShell } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Lets the keybinding open the header's picker from anywhere in the chat route. */
const useWorkspaceChipMenu = create<{ readonly open: boolean }>(() => ({ open: false }));

const setChipMenuOpen = (open: boolean) => useWorkspaceChipMenu.setState({ open });

export function requestWorkspaceChipMenu() {
  setChipMenuOpen(true);
}

const attachedLabel = {
  thread: "this conversation",
  parent: "its parent conversation",
  project: "this project",
} as const;

const threadWorkspaceSource = (input: {
  readonly catalog: WorkspaceCatalog | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) =>
  input.catalog === null
    ? null
    : resolveThreadWorkspace({
        catalog: input.catalog,
        threadId: input.threadId,
        projectId: input.projectId,
        parentOf: (id) =>
          readThreadShell(scopeThreadRef(input.environmentId, id))?.lineage.parentThreadId ?? null,
      });

/** Says which credentials are live for this conversation, and switches them. */
export function ThreadWorkspaceChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props;
  const navigate = useNavigate();
  const instanceId = useThreadShell(scopeThreadRef(environmentId, threadId))?.modelSelection
    .instanceId;
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const driver = providers?.find((provider) => provider.instanceId === instanceId)?.driver;
  const catalog = useEnvironmentQuery(
    serverEnvironment.workspacesLive({ environmentId, input: {} }),
  ).data;
  const open = useWorkspaceChipMenu((state) => state.open);
  const canAttach = useAtomValue(serverEnvironment.attachWorkspace.permissionAtom(environmentId));
  const attach = useAtomCommand(serverEnvironment.attachWorkspace, {
    label: "conversation workspace",
  });
  const source = threadWorkspaceSource({
    catalog,
    environmentId,
    threadId,
    projectId: props.projectId,
  });
  const live = catalog?.workspaces.filter((workspace) => workspace.deletedAt === null) ?? [];
  if (live.length === 0 && source === null) return null;

  const workspace = source?.workspace ?? null;
  const blocked =
    workspace !== null &&
    workspace.secrets.length > 0 &&
    driver !== undefined &&
    !workspaceSecretsReachDriver(driver);
  const select = (workspaceId: WorkspaceId | null) =>
    void attach({
      environmentId,
      input: { target: { kind: "thread", threadId }, workspaceId },
    });

  return (
    <Menu open={open} onOpenChange={setChipMenuOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant={blocked ? "destructive-outline" : "ghost"}
                  aria-label={
                    workspace === null
                      ? "No workspace. Change workspace"
                      : `Workspace ${workspace.name}. Change workspace`
                  }
                />
              }
            />
          }
        >
          {blocked ? (
            <TriangleAlertIcon aria-hidden className="size-3" />
          ) : (
            <BoxesIcon aria-hidden className="size-3" />
          )}
          <span className="max-w-32 truncate">{workspace?.name ?? "No workspace"}</span>
          {workspace !== null && workspace.secrets.length > 0 ? (
            <span className="text-muted-foreground tabular-nums">{workspace.secrets.length}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {workspace === null
            ? "No workspace is attached, so no workspace secrets are live."
            : blocked
              ? `${workspace.name} holds secrets this provider cannot receive without sharing them with other conversations. Turns will refuse to start.`
              : `${workspace.name}, from ${attachedLabel[source?.attachedTo ?? "project"]}. Runs in ${workspace.workingRoot} with ${workspace.secrets.length} secret${workspace.secrets.length === 1 ? "" : "s"}.`}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>Workspace for this conversation</MenuGroupLabel>
          {live.map((candidate) => (
            <MenuCheckboxItem
              key={candidate.id}
              checked={candidate.id === workspace?.id}
              disabled={!canAttach}
              onClick={() => select(candidate.id)}
            >
              {candidate.name}
            </MenuCheckboxItem>
          ))}
          <MenuItem disabled={!canAttach} onClick={() => select(null)}>
            Use the project's workspace
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/workspaces" })}>
          Manage workspaces
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
