import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type SecretProviderId,
  type Workspace,
  type WorkspaceMcpServer,
  type WorkspaceSecretSummary,
  type RuntimeMode,
  WORKSPACE_SECRET_MIN_MASKED_LENGTH,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { KeyRoundIcon, PlusIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** One server per line: a name, then its command and arguments. */
const parseMcpServerLines = (text: string): ReadonlyArray<WorkspaceMcpServer> =>
  lines(text).flatMap((line) => {
    const [name, command, ...args] = line.split(/\s+/u);
    return name === undefined || command === undefined
      ? []
      : [{ name, command, ...(args.length === 0 ? {} : { args }) } as WorkspaceMcpServer];
  });

const formatMcpServers = (servers: ReadonlyArray<WorkspaceMcpServer> | undefined) =>
  (servers ?? [])
    .map((server) => [server.name, server.command, ...(server.args ?? [])].join(" "))
    .join("\n");

const NO_CEILING = "none";

const reportFailure = (title: string, result: AtomCommandResult<unknown, unknown>) => {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: failure instanceof Error ? failure.message : "Try again.",
  });
};

function WorkspaceDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: Workspace | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { workspace } = props;
  const upsert = useAtomCommand(serverEnvironment.upsertWorkspace, { label: "workspace save" });
  const [name, setName] = useState(workspace?.name ?? "");
  const [folders, setFolders] = useState((workspace?.folders ?? []).join("\n"));
  const [workingRoot, setWorkingRoot] = useState(workspace?.workingRoot ?? "");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode | typeof NO_CEILING>(
    workspace?.settings.runtimeMode ?? NO_CEILING,
  );
  const [allowedCommands, setAllowedCommands] = useState(
    (workspace?.settings.allowedCommands ?? []).join("\n"),
  );
  const [mcpServers, setMcpServers] = useState(formatMcpServers(workspace?.settings.mcpServers));
  const [saving, setSaving] = useState(false);
  const folderList = lines(folders);
  const root = workingRoot.trim() || folderList[0] || "";

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const allowed = lines(allowedCommands);
    const servers = parseMcpServerLines(mcpServers);
    const result = await upsert({
      environmentId: props.environmentId,
      input: {
        ...(workspace === null ? {} : { id: workspace.id }),
        name: name.trim() as Workspace["name"],
        folders: folderList,
        workingRoot: root,
        settings: {
          ...workspace?.settings,
          ...(runtimeMode === NO_CEILING ? { runtimeMode: undefined } : { runtimeMode }),
          allowedCommands: allowed,
          mcpServers: servers,
        },
      },
    });
    setSaving(false);
    if (result._tag === "Success") props.onClose();
    else reportFailure("Could not save the workspace", result);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <form onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>{workspace === null ? "New workspace" : "Edit workspace"}</DialogTitle>
            <DialogDescription>
              Where work happens and with what. Secrets are added after you save.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Name
                <Input value={name} onChange={(event) => setName(event.target.value)} required />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Folders, one absolute path per line
                <Textarea
                  value={folders}
                  onChange={(event) => setFolders(event.target.value)}
                  rows={3}
                  required
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Working root, where processes start
                <Input
                  value={root}
                  onChange={(event) => setWorkingRoot(event.target.value)}
                  placeholder="The first folder"
                />
              </label>
              <div className="flex flex-col gap-1 text-sm">
                Most a conversation here may do
                <Select
                  value={runtimeMode}
                  onValueChange={(value) =>
                    setRuntimeMode((value ?? NO_CEILING) as RuntimeMode | typeof NO_CEILING)
                  }
                >
                  <SelectTrigger aria-label="Permission ceiling">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_CEILING}>No limit</SelectItem>
                    {runtimeModeOptions.map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {runtimeModeConfig[mode].label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                Allowed commands, one prefix per line
                <Textarea
                  value={allowedCommands}
                  onChange={(event) => setAllowedCommands(event.target.value)}
                  rows={2}
                  placeholder="npm test"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                MCP servers, one per line: name, command, arguments
                <Textarea
                  value={mcpServers}
                  onChange={(event) => setMcpServers(event.target.value)}
                  rows={2}
                  placeholder="linear npx -y linear-mcp"
                />
              </label>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || name.trim() === "" || root === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Takes a value in and never shows it again: the field empties as soon as it is saved. */
function SecretDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: Workspace;
  readonly existing: WorkspaceSecretSummary | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const setSecret = useAtomCommand(serverEnvironment.setWorkspaceSecret, {
    label: "workspace secret save",
  });
  const providers = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.secretProviders,
  );
  const providerIds = Object.keys(providers) as Array<SecretProviderId>;
  const [name, setName] = useState(props.existing?.name ?? "");
  const [source, setSource] = useState<"stored" | SecretProviderId>("stored");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    const result = await setSecret({
      environmentId: props.environmentId,
      input: {
        workspaceId: props.workspace.id,
        name: name.trim() as WorkspaceSecretSummary["name"],
        secret:
          source === "stored"
            ? { type: "stored", value: Redacted.make(value) }
            : {
                type: "provider",
                reference: { provider: source, reference: value.trim() as never },
              },
      },
    });
    setSaving(false);
    setValue("");
    if (result._tag === "Success") props.onClose();
    else reportFailure("Could not save the secret", result);
  };

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <form onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle>{props.existing === null ? "Add secret" : `Replace ${name}`}</DialogTitle>
            <DialogDescription>
              Reaches this workspace's processes as an environment variable. T3++ never shows the
              value again, to you or to an agent.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Variable name
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={props.existing !== null}
                  placeholder="DATABASE_URL"
                  autoComplete="off"
                  required
                />
              </label>
              {providerIds.length > 0 ? (
                <div className="flex flex-col gap-1 text-sm">
                  Source
                  <Select<string>
                    value={source}
                    onValueChange={(next) => setSource((next ?? "stored") as typeof source)}
                  >
                    <SelectTrigger aria-label="Secret source">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="stored">Stored encrypted here</SelectItem>
                      {providerIds.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <label className="flex flex-col gap-1 text-sm">
                {source === "stored" ? "Value" : "Secret reference"}
                <Input
                  type={source === "stored" ? "password" : "text"}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  autoComplete="off"
                  placeholder={source === "stored" ? undefined : "op://vault/item/field"}
                  required
                />
              </label>
              {source === "stored" &&
              value.length > 0 &&
              value.length < WORKSPACE_SECRET_MIN_MASKED_LENGTH ? (
                <p className="text-xs text-warning-foreground">
                  Values under {WORKSPACE_SECRET_MIN_MASKED_LENGTH} characters cannot be masked in
                  output.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || name.trim() === "" || value === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function WorkspaceRow(props: {
  readonly environmentId: EnvironmentId;
  readonly workspace: Workspace;
  readonly attachedProjects: ReadonlyArray<string>;
  readonly canEdit: boolean;
  readonly onEdit: () => void;
}) {
  const { environmentId, workspace } = props;
  const remove = useAtomCommand(serverEnvironment.deleteWorkspace, { label: "workspace delete" });
  const restore = useAtomCommand(serverEnvironment.restoreWorkspace, {
    label: "workspace restore",
  });
  const removeSecret = useAtomCommand(serverEnvironment.removeWorkspaceSecret, {
    label: "workspace secret remove",
  });
  const [secretDialog, setSecretDialog] = useState<null | {
    readonly existing: WorkspaceSecretSummary | null;
  }>(null);
  const [removing, setRemoving] = useState<WorkspaceSecretSummary | null>(null);

  const deleteWorkspace = async () => {
    const result = await remove({ environmentId, input: { id: workspace.id } });
    if (result._tag !== "Success") return;
    const id = toastManager.add({
      title: `Deleted ${workspace.name}`,
      description: "Its secrets are no longer injected.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void restore({ environmentId, input: { id: workspace.id } });
        },
      },
    });
  };

  return (
    <>
      <SettingsRow
        title={workspace.name}
        description={
          props.attachedProjects.length === 0
            ? workspace.workingRoot
            : `${workspace.workingRoot} · ${props.attachedProjects.join(", ")}`
        }
        control={
          props.canEdit ? (
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => setSecretDialog({ existing: null })}>
                <KeyRoundIcon aria-hidden className="size-3" />
                Add secret
              </Button>
              <Button size="xs" variant="outline" onClick={props.onEdit}>
                Edit
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Delete ${workspace.name}`}
                onClick={() => void deleteWorkspace()}
              >
                <Trash2Icon aria-hidden className="size-3" />
              </Button>
            </div>
          ) : null
        }
      />
      {workspace.secrets.map((secret) => (
        <SettingsRow
          key={secret.name}
          title={<code className="text-xs">{secret.name}</code>}
          description={
            secret.source === "provider"
              ? `From ${secret.provider ?? "a secret provider"}`
              : secret.unmasked
                ? "Stored encrypted. Too short to mask in output."
                : "Stored encrypted"
          }
          control={
            props.canEdit ? (
              <div className="flex items-center gap-1">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setSecretDialog({ existing: secret })}
                >
                  Replace
                </Button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${secret.name}`}
                  onClick={() => setRemoving(secret)}
                >
                  <Trash2Icon aria-hidden className="size-3" />
                </Button>
              </div>
            ) : null
          }
        />
      ))}
      {secretDialog === null ? null : (
        <SecretDialog
          environmentId={environmentId}
          workspace={workspace}
          existing={secretDialog.existing}
          open
          onClose={() => setSecretDialog(null)}
        />
      )}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The value is gone for good. Add it again to bring the variable back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
            <AlertDialogClose
              render={
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (removing !== null) {
                      void removeSecret({
                        environmentId,
                        input: { workspaceId: workspace.id, name: removing.name },
                      });
                    }
                  }}
                />
              }
            >
              Remove
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function EnvironmentWorkspaces(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const catalog = useEnvironmentQuery(
    serverEnvironment.workspacesLive({ environmentId, input: {} }),
  ).data;
  const canEdit = useAtomValue(serverEnvironment.upsertWorkspace.permissionAtom(environmentId));
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const attach = useAtomCommand(serverEnvironment.attachWorkspace, {
    label: "project workspace",
  });
  const restore = useAtomCommand(serverEnvironment.restoreWorkspace, {
    label: "workspace restore",
  });
  const purge = useAtomCommand(serverEnvironment.purgeWorkspace, { label: "workspace purge" });
  const [editing, setEditing] = useState<null | { readonly workspace: Workspace | null }>(null);
  const live = catalog?.workspaces.filter((workspace) => workspace.deletedAt === null) ?? [];
  const deleted = catalog?.workspaces.filter((workspace) => workspace.deletedAt !== null) ?? [];
  const attachedWorkspaceFor = (projectId: string) =>
    catalog?.attachments.find(
      ({ target }) => target.kind === "project" && target.projectId === projectId,
    )?.workspaceId;

  return (
    <>
      <SettingsSection
        {...searchableSetting("workspaces")}
        headerAction={
          canEdit ? (
            <Button size="xs" variant="outline" onClick={() => setEditing({ workspace: null })}>
              <PlusIcon className="size-3" aria-hidden />
              New workspace
            </Button>
          ) : null
        }
      >
        {live.length === 0 ? (
          <SettingsRow
            title="No workspaces yet."
            description="A workspace names where work happens and which secrets its processes receive."
          />
        ) : (
          live.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              environmentId={environmentId}
              workspace={workspace}
              canEdit={canEdit}
              onEdit={() => setEditing({ workspace })}
              attachedProjects={projects
                .filter((project) => attachedWorkspaceFor(project.id) === workspace.id)
                .map((project) => project.title)}
            />
          ))
        )}
      </SettingsSection>
      {live.length > 0 && projects.length > 0 ? (
        <SettingsSection {...searchableSetting("workspace-projects")}>
          {projects.map((project) => (
            <SettingsRow
              key={project.id}
              title={project.title}
              description="Conversations here use this unless they pick their own."
              control={
                <Select
                  value={attachedWorkspaceFor(project.id) ?? NO_CEILING}
                  disabled={!canEdit}
                  onValueChange={(value) =>
                    void attach({
                      environmentId,
                      input: {
                        target: { kind: "project", projectId: project.id },
                        workspaceId:
                          value === null || value === NO_CEILING
                            ? null
                            : (value as Workspace["id"]),
                      },
                    })
                  }
                >
                  <SelectTrigger aria-label={`Workspace for ${project.title}`}>
                    <SelectValue>
                      {(value: string) =>
                        live.find((workspace) => workspace.id === value)?.name ?? "None"
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_CEILING}>None</SelectItem>
                    {live.map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {deleted.length > 0 ? (
        <SettingsSection {...searchableSetting("workspaces-deleted")}>
          {deleted.map((workspace) => (
            <SettingsRow
              key={workspace.id}
              title={
                <span className="flex items-center gap-2">
                  {workspace.name}
                  <Badge size="sm" variant="outline">
                    Deleted
                  </Badge>
                </span>
              }
              description="Nothing is injected until you restore it."
              control={
                canEdit ? (
                  <div className="flex items-center gap-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void restore({ environmentId, input: { id: workspace.id } })}
                    >
                      <Undo2Icon aria-hidden className="size-3" />
                      Restore
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => void purge({ environmentId, input: { id: workspace.id } })}
                    >
                      Delete forever
                    </Button>
                  </div>
                ) : null
              }
            />
          ))}
        </SettingsSection>
      ) : null}
      {editing === null ? null : (
        <WorkspaceDialog
          key={editing.workspace?.id ?? "new"}
          environmentId={environmentId}
          workspace={editing.workspace}
          open
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

export function WorkspacesSettingsPanel() {
  const { environment } = useSettingsScope();
  const connected = environment?.connection.phase === "connected";
  return (
    <SettingsPageContainer>
      {connected ? (
        <EnvironmentWorkspaces
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <SettingsSection {...searchableSetting("workspaces")}>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Connect an environment to manage its workspaces.
          </p>
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}
