# Git and source control

## What it is

A first-class **git view**: the full commit graph of the repository, rendered beautifully, with the
common git actions available as direct manipulation. You should rarely need to leave the app to
understand or change the state of your repository, and the agents' work should be visible _in_ that
history.

The foundation exists: diff pane, per-turn and per-commit review, branch comparison, worktrees, and
pull requests across several hosts ([source control](../user/source-control.md)). What is missing is
the **whole-repository picture** and the action surface.

## The graph

- All branches, tags, and remotes as colored lanes with commit nodes, merges, and forks.
- Distinct visual identity for **agent checkpoints**, **turns**, and **worktrees**, so you can see
  "this commit came from that turn in that conversation". Click a node to jump to the conversation.
- Branch and lane colors are stable and meaningful (theme-aware, high contrast, never the only
  signal: shape and label too).
- Smooth, purposeful motion: new commits slide in, a merge animates its lanes joining, a rollback
  rewinds the head. Animations are short, triggered by events, and skippable. Nothing animates
  idly (see [UI direction](./ui-direction.md)).
- Scales to large histories: virtualized rows, lazy loading, and server-side graph layout so huge
  repositories do not stall the UI.
- Search and filter by author, path, message, conversation, or "agent-made".
- Works with the repo of the focused conversation, including worktrees.

## Actions

| Action                   | Notes                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commit unstaged work** | Stage by file or hunk, write or generate a message, commit. Agent-drafted messages are suggestions, always editable.                         |
| **Branch**               | Create from any node, check out, rename, delete (with unmerged warning).                                                                     |
| **Merge**                | Preview the result and conflicts before doing it; conflict resolution flow with an optional agent assist.                                    |
| **Rebase / cherry-pick** | Behind a clear "rewrites history" notice.                                                                                                    |
| **Rollback**             | Return to a previous commit or checkpoint. Soft (keep changes), mixed, or hard, named in plain words. Always creates a recovery point first. |
| **Create PR**            | From a branch, with title and body drafted from the diff, linked to the conversation. Update and track existing ones.                        |
| **Push / pull / fetch**  | With ahead/behind shown on the lane.                                                                                                         |
| **Stash**                | List, apply, drop.                                                                                                                           |

Design rules:

- **Preview before destroy.** Anything that rewrites or discards shows exactly what will change and
  keeps a recovery path (reflog entry or hidden ref) so the action is reversible.
- **Plain-language operations.** "Undo last commit, keep my changes" beats `reset --mixed HEAD~1`.
- **Every action is a service method** so the [orchestrator](./orchestrator.md), scheduled tasks, and
  MCP clients can use it, subject to permission grants (pushes and force operations ask by default).
- **Hit every surface.** Web and desktop get the full view. Mobile gets a read-friendly graph and the
  safe actions (view, commit, PR status), not drag-and-drop history surgery.

## Agent-aware extras

- **Checkpoint overlay:** toggle hidden checkpoint refs onto the graph to see a conversation's
  intermediate states, and rewind from there ([sessions](./sessions-and-agents.md)).
- **Review lanes:** show branches created by [teamwork](./teamwork.md) builders and their merge by
  the lead.
- **Blame to conversation:** from a line in the diff, jump to the turn that wrote it.
- **Risk badges:** flag commits that touch sensitive paths or exceed a size threshold before they
  are pushed.

## Out of scope for now

Hosting-provider features beyond PRs (issues, CI dashboards) and interactive rebase editors. Revisit
once the graph and the core actions are solid.
