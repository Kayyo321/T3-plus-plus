# Teamwork

## What it is

Teamwork is a built-in skill that turns one request into **a small simulated company working on it**:
designated teams, written hand-offs, and several review phases before anything is called done.
Single agents are fast but tend to grade their own homework. Teamwork separates the people who build
from the people who check, the way a real engineering org does.

Think of it as the difference between asking one engineer to ship a feature and opening a project
with a lead, builders, a reviewer, a tester, and someone whose only job is to say "this doesn't match
what was asked."

## The shape of a run

```text
Request
  -> Intake        clarify goals, constraints, definition of done
  -> Plan          lead drafts a plan and a task breakdown
  -> Plan review   independent reviewers challenge the plan
  -> Build         implementation teams work in parallel, each in its own session
  -> Peer review   reviewers read diffs, not summaries
  -> Verification  testers run the code and the checks
  -> Acceptance    a skeptic compares the result to the original request
  -> Report        one summary, with evidence, open risks, and what was not verified
```

Phases can loop: review feedback goes back to build; failed verification goes back to build with the
failing output attached. A phase ends when its exit criteria are met, not when time runs out.

## Roles and teams

Roles are configurable; the defaults should be few and clear.

| Role | Responsibility |
| --- | --- |
| **Lead** | Owns the plan, decomposes work, resolves disputes, writes the final report. Does not build. |
| **Builders** | One or more, each assigned a slice and its own worktree or branch. |
| **Reviewer** | Reads the actual diff for correctness, design, and taste. Has no stake in the code. |
| **Tester** | Runs tests, reproduces bugs, and writes missing ones. Reports evidence. |
| **Skeptic / QA** | Checks the result against the request and hunts for what everyone assumed. |
| **Scribe** (optional) | Maintains the shared notes and decision log. |

A *team* is a named group with a role mix, instructions, and a provider and model per role. Examples:
*Fix a bug* (one builder, tester, reviewer), *Build a feature* (lead, two builders, reviewer, tester,
skeptic), *Audit* (reviewers and a skeptic only, no builders).

Different roles can use **different providers and models**. A reviewer on a different model than the
builder is a feature: it avoids correlated blind spots.

## Working environment

- **Shared board.** A live task board: tasks, owners, state, blockers. It is the main view of a
  teamwork run and the thing you glance at.
- **Notes and decisions.** A shared document the team reads and writes: plan, decisions and their
  reasons, open questions. Keeps agents aligned without replaying transcripts.
- **Separate working copies.** Builders get isolated worktrees; merges are done by the lead, with
  conflicts surfaced instead of silently resolved.
- **Handoffs, not transcripts.** Teams pass structured handoff cards (what was done, how to verify,
  known gaps). Reviewers receive the diff and the cards.
- **Stand-ups.** Optional periodic summaries so a human can drop in, correct course, and leave.
- **Human in the loop.** You can approve the plan, answer questions, reassign, or stop the run.
  Dials: *autonomous*, *approve the plan*, *approve each phase*.

Mechanically this is nested sessions ([sessions](./sessions-and-agents.md)) plus the
[orchestrator](./orchestrator.md)'s tooling, so it should require little new infrastructure beyond
the roles, the board, and the phase logic.

## Guardrails

- **Budgets.** Set limits on total cost, time, parallel agents, and review loops. The default review
  loop limit prevents endless back-and-forth.
- **Evidence over assertion.** Verification and acceptance require commands run and outputs
  captured. "Looks good" is not a pass.
- **No self-approval.** The agent that built a slice cannot review or accept it.
- **Honest reports.** The final report lists what was and was not verified, and failed checks stay
  visible.
- **Permissions inherit downward.** A team cannot hold more permission than the conversation that
  started it.

## Ideas worth trying

- **Red team phase** for security-sensitive changes: an agent tries to break the result.
- **Retrospective** at the end that saves lessons (what reviewers caught, what slipped through) as a
  project note for next time.
- **Presets as files** in the repository, so teams share their team definitions the way they share
  lint config.
- **Dry run** that produces only the plan and team assignment, with a cost estimate, before spending
  anything.
