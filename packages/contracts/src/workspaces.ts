import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { SecretProviderId, SecretReference } from "./secretReference.ts";

const WORKSPACE_MAX_FOLDERS = 32;
export const WORKSPACE_MAX_SECRETS = 200;
const WORKSPACE_MAX_ALLOWED_COMMANDS = 100;
const WORKSPACE_MAX_MCP_SERVERS = 32;
const WORKSPACE_SECRET_VALUE_MAX_LENGTH = 65_536;
/**
 * Shorter values are injected but never masked in output: masking "true" or "3000" would rewrite
 * ordinary text and tell a reader which text was the secret.
 */
export const WORKSPACE_SECRET_MIN_MASKED_LENGTH = 8;

export const WorkspaceId = TrimmedNonEmptyString.pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const WorkspaceName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type WorkspaceName = typeof WorkspaceName.Type;

const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "PWD",
]);

const isReservedWorkspaceSecretName = (name: string) =>
  RESERVED_SECRET_NAMES.has(name) || name.startsWith("T3PP_") || name.startsWith("T3_");

/** An environment variable name. T3++ owns its prefixes and the shell owns its essentials. */
export const WorkspaceSecretName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/),
  Schema.makeFilter((name: string) => !isReservedWorkspaceSecretName(name), {
    expected: "a variable name T3++ and the shell do not reserve",
  }),
);
export type WorkspaceSecretName = typeof WorkspaceSecretName.Type;

/** Everything a client may ever learn about a secret. No value, no reference path. */
export const WorkspaceSecretSummary = Schema.Struct({
  name: WorkspaceSecretName,
  source: Schema.Literals(["stored", "provider"]),
  provider: Schema.optional(SecretProviderId),
  /** The saved value is too short to mask in output. Unknown for a provider-held secret. */
  unmasked: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type WorkspaceSecretSummary = typeof WorkspaceSecretSummary.Type;

/** Launched by the provider beside its session, so it sees the session's environment. */
export const WorkspaceMcpServer = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64), Schema.isPattern(/^[A-Za-z0-9_-]+$/)),
  command: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(Schema.String)),
});
export type WorkspaceMcpServer = typeof WorkspaceMcpServer.Type;

export const WorkspaceSettings = Schema.Struct({
  defaultModelSelection: Schema.optional(ModelSelection),
  runtimeMode: Schema.optional(RuntimeMode),
  /** Command prefixes approved without asking. A compound shell command always asks. */
  allowedCommands: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(WORKSPACE_MAX_ALLOWED_COMMANDS)),
  ),
  mcpServers: Schema.optional(
    Schema.Array(WorkspaceMcpServer).check(Schema.isMaxLength(WORKSPACE_MAX_MCP_SERVERS)),
  ),
});
export type WorkspaceSettings = typeof WorkspaceSettings.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  name: WorkspaceName,
  folders: Schema.Array(TrimmedNonEmptyString),
  /** One of `folders`: where processes start. */
  workingRoot: TrimmedNonEmptyString,
  secrets: Schema.Array(WorkspaceSecretSummary),
  settings: WorkspaceSettings,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set while it can still be restored. A deleted workspace injects nothing. */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceAttachmentTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type WorkspaceAttachmentTarget = typeof WorkspaceAttachmentTarget.Type;

export const WorkspaceAttachment = Schema.Struct({
  target: WorkspaceAttachmentTarget,
  workspaceId: WorkspaceId,
});
export type WorkspaceAttachment = typeof WorkspaceAttachment.Type;

export const WorkspaceCatalog = Schema.Struct({
  workspaces: Schema.Array(Workspace),
  attachments: Schema.Array(WorkspaceAttachment),
});
export type WorkspaceCatalog = typeof WorkspaceCatalog.Type;

export const WorkspaceUpsertInput = Schema.Struct({
  /** Absent creates a workspace. */
  id: Schema.optional(WorkspaceId),
  name: WorkspaceName,
  folders: Schema.Array(TrimmedNonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(WORKSPACE_MAX_FOLDERS),
  ),
  workingRoot: TrimmedNonEmptyString,
  settings: WorkspaceSettings,
});
export type WorkspaceUpsertInput = typeof WorkspaceUpsertInput.Type;

