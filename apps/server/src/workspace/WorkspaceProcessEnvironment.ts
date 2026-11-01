import type { ThreadId, WorkspaceId, WorkspaceSettings } from "@t3tools/contracts";
import type { SecretMask } from "@t3tools/shared/secretRedaction";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; launches compare this synchronously.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

/** What one process launch for a thread needs. Never crosses a transport. */
export interface WorkspaceLaunch {
  readonly workspaceId: WorkspaceId;
  readonly workspaceName: string;
  /** Null when the thread keeps its own worktree. */
  readonly workingRoot: string | null;
  readonly environment: Redacted.Redacted<Readonly<Record<string, string>>>;
  readonly secretNames: ReadonlyArray<string>;
  readonly mask: SecretMask;
  readonly settings: WorkspaceSettings;
  /** Changes when a running process would need a restart to match. Held in memory only. */
  readonly fingerprint: string;
}

export type WorkspaceLaunchForThread = (
  threadId: ThreadId,
) => Effect.Effect<Option.Option<WorkspaceLaunch>>;

export const fingerprintLaunch = (
  values: ReadonlyArray<{ readonly name: string; readonly value: string }>,
  settings: WorkspaceSettings,
) => {
  const { mcpServers = [], allowedCommands = [] } = settings;
  if (values.length === 0 && mcpServers.length === 0 && allowedCommands.length === 0) return "";
  const hash = NodeCrypto.createHash("sha256");
  for (const { name, value } of values.toSorted((a, b) => a.name.localeCompare(b.name))) {
    hash.update(`${name}\u0000${value}\u0000`);
  }
  hash.update(JSON.stringify(mcpServers));
  hash.update(JSON.stringify(allowedCommands));
  return hash.digest("hex");
};

/**
 * A thread's launch environment, for the code that spawns processes. It defaults to "no workspace"
 * so a harness without workspaces runs as before; `WorkspaceService.layerProcessEnvironment` is the
 * real thing.
 */
export class WorkspaceProcessEnvironment extends Context.Reference<{
  readonly forThread: WorkspaceLaunchForThread;
}>("t3pp/workspace/WorkspaceProcessEnvironment", {
  defaultValue: () => ({ forThread: () => Effect.succeedNone }),
}) {}
