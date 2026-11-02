# Teamwork

## What it is

Teamwork lets one thread run a request through a small team of agents laid out as a **sheet**: a
flow chart with one Project Lead and teams that build, review, and validate the work. Single agents
are fast but tend to grade their own homework. Teamwork keeps the people who build apart from the
people who check, the way a real engineering org does.

The lead plans and coordinates. It decides which provider, model, and effort each team uses, how big
each team is, and who gets which task, within the model option each team was given. The sheet decides
what responsibilities exist and what checks sit between them.

## Sheets are flow charts

- A sheet is a named flow chart, stored per environment, with a revision number. Its nodes are the
  Project Lead, and teams of kind `build`, `review`, or `validate`. Its edges are `handoff` (forward on a
  pass) or `return` (back for correction).
- Exactly one Project Lead node. Its model is the thread's model, snapshotted when the run starts.
- A user-added team picks one of the three work kinds, and the kind decides its behaviour. Build teams
  get their own worktrees. Review and validate teams never edit.
- Each team has one of three model options:
  - **A. Lead decides.** The lead picks any provider and model.
  - **B. Lead decides within one provider.** The lead picks the model, on a provider the sheet fixes.
  - **C. Pinned.** One exact provider instance and model, every run.
    In all three the lead still chooses effort and team size. The default sheet gives every team option A.
- The built-in default sheet is read-only. "Create new sheet" starts from a copy of it. Any other
  sheet can be edited and deleted.
- Saving refuses a sheet the run could not execute, with a plain message: no lead, more than one lead,
  a node the lead cannot reach, or no path to acceptance.
- Node ids are stable across edits, so a run's history keeps pointing at the right team.

## Workflow

```text
Lead defines and assigns
  -> Build           produces integrated work in its worktree
  -> Review          inspects the diff, not the summary
       changes required -> back to Build
  -> Validate        runs the code and the acceptance checks
       fail -> back to Build
  -> Lead accepts and reports
```

A blocked task goes back to the lead, which decides on dependencies, access, scope, or approach. It does
not go to the next team in line.

Every handoff names its verdict and the evidence behind it:

- **Build** says what changed, where, which requirements it addresses, what it checked, and what remains
  uncertain.
- **Review** returns PASS or CHANGES REQUIRED, with findings marked Blocking or Suggestion, and lists
  what it could not check.
- **Validate** returns PASS, FAIL, or BLOCKED, with evidence for each acceptance criterion, on the same
  candidate version Review read.

The rules every agent in a run follows are defined once in shared code (`TEAM_OPERATING_RULES`), not
repeated in each sheet.

## The roster is the non-negotiable

A thread keeps one roster per sheet. Each team slot on it is bound to a nested session that belongs to
that thread. Every later run on that sheet re-invokes the same sessions. It does not create new ones.

The reason is what a new session lacks. It has an empty conversation, so it does not remember the plan,
the review it already got, or the decision the lead made last time. A build team also gets a new
worktree, which means its half-finished work is not where it was. Re-creating sessions every run throws
all of that away, and the team starts from zero each time.

Team sessions are created lazily, the first time the lead addresses that node. Replacing a slot is an
explicit act, taken from the run board, when its session is blocked (for example, because it was deleted).

## Growth

Growth is a setting on the Project Lead node. It decides whether a run may add members to the roster.

- **Off** (default). The roster is fixed after the first run. Requests are refused before they reach the
  lead.
- **On.** The lead decides each request.
- **Ask.** The owner answers first, on the run board. A denial is final.

When Growth is On or Ask, a request also carries a scope:

- **Per session** joins this thread's roster only.
- **Save to sheet** also adds the member as a node on the sheet, behind a revision check.

Each team may make one growth request per run, whatever state the run is in.

## Nested-session shape

A teamwork run is a small tree of nested sessions under the thread:

```text
thread
  -> team session
       -> member
```

The tree is two levels below the thread, which is the default nested-session depth cap. Members sit
under the team that started them, and the run board links each one. The lead is the run's parent thread
and has no session of its own in the tree.

## Run board

The run board shows where the run is in the flow, each slot's status, growth requests waiting for an
owner, and any denial with its reason. A blocked slot says why it is blocked and offers Replace. The
board can stop a run. A stopped run resumes from its current step with the same sessions.

Run status is one of `running`, `awaiting_owner`, `blocked`, `over_budget`, `stopped`, or `done`.

## Guardrails

- **Budgets.** A run has limits on cost, time, and parallel agents. A run that exceeds one stops as
  `over_budget` and waits for a larger budget before it continues.
- **Correction cycles.** A return from Review or Validate counts as one cycle. A run that keeps failing
  the same check stops for its owner instead of looping.
- **Evidence over assertion.** Review and Validate cite commands run and their output. "Looks good" is
  not a pass.
- **No self-approval.** The session that built a slice cannot review or validate it.
- **Honest reports.** The final report lists what was and was not verified, and failed checks stay
  visible.
- **Permissions inherit downward.** A team cannot hold more permission than the thread that started it.

## Ideas worth trying

- **Red team** step for security-sensitive changes: an agent tries to break the result before Validate.
- **Retrospective** at the end that saves what reviewers caught and what slipped through, as a project
  note for next time.
- **Sheets as files** in the repository, so teams share their flow charts the way they share lint config.
- **Dry run** that produces only the lead's plan and team assignments, with a cost estimate, before
  anything spends.
