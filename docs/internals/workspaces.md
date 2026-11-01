# Workspaces and secrets

A workspace value has one way out of [`WorkspaceService`](../../apps/server/src/workspace/WorkspaceService.ts): `launchForThread`, read through `WorkspaceProcessEnvironment` by the code that spawns processes. It is not reachable from a transport. `WorkspaceService.test.ts` pins the list of `workspaces.*` RPCs and the fields a secret summary carries, so a new way out fails there.

Values are AES-256-GCM sealed in SQLite, bound to workspace and name, with the key in the secret store. `ServerSecretStore` itself writes plaintext owner-only files, so it holds the key, not the values: a database copy, including a dev seed, is useless alone. `migrate-dev-db` drops the tables anyway.

`environment` is a `Redacted` so an accidental log or `JSON.stringify` prints nothing.

## Why secrets depend on the driver

An environment variable belongs to a process. A driver that shares a process cannot scope one to a thread, and passing values through per-thread protocol config would put them in protocol logs. `workspaceSecretsReachDriver` lists the drivers that spawn one process per thread; a new driver stays refused until it opts in.

| Driver                                     | Process                     | Decision                                  |
| ------------------------------------------ | --------------------------- | ----------------------------------------- |
| `claudeAgent`                              | One SDK query per thread    | `env` on the query                        |
| `grok`, `acpRegistry`, `fx`, `antigravity` | One ACP child per session   | `processEnvironment` on the runtime input |
| `pi`, `muse`                               | One child per session       | Merged into the launch environment        |
| `codex`, `opencode`                        | One server for every thread | Refused by `RuntimePolicy`                |
| `cursor`                                   | SDK agent inside the server | Refused by `RuntimePolicy`                |

Refusal lives in `RuntimePolicy`, so it reaches every turn and the dispatch error the client shows. `ProviderSessionManager.open` is the second line: a session keeps the fingerprint of the workspace it launched with, a single-thread session restarts when that changes, and a shared session refuses. Scoping Codex by giving each workspace its own app-server would need the orchestrator to rebind native threads across sessions.

## Masking is a backstop

Masks sit where output crosses into T3++: the event pump in `ProviderSessionManager` (`ProviderEventRedaction.ts`), `TerminalManager`'s PTY listener, and the two process-wide sinks through `ActiveSecretMasks` (provider event logs, the server log). All sit upstream of persistence, so a masked value never reaches the event store or a projection.

Only two paths reach the model in time: Claude's `PostToolUse` hook, and ACP client terminals, which T3++ runs. Every other provider's shell runs inside its own process, and the model reads that output before T3++ does.

A stream holds back any tail that could begin a value. A terminal releases it after 40 ms so a prompt that ends like a secret still prints; a process that pauses mid-value for longer leaks that prefix. Streaming assistant text is cumulative, so `redactGrowing` trims the tail instead of holding it.

Provider-side transcripts, such as Claude's own session files, are out of reach.

## Working root

`RuntimePolicy` and `TerminalManager` move processes to the working root unless the thread has its own worktree. Git, pull requests, and the diff panel still follow the project's root.
