# Chat mode, scheduled tasks, and computer use

Three capabilities that change *what an agent is allowed to do and when*.

## Chat mode (Chat + Code)

A conversation has a **mode**, chosen at creation and changeable later.

| Mode | The agent can | The agent cannot |
| --- | --- | --- |
| **Chat** | Talk, reason, research, and produce **documents** (notes, drafts, plans, diagrams) | Read or write your project files, run commands, or touch your machine |
| **Code** | Everything permission modes already allow: read and edit files, run commands | n/a (bound by permission mode) |

Chat mode is for thinking: brainstorming, writing, planning, asking questions, drafting a spec before
touching code. Its outputs live **inside the app**, as documents attached to the conversation, not as
files in your working tree.

- **Documents** are first-class: rendered in a side panel, editable by you and the agent, versioned,
  and exportable (Markdown to start). Moving one into a project is an explicit, user-confirmed
  action.
- **Enforced by the server, not the prompt.** Chat mode withholds file and shell tools from the
  provider session and rejects them if requested, rather than asking the model nicely. Providers
  differ, so each adapter decides how it enforces this (and says so where it cannot).
- **Upgrade path.** "Continue in Code mode" forks or converts the conversation, carrying the document
  as context. The reverse (drop to Chat) is equally easy.
- Distinct from [permission modes](../user/permission-modes.md), which control *approvals*. Chat mode
  controls *which capabilities exist at all*.
- Lightweight by design: no project required, which makes quick questions and notes fast.

## Scheduled tasks and repeaters

Run a prompt, a skill, or a [teamwork](./teamwork.md) run **on a schedule, or on a trigger**, with
no one watching.

- **Schedules:** one-shot ("tomorrow 9am"), repeating ("weekdays 9am", "every 30 minutes"),
  and cron expressions for power users. Plain-language entry first.
- **Triggers** (stretch): on a new commit or branch, on a file change, when another task finishes.
- **Repeaters / loops:** re-run until a condition is met, with a maximum number of iterations
  and a way to define "done" ("until tests pass", "until the PR has no unresolved comments").
- **Each run is a conversation** in a *Scheduled* folder with its own history, so you can open a run,
  read what happened, and take over.
- **Results:** a short summary and status per run, notifications on completion or failure, and a
  "nothing changed" quiet path so repeaters do not spam.
- **Safety:** runs inherit a permission mode and a budget (time, cost, tool use). Unattended tasks
  should default to *least privilege* and ask nothing interactively; anything that would normally
  prompt either fails safe or parks the run as "needs input".
- **Where they run:** the environment that owns the task. For tasks to fire with no client open,
  the [background service](../user/background-service.md) must be running; the UI says so when it
  is not. Missed runs (machine asleep) are handled per task: skip, run once on wake, or catch up.
- **Management:** list, pause, edit, run now, and see next run times, in a single view. Also exposed
  to the [orchestrator](./orchestrator.md).

The repo already has pieces around background work and an agent-driven MCP surface; confirm what
exists for task persistence before designing storage, and keep the schedule model small.

## Computer use

Let an agent **see and operate a desktop** through screenshots, clicks, and typing, for tasks no API
covers: GUI-only apps, visual QA of what it built, filling in a flow end to end.

- **Strictly opt-in**, per conversation, off by default, and clearly indicated while active
  (a persistent indicator, and one-click stop that always works).
- **Scoped targets.** Prefer a narrow target over the whole screen: a specific window, the app's
  built-in browser, or a sandboxed virtual display. Whole-desktop control is the most powerful and
  the most dangerous tier.
- **Isolation first.** For autonomous runs, a container or VM with its own display is the right
  default; controlling the user's real session is for supervised work.
- **Approvals.** Sensitive steps (entering credentials, purchases, sending messages, deleting)
  require explicit user approval, and credential entry is never done by the agent from chat
  content. Secrets come from [workspaces](./layouts-workspaces-and-folders.md), never the prompt.
- **Visibility.** The user can watch a live view and a step log (screenshot, action, result) and take
  over at any time.
- **Remote.** Control and viewing work through [remote control](./remote-control.md), where a phone
  becomes the "watch and approve" surface. Access levels apply: a view-only guest never gets input.
- **Platform reality.** Implementation differs per OS (permissions on macOS, display servers on
  Linux, Windows). Treat the desktop app as the host. Web-only and mobile clients drive it
  remotely, not locally.
- **Providers.** Some providers offer native computer use; others need an adapter-level tool. Decide
  per provider, including "not supported".
