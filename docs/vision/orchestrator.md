# Orchestrator

## What it is

The orchestrator is a designated agent that lives **beside** your conversations and can operate the
whole editor on your behalf. You open it as a concurrent side-conversation, like the dots-style
assistant panel in ChatGPT's desktop app: a small panel docked next to whatever you are doing, with
its own history, talking to an agent that can see and change the app around it.

Ask it things like:

- "Start three threads in `api`, one per failing test, and tell me when they finish."
- "Rename these threads, move them into the _Migration_ folder, and archive the done ones."
- "Open the diff for the last turn in the other conversation and summarize it."
- "Switch to my _Review_ layout and put the remote link for this conversation on my phone."
- "Every morning at 9, run the dependency check in `web` and post the result here."

It is not a replacement for the conversation you are working in. It is the person at the next desk
who can reach every conversation, project, setting, and panel.

## Why this fits the codebase

The server already exposes orchestration over MCP: creating, listing, reading, renaming, steering,
and interrupting threads, plus app-owned sub-agents
([orchestrator MCP](../orchestration-v2/orchestrator-mcp-server.md)). The orchestrator is the same
idea promoted to a product surface and extended from "threads" to "the editor".

Per the repo's design rules, a capability must be a **service method first**. Transports (WebSocket
handlers, HTTP, MCP tools) stay thin. The orchestrator is therefore the sum of tools over existing
and new services, not a separate subsystem.

## Experience

- **Panel, not page.** A dockable panel (right side by default, detachable, usable in split view).
  Opens with a keybinding and from the command palette. Closes without losing state.
- **Concurrent.** It keeps working while you work. Its runs show in the same activity surfaces as any
  other thread, marked as orchestrator-owned.
- **Context-aware.** By default it knows which conversation, project, workspace, layout, and branch are
  focused, and can be pointed at others explicitly. It never silently reads conversations you did
  not make visible to it (see Scope).
- **Visible hands.** When it changes something, the UI shows it: a thread appears with a brief
  highlight, a panel opens, a setting flips. A short "what I did" list ends each action so nothing
  surprising happens off-screen.
- **Interruptible.** One key stops it. Anything it can do can be undone from the audit view where
  the underlying action is reversible.

## What it can reach

Group tools by domain so permissions can be granted per group.

| Domain         | Examples                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------- |
| Conversations  | create, list, read, send, steer, interrupt, rename, fork, rewind, archive, move to folder       |
| Sessions       | start nested sessions and sub-agents, wait for results, cancel                                  |
| Projects       | add, open, switch environment                                                                   |
| Workspace UI   | open or close panels, apply a saved layout, split view, focus                                   |
| Git            | read the graph, stage, commit, branch, merge, rollback, open and update PRs                     |
| Tasks          | create, edit, pause, and run scheduled tasks and background tasks                               |
| Supervision    | review stuck or looping work, message the agent, interrupt, restart, stop, rewind               |
| Settings       | read and change non-security settings                                                           |
| Remote control | turn the switch on or off for a conversation, rotate links, revoke guests                       |
| Computer use   | only when explicitly enabled (see [modes and computer use](./modes-scheduling-computer-use.md)) |

## Choosing its brain

The orchestrator runs on a provider and model the user chooses. There is no silent default.

- **First open:** the first time you click the orchestrator, it asks which provider and model to use
  before showing a chat. Only connected, usable providers are offered, with a one-line note on cost
  and capability. A cheap, fast model is a fine choice for housekeeping; a stronger one suits
  planning. Nothing runs until you confirm.
- **Change any time:** the panel header shows the current provider and model; one click opens the
  same picker. Switching keeps the orchestrator's conversation and carries context over using the
  existing provider-switching model
  ([provider switching](../orchestration-v2/provider-switching-and-context.md)). A run in progress is
  finished or interrupted first, and the picker says which.
