# Orchestrator

The orchestrator is an agent docked beside your conversations that operates T3++ for you. Ask it to
start threads, tidy the sidebar, open a diff, run a scheduled check, or keep an eye on long work. It
has its own conversation, separate from the one you are in, and keeps working while you do.

Open or close it with **Orchestrator** in the sidebar or command palette (`Cmd/Ctrl+K`), or with
`Cmd/Ctrl+Alt+O`. The tab on the panel's left edge also minimizes it. Closing the panel keeps its
conversation and any work in progress.

The trash button in the panel header permanently clears the conversation, which also ends whatever
the orchestrator was doing and what it remembered of the chat. Threads it started stay, and
**Activity** keeps its record of what it did. On a phone, use **Clear conversation** on the
orchestrator screen.

## Talk to it

The panel works like a messaging app. A message shows **Read at** once the orchestrator has picked it
up, the dots show while it writes, and tool icons show what it is doing. Hover a message to react
with an emoji. It sees your reactions on its next turn and can react to you too.

It can also message you first: it says hello when you choose its model, and it tells you when work
it started finishes or needs you, if that matters. Those check-ins run on your chosen model. It stays
silent when there is nothing worth interrupting you for. New messages put a dot on its sidebar row.

## Choose its model

The first time you open it, choose a provider and model. Nothing runs until you do. A fast, cheap
model is fine for housekeeping; a stronger one suits planning. The model shows in the panel header;
click it to change. A change keeps the conversation. If the orchestrator is working, finish or
interrupt that first.

Only providers that can run without file and shell tools are offered: Claude, Codex, and OpenCode.
The orchestrator acts through the app, not your shell, so the limits below hold.

When the provider or model cannot be used, such as a signed-out provider, a used-up quota, or a
retired model, the panel says exactly why and turns off its message box. Choose **Fix it** to go to
the provider's settings, or **Choose another**. It never moves to another provider by itself, since
that could spend money or send your work somewhere you did not choose. Your choice is kept on the
machine that runs T3++, so every device shows the same one.

Requests from another owner device fail with the same reason. A scheduled task bound to the
orchestrator records **Needs input** and pauses its schedule. Fix the provider, then use **Run now**
to retry, or enable the schedule again. It keeps the failed request in the run history.

## Decide what it may do

Each area has a grant, set per machine: **Off** refuses everything, including reads. **Ask** lets it
read and asks before each change. **Allow** lets it read and change.

| Area           | Starts at |
| -------------- | --------- |
| Conversations  | Allow     |
| Sessions       | Allow     |
| Projects       | Allow     |
| Panels         | Allow     |
| Git            | Allow     |
| Tasks          | Allow     |
| Supervision    | Allow     |
| Settings       | Ask       |
| Remote control | Ask       |
| Computer use   | Off       |

Whatever the area's grant, it asks before anything that leaves your machine, such as a push, a pull
request, or sharing, and before anything that destroys data, such as deleting a conversation. Requests appear in the panel; a request
you leave unanswered for 10 minutes is refused.

It never reads secret values or security settings, and it cannot change its own grants. Guests on a
remote-control link cannot address it.

## See what it did

Choose **Activity** in the panel for everything it did, asked to do, and was refused, with the message
that led to each action.

## Let it watch stuck work

The orchestrator can look after other conversations. T3++ watches them with simple checks that cost
nothing: how long a run has taken, how long it has been quiet, whether it keeps repeating the same
action, how often it retried, and how long it has waited for an answer. Only when one of these trips
does the orchestrator read the conversation and decide what to do. Usually that is to leave it or
send the agent a note, labeled as coming from the orchestrator. It tells you when it cannot help.

Supervision has three modes:

- **Off**: no automatic reviews.
- **Modest**: the default. It steps in when a conversation looks stuck.
- **Aggressive**: it checks twice as often, trips sooner, steps in instead of waiting, and gets twice
  the nudges. This uses more of the orchestrator's model.

Set the default in **Settings > Threads**. Pick a project in settings to set the mode for all of its
threads, which replaces each thread's own choice until you reset it there. Otherwise, use the
**Supervision** slider in a thread's details panel, or the command palette. It leaves alone any
conversation you have open.

Your grants still apply in every mode. Each run gets a limited number of nudges, with a cooldown between interventions. A review can read
activity without spending a nudge, but every message, answer, or control action counts separately.
After the cap it tells you instead. Choosing **Let this conversation run** blocks further interventions
from reviews already queued. Messaging a conversation's agent is allowed by default.
Answering for it, interrupting, restarting, stopping, and rewinding ask first. If its model is
unavailable, supervision pauses and the panel says so.
