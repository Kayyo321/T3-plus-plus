# T3-plus-plus: Project Description

T3-plus-plus is a fork of T3 Code that grows it from "a minimal GUI for coding agents" into a **calm
command center for agent work**: one place where you chat with agents, run them in the background,
hand them teams, steer them from your phone, and watch your repository evolve, without the app ever
feeling heavier than a terminal.

The fork keeps what T3 Code users love (open, fast, remote ready, multi-surface; see
[AGENTS.md](../../AGENTS.md)) and adds the capabilities below. Every feature must still work across
web, desktop, and mobile where reasonable, and must stay cheap to render.

## How to read these documents

These are **direction documents**, not specifications. They say what a feature is for, what it should
feel like, and where the sharp edges are. Implementation details, schemas, and exact UI are left to
whoever builds the feature (human or agent). Where a document says "should", a better idea that
serves the same goal wins. Where it says "must", it is a constraint we would not trade away.

Vocabulary follows the [glossary](../internals/glossary.md). The one deliberate difference: this
set says **conversation** in places where the codebase says **thread**; they are the same thing.

## Documents

| Document                                                                  | Covers                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Orchestrator](./orchestrator.md)                                         | A concurrent side-conversation with an agent that operates the editor and supervises stuck work |
| [Remote control](./remote-control.md)                                     | A per-conversation switch that shares a live view through a link, with real auth                |
| [Sessions and agents](./sessions-and-agents.md)                           | Nested sessions vs sub-agents, background tasks, fork and rewind                                |
| [Teamwork](./teamwork.md)                                                 | A skill that runs work like a real team, with roles and review phases                           |
| [Layouts, workspaces, and folders](./layouts-workspaces-and-folders.md)   | Saved layouts, split view, IDE mode, secret-holding workspaces, folders                         |
| [Git and source control](./git-and-source-control.md)                     | A full, animated commit graph with commit, rollback, merge, and PR actions                      |
| [Chat mode, scheduling, computer use](./modes-scheduling-computer-use.md) | Chat-only conversations, scheduled and repeating tasks, desktop control                         |
| [UI direction](./ui-direction.md)                                         | Minimal, modern, ASCII-flavored redesign, in the spirit of Claude Code Desktop                  |

## Where things stand

Status below was re-checked on 2026-11-01 against the code. "Shipped" means reachable in the web
client; gaps are named in the row. Mobile and desktop were not run for this table.

| Feature                         | State   | What exists / what is missing                                                                                                                                                  |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Remote access to an environment | Exists  | Direct, Tailscale, SSH, T3 Connect ([remote](../internals/remote.md)). Missing: a per-conversation switch.                                                                     |
| Guest links                     | Partial | One-person, 24h, approve-each-message links ([guest links](../user/guest-links.md)). Beta, needs T3 Connect, read-mostly. Remote control builds on and generalizes it.         |
| MCP orchestration               | Partial | Server MCP can create and steer threads and sub-agents ([orchestrator MCP](../orchestration-v2/orchestrator-mcp-server.md)). Missing: editor-wide reach, and the side-chat UI. |
| Outside agents over MCP         | Exists  | [Outside agents](../user/outside-agents.md).                                                                                                                                   |
| Fork, handoff, lineage          | Exists  | [Thread lineage](../orchestration-v2/thread-lineage-and-context-transfer.md). Missing: rewind as a first-class action, and fork/rewind UI polish.                              |
| Checkpoints and restore         | Exists  | Per-turn hidden git refs; restore returns the saved workspace.                                                                                                                 |
| Source control and PRs          | Partial | Diff pane, commit review, PRs on many hosts ([source control](../user/source-control.md)). Missing: graph view and the action surface.                                         |
| Secret providers                | Partial | 1Password provider package exists. Missing: environments as a user concept that scope folders and secrets.                                                                     |
| Background service              | Exists  | `t3 service` ([background service](../user/background-service.md)). Distinct from background _tasks_ inside a conversation.                                                    |
| Terminal                        | Exists  | [Terminal](../user/terminal.md). Basis for IDE mode.                                                                                                                           |
| Nested sessions                 | Partial | Services, MCP, and sidebar rows exist; not exercised in a real client.                                                                                                         |
| Teamwork                        | Partial | Board, gates, budgets, web panel, and mobile board exist; members start by hand; real multi-provider run untested; mobile not run.                                             |
| Split view                      | Partial | Implemented; layout controls seen, split not exercised in a real client.                                                                                                       |
| Saved layouts                   | Partial | Implemented; settings page exists, not exercised end to end.                                                                                                                   |
| Conversation folders            | Partial | Implemented with nested rows; not exercised end to end.                                                                                                                        |
| Chat mode                       | Partial | Enforced per adapter; web and mobile controls exist; mobile not run.                                                                                                           |
| Scheduled tasks                 | Partial | Service, settings page, and web notifications exist; a real scheduled run and notification were not observed.                                                                  |
| Computer use                    | Partial | Service, web panel, and remote view exist; live backend untested.                                                                                                              |
| IDE mode                        | Partial | Layout applies in the web client; composer is cramped at narrow widths.                                                                                                        |
| UI overhaul and ASCII landing   | Partial | ASCII landing and density shipped; wider overhaul incomplete.                                                                                                                  |

## Product principles for the fork

1. **Quiet by default.** Power is one gesture away, never on screen all at once. A new conversation
   shows almost nothing.
2. **Everything an agent can see, an agent can do.** If a user can trigger it, there is a service
   method behind it, so the orchestrator, MCP clients, and scheduled tasks reach it too.
3. **Secrets never enter the chat.** Credentials live in environments and are injected at the process
   boundary, not the prompt.
4. **Every door has a way back.** Rewind next to fork, unshare next to share, unpause next to pause.
5. **No dropped frames.** Animation is event-driven and short. Nothing repaints continuously.
6. **Remote is not an afterthought.** Each feature states how it behaves over a relay, on a phone,
   and with multiple devices.

## Ideas beyond the original list

A few additions that fit the direction and cost little once the core exists:

- **Handoff cards.** When a background task or nested session finishes, it leaves a short summary
  card in the parent conversation instead of dumping its transcript.
- **Run budgets.** A per-conversation ceiling on time, tokens, or cost, enforced by the server, so
  scheduled and teamwork runs cannot run away.
- **Replayable sessions.** Export a conversation as a self-contained replay file for bug reports and
  demos. The dev `Replay` provider is a starting point.
- **Command palette parity.** Every feature in these documents is reachable from the command
  palette, and keybindings are assignable.
- **Audit trail.** One timeline of everything the orchestrator, scheduled tasks, and remote
  guests did, filterable by actor. Builds on the existing activity log.