- **Blocked when unavailable:** if the chosen provider or model cannot be reached for any reason
  (not installed, signed out, expired credentials, quota, model retired, network or server down), the
  composer is **disabled**. The panel shows the specific reason and two actions: _fix it_ (open that
  provider's sign-in or settings) and _choose another_. The user cannot message the orchestrator
  until it is fixed or changed. It must never silently fall back to a different provider, since
  that could spend money or send context somewhere the user did not choose.
- **Checked continuously:** availability is verified on open, before each send, and when a run
  fails, and the state updates live without a restart. A failure mid-run stops cleanly and shows the
  same blocked state.
- **Scheduled and remote use:** scheduled tasks and other surfaces that call the orchestrator fail
  with the same reason and park as "needs attention", rather than switching brains on their own.
- **Remembered per environment.** The choice is stored with the environment, so every client
  (web, desktop, mobile, a remote session) shows the same brain.

## Watching for stuck and looping work

The orchestrator can supervise other conversations, not just act when asked. It notices work that
has stopped making progress, reviews it, and decides what to do.

**What it watches for**

- A background task or run that exceeds its expected time, or goes quiet (no output, no tool activity).
- A _loop_: the same command, error, or edit repeated, or two steps undoing each other.
- A run waiting on input or approval for a long time.
- A scheduled or [teamwork](./teamwork.md) run that exceeds its budget or keeps failing the same
  review phase.
- A nested session whose parent is waiting on it.

**Detection is cheap and mechanical.** The server computes the signals (elapsed time against a
threshold, output and event silence, repeated-action fingerprints, retry counts). No model is
called until a signal fires, so supervision costs nothing while work is healthy. Thresholds are
settings, with sensible defaults and per-conversation overrides.

**Review.** When a signal fires, the orchestrator reads the conversation's recent activity (using its
normal read tools, within its grants) and forms a judgment: still making progress, waiting on
something legitimate, stuck, or looping.

**What it can do.** In order of preference:

1. **Leave it** and note why ("a 20 minute build is normal here"), and snooze the check.
2. **Talk to the conversation's agent**: steer it with a message ("you've retried this three times;
   try X or explain what is blocking you"), ask for a status, or suggest a different approach.
3. **Help it directly**: check the process, read the log, or answer a pending question the agent is
   blocked on, when the grant allows.
4. **Escalate to you**: raise a notification with a short diagnosis and options.
5. **Interrupt, restart, or stop** the run or background task, or **rewind** to before the loop began
   ([sessions](./sessions-and-agents.md)). These ask first by default.

**Guardrails**

- **Opt-in per conversation, and on by default only for unattended work** (scheduled tasks,
  background tasks, teamwork runs). Interactive conversations are watched only if you turn it on.
- **Bounded intervention.** A cap on nudges per run, and a cooldown between them, so the orchestrator
  and the agent cannot loop with each other. After the cap it escalates to you.
- **Visible and attributed.** Every message it sends into a conversation is labeled as coming from the
  orchestrator, and every review, decision, and intervention lands in the audit trail with its
  reasoning.
- **Grants apply.** Messaging, interrupting, and stopping are separate grants. A destructive step
  never happens silently.
- **Not a babysitter for you.** It does not interrupt a run you are actively watching or typing
  into, and it stays quiet for work you marked "let it run".
- **Cost-aware.** Reviews run on the orchestrator's chosen brain and count against its budget. If the
  brain is unavailable (see above), supervision pauses and the UI says so rather than going silent.
- **Remote aware.** Review results and escalations reach your phone through the same notifications as
  other attention-needed events.

## Scope and safety

The orchestrator is the most powerful agent in the app, so its limits matter more than its features.

- **Capability grants.** Each domain above is off, ask, or allow, per environment. Defaults: read
  everything, ask before changes that leave the machine (pushes, PRs, remote sharing) or destroy
  data (delete, hard rollback).
- **Never touches secrets.** It can reference an environment by name; it cannot read secret values or
  security settings, and cannot change its own grants. Those stay user-only.
- **Provenance.** Every action it takes is recorded with the actor `orchestrator`, the requesting
  message, and the result, in the audit trail.
- **Bounded.** Runs obey the same budgets as any scheduled or teamwork run.
- **Remote aware.** When a conversation is being remote-controlled, the guest cannot address the
  orchestrator. The orchestrator belongs to the owner's session.

## Open questions

- Is the orchestrator one persistent agent per environment, or one per window? A per-window agent
  is simpler to reason about; a per-environment agent can keep working when the window closes.
- Should it be able to run in the background service with no client attached? That makes scheduled
  orchestration possible but raises the stakes on grants.
