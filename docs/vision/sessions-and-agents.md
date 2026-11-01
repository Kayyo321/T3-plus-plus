# Sessions and agents

This document covers how work is nested, delegated, backgrounded, branched, and rewound. The
common theme: **be explicit about who owns the work and where its context lives.**

## Nested sessions vs sub-agents

Both let one conversation hand work to another. They differ in who the user talks to.

|                 | Sub-agent                                                         | Nested session                                                                       |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Who starts it   | The parent agent, mid-run                                         | The user, or the parent agent on the user's behalf                                   |
| Who you talk to | Only the parent                                                   | You can open it and talk to it directly                                              |
| Context         | Receives only a task prompt (and optional role). Returns a result | Has its own full, durable conversation; may inherit a chosen slice of parent context |
| Lifetime        | Ends when its task ends                                           | Persists until you close it; can be resumed                                          |
| UI              | A line or card in the parent's transcript                         | A child conversation visible in the sidebar tree under the parent, and in split view |
| Typical use     | "Search the codebase for X and report"                            | "Work on the migration while I keep chatting here"                                   |

Today's app-owned sub-agents already follow the sub-agent column
([orchestrator MCP](../orchestration-v2/orchestrator-mcp-server.md)). Nested sessions are the new
first-class concept.

### Nested session behavior

- Appears indented under its parent in the sidebar and as a tab or split pane next to it.
- Parent can **wait for**, **message**, and **read** the child, and the child can **report up** with a
  summary card.
- Inheritance is a choice at creation: nothing, a summary, the full transcript to a point, or
  specific files and messages. Reuses the lineage model in
  [thread lineage](../orchestration-v2/thread-lineage-and-context-transfer.md).
- A child may use a different provider, model, permission mode, worktree, or environment than its
  parent.
- Closing the parent asks what to do with children: keep, archive, or stop.
- Depth is limited (default two levels) so a tree cannot grow without bound.

## Background tasks

A background task is **work attached to a conversation that keeps running without blocking it**:
a long test run, a dev server, a watcher, or a whole nested session.

- Start from the composer ("run in background"), by the agent, or from the orchestrator.
- Shown in a compact tray: name, state, elapsed time, last output line, and cost if applicable.
- Completion, failure, or "needs input" raises a notification and a handoff card in the parent
  conversation. The agent can be told to resume automatically when a task ends.
- Output is streamed to a log the user can open, and is bounded and rotated so it cannot grow forever.
- Survives closing the window when the background service is running, and shows on the phone
  through remote control.

Existing pieces: terminal runtime, background thread announcements, and the
[background service](../user/background-service.md). The service keeps the server alive; background
tasks are the product concept that uses it.

## Fork and rewind

Fork and rewind are two halves of exploring safely.

- **Fork** from any stable point creates a new conversation with lineage back to the source. This
  exists today; the work is polish: fork from any message, preview what context carries over, and
  show the lineage as a small tree.
- **Rewind** returns the _same_ conversation to an earlier point. Options, shown before confirming:
  - _Conversation only:_ drop messages after the point; files stay.
  - _Files only:_ restore the files from that point's checkpoint; keep the conversation.
  - _Both._
- Rewind is non-destructive by default: the discarded tail is kept as an archived branch that can be
  reopened or forked from. A one-way door is a bug.
- Checkpoints already exist per turn as hidden git refs, which makes file rewind cheap. Rewind must
  clearly handle changes the user made outside the agent (warn, offer to stash).
- Both appear in the message menu, the command palette, a keybinding, and the
  [orchestrator](./orchestrator.md)'s tool set.

## Related

- [Teamwork](./teamwork.md) is built from nested sessions with roles.
- [Git view](./git-and-source-control.md) shows checkpoints and rewinds alongside commits.