export const WorkspaceTargetInput = Schema.Struct({ id: WorkspaceId });
export type WorkspaceTargetInput = typeof WorkspaceTargetInput.Type;

export const WorkspaceAttachInput = Schema.Struct({
  target: WorkspaceAttachmentTarget,
  /** Null detaches. */
  workspaceId: Schema.NullOr(WorkspaceId),
});
export type WorkspaceAttachInput = typeof WorkspaceAttachInput.Type;

export const WorkspaceSecretValueInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stored"),
    value: Schema.RedactedFromValue(
      Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(WORKSPACE_SECRET_VALUE_MAX_LENGTH),
      ),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("provider"), reference: SecretReference }),
]);
export type WorkspaceSecretValueInput = typeof WorkspaceSecretValueInput.Type;

export const WorkspaceSetSecretInput = Schema.Struct({
  workspaceId: WorkspaceId,
  name: WorkspaceSecretName,
  secret: WorkspaceSecretValueInput,
});
export type WorkspaceSetSecretInput = typeof WorkspaceSetSecretInput.Type;

export const WorkspaceRemoveSecretInput = Schema.Struct({
  workspaceId: WorkspaceId,
  name: WorkspaceSecretName,
});
export type WorkspaceRemoveSecretInput = typeof WorkspaceRemoveSecretInput.Type;

export const WorkspaceErrorReason = Schema.Literals([
  "not_found",
  "name_taken",
  "invalid_folders",
  "too_many_secrets",
  "thread_running",
  "storage_failed",
]);
export type WorkspaceErrorReason = typeof WorkspaceErrorReason.Type;

const WORKSPACE_ERROR_MESSAGES: Record<WorkspaceErrorReason, string> = {
  not_found: "That workspace no longer exists.",
  name_taken: "Another workspace already has that name.",
  invalid_folders: "The working root must be one of the workspace's absolute folders.",
  too_many_secrets: `A workspace holds at most ${WORKSPACE_MAX_SECRETS} secrets.`,
  thread_running: "Stop the running turn before changing this conversation's workspace.",
  storage_failed: "The workspace could not be saved.",
};

export class WorkspaceError extends Schema.TaggedError<WorkspaceError>()("WorkspaceError", {
  reason: WorkspaceErrorReason,
}) {
  override get message(): string {
    return WORKSPACE_ERROR_MESSAGES[this.reason];
  }
}

/**
 * How a driver gets workspace secrets. `session-process` spawns one process per thread, so the
 * environment reaches that thread alone. Absent drivers share a process (Codex, OpenCode) or run
 * inside the server (Cursor), so a variable would reach other threads: those threads refuse to run.
 */
const WORKSPACE_SECRET_SESSION_PROCESS_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "grok",
  "acpRegistry",
  "antigravity",
  "pi",
  "muse",
  "fx",
]);

export const workspaceSecretsReachDriver = (driver: string) =>
  WORKSPACE_SECRET_SESSION_PROCESS_DRIVERS.has(driver);

const RUNTIME_MODES_BY_TRUST: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

/** A workspace's permission mode is a ceiling: it can hold a conversation back, never loosen it. */
export const runtimeModeWithinWorkspace = (
  mode: RuntimeMode,
  ceiling: RuntimeMode | undefined,
): RuntimeMode =>
  ceiling !== undefined &&
  RUNTIME_MODES_BY_TRUST.indexOf(ceiling) < RUNTIME_MODES_BY_TRUST.indexOf(mode)
    ? ceiling
    : mode;

const SHELL_COMPOSITION = /[;&|`$<>(){}\r\n]/u;

/** Prefix match on whole words. Anything that could chain a second command is not a match. */
export const workspaceAllowsCommand = (
  allowedCommands: ReadonlyArray<string>,
  command: string,
): boolean => {
  const trimmed = command.trim();
  return (
    !SHELL_COMPOSITION.test(trimmed) &&
    allowedCommands.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))
  );
};
