import {
  TEAM_PHASES,
  type TeamAction,
  type TeamMember,
  type TeamMemberId,
  type TeamPhase,
  type TeamRole,
  type TeamRun,
  type TeamTask,
  type TeamworkErrorReason,
} from "@t3tools/contracts";

export interface TeamRefusal {
  readonly reason: TeamworkErrorReason;
  readonly detail: string;
}

export type TeamTransition =
  | { readonly ok: true; readonly run: TeamRun }
  | { readonly ok: false; readonly refusal: TeamRefusal };

const refuse = (reason: TeamworkErrorReason, detail: string): TeamTransition => ({
  ok: false,
  refusal: { reason, detail },
});

const next = (phase: TeamPhase): TeamPhase => {
  const index = TEAM_PHASES.indexOf(phase);
  return TEAM_PHASES[Math.min(index + 1, TEAM_PHASES.length - 1)] ?? phase;
};

/** Who may judge each review phase. Builders appear in none of them. */
const JUDGES: Partial<Record<TeamPhase, ReadonlyArray<TeamRole>>> = {
  plan_review: ["reviewer", "skeptic"],
  peer_review: ["reviewer"],
  verification: ["tester"],
  acceptance: ["skeptic", "reviewer"],
};

/** A failed judgment sends the work back here, with what failed attached. */
const SENT_BACK_TO: Partial<Record<TeamPhase, TeamPhase>> = {
  plan_review: "plan",
  peer_review: "build",
  verification: "build",
  acceptance: "build",
};

const NEEDS_EVIDENCE: ReadonlySet<TeamPhase> = new Set(["verification", "acceptance"]);

const memberOf = (run: TeamRun, id: TeamMemberId): TeamMember | undefined =>
  run.members.find((member) => member.id === id);

const verdictsThisRound = (run: TeamRun) => {
  const lastSendBack = run.verdicts.findLastIndex(
    (verdict) => verdict.phase === run.phase && !verdict.passed,
  );
  return run.verdicts.slice(lastSendBack + 1).filter((verdict) => verdict.phase === run.phase);
};

const gateFor = (run: TeamRun, phase: TeamPhase): string | null => {
  if (run.dial === "approve_each_phase") return `Approve moving on to ${phase}.`;
  if (run.dial === "approve_plan" && phase === "build") return "Approve the plan.";
  return null;
};

/** Enters a phase, or stops at the owner's gate for it. */
const enter = (run: TeamRun, phase: TeamPhase): TeamRun => {
  const waitingFor = gateFor(run, phase);
  return waitingFor === null
    ? { ...run, phase, status: "running", waitingFor: null }
    : { ...run, status: "awaiting_owner", waitingFor };
};

const advance = (run: TeamRun, byId: TeamMemberId): TeamTransition => {
  const actor = memberOf(run, byId);
  if (actor?.role !== "lead") return refuse("not_a_member", "Only the lead moves a run on.");
  if (run.phase === "report") {
    return refuse("wrong_phase", "Write the report; it ends the run.");
  }
  if (run.dryRun && run.phase === "plan") {
    return {
      ok: true,
      run: { ...run, status: "completed", waitingFor: null },
    };
  }
  if (run.phase === "build" && run.tasks.some((task) => task.state !== "done")) {
    return refuse("wrong_phase", "Every task must be done before review.");
  }
  const judges = JUDGES[run.phase];
  if (judges !== undefined) {
    const verdicts = verdictsThisRound(run);
    if (!verdicts.some((verdict) => verdict.passed)) {
      return refuse("needs_verdict", `${run.phase} needs a passing verdict first.`);
    }
    if (NEEDS_EVIDENCE.has(run.phase)) {
      const failed = run.evidence.filter((entry) => !entry.passed);
      const passed = run.evidence.filter((entry) => entry.passed);
      if (passed.length === 0) {
        return refuse("needs_evidence", "Run the checks and record their output.");
      }
      if (failed.some((entry) => !passed.some((good) => good.command === entry.command))) {
        return refuse("failed_checks", "A check failed and has not passed since.");
      }
    }
  }
  return { ok: true, run: enter(run, next(run.phase)) };
};

const verdict = (
  run: TeamRun,
  action: Extract<TeamAction, { readonly type: "verdict" }>,
  at: string,
): TeamTransition => {
  const judges = JUDGES[run.phase];
  if (judges === undefined) return refuse("wrong_phase", `${run.phase} takes no verdict.`);
  const judge = memberOf(run, action.byId);
  if (judge === undefined || !judges.includes(judge.role)) {
    return refuse("not_a_member", `Only a ${judges.join(" or ")} judges ${run.phase}.`);
  }
  if (run.tasks.some((task) => task.builtBy.includes(action.byId))) {
    return refuse("self_approval", "A member who built part of this cannot judge it.");
  }
  const recorded = {
    phase: run.phase,
    byId: action.byId,
    passed: action.passed,
    reason: action.reason,
    at,
  };
  const judged = { ...run, verdicts: [...run.verdicts, recorded] };
  if (action.passed) return { ok: true, run: judged };

  const reviewLoops = run.reviewLoops + 1;
  if (reviewLoops > run.budget.maxReviewLoops) {
    return {
      ok: true,
      run: {
        ...judged,
        reviewLoops,
        status: "awaiting_owner",
        waitingFor: `The review loop limit was reached: ${action.reason}`,
      },
    };
  }
  const target = SENT_BACK_TO[run.phase] ?? run.phase;
  return {
    ok: true,
    run: {
      ...judged,
      reviewLoops,
      phase: target,
      tasks:
        target === "build"
          ? run.tasks.map((task) => (task.state === "done" ? { ...task, state: "doing" } : task))
          : run.tasks,
    },
  };
};

const upsertTask = (
  run: TeamRun,
  action: Extract<TeamAction, { readonly type: "task_upsert" }>,
): TeamTransition => {
  const existing = run.tasks.find((task) => task.id === action.taskId);
  if (existing === undefined && action.title === undefined) {
    return refuse("not_found", "A new task needs a title.");
  }
  const ownerId = action.ownerId === undefined ? (existing?.ownerId ?? null) : action.ownerId;
  const owner = ownerId === null ? undefined : memberOf(run, ownerId);
  const task: TeamTask = {
    id: action.taskId,
    title: action.title ?? existing?.title ?? "",
    ownerId,
    state: action.state ?? existing?.state ?? "todo",
    ...(action.blocker === undefined ? {} : { blocker: action.blocker }),
    builtBy:
      owner?.role === "builder" && !(existing?.builtBy ?? []).includes(owner.id)
        ? [...(existing?.builtBy ?? []), owner.id]
        : (existing?.builtBy ?? []),
  };
  return {
    ok: true,
    run: {
      ...run,
      tasks:
        existing === undefined
          ? [...run.tasks, task]
          : run.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
    },
  };
};

const report = (
  run: TeamRun,
  action: Extract<TeamAction, { readonly type: "report" }>,
): TeamTransition => {
  if (memberOf(run, action.byId)?.role !== "lead") {
    return refuse("not_a_member", "The lead writes the report.");
  }
  if (run.phase !== "report") return refuse("wrong_phase", "Reach the report phase first.");
  // A failed check stays visible: it must appear unless a later run of it passed.
  const unresolved = run.evidence.filter(
    (entry) =>
      !entry.passed && !run.evidence.some((good) => good.passed && good.command === entry.command),
  );
  const named = action.report.notVerified.join("\n");
  const hidden = unresolved.filter((entry) => !named.includes(entry.command));
  if (hidden.length > 0) {
    return refuse("failed_checks", `The report must name ${hidden[0]?.command}.`);
  }
  return {
    ok: true,
    run: { ...run, report: action.report, status: "completed", waitingFor: null },
  };
};

const CLOSED = new Set<TeamRun["status"]>(["stopped", "completed"]);

/** Every rule of a run, with no I/O, so each is tested directly. */
export const applyTeamAction = (run: TeamRun, action: TeamAction, at: string): TeamTransition => {
  if (CLOSED.has(run.status)) return refuse("run_closed", "This run has ended.");
  const applied = (): TeamTransition => {
    switch (action.type) {
      case "advance":
        return run.status === "awaiting_owner"
          ? refuse("wrong_phase", run.waitingFor ?? "The run waits for its owner.")
          : advance(run, action.byId);
      case "owner_approve": {
        if (run.status !== "awaiting_owner") return refuse("wrong_phase", "Nothing is waiting.");
        const phase = next(run.phase);
        return {
          ok: true,
          run: {
            ...run,
            phase: run.reviewLoops > run.budget.maxReviewLoops ? run.phase : phase,
            status: "running",
            waitingFor: null,
            ...(run.reviewLoops > run.budget.maxReviewLoops ? { reviewLoops: 0 } : {}),
          },
        };
      }
      case "owner_stop":
        return { ok: true, run: { ...run, status: "stopped", waitingFor: action.reason } };
      case "verdict":
        return verdict(run, action, at);
      case "task_upsert":
        return upsertTask(run, action);
      case "note":
        return {
          ok: true,
          run: {
            ...run,
            notes: [...run.notes, { kind: action.kind, byId: action.byId, text: action.text, at }],
          },
        };
      case "handoff":
        return {
          ok: true,
          run: {
            ...run,
            handoffs: [
              ...run.handoffs,
              {
                taskId: action.taskId,
                fromId: action.fromId,
                done: action.done,
                howToVerify: action.howToVerify,
                knownGaps: action.knownGaps,
                at,
              },
            ],
          },
        };
      case "evidence":
        return {
          ok: true,
          run: {
            ...run,
            evidence: [
              ...run.evidence,
              {
                ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
                byId: action.byId,
                command: action.command,
                output: action.output.slice(-4_000),
                passed: action.passed,
                at,
              },
            ],
          },
        };
      case "report":
        return report(run, action);
    }
  };
  const result = applied();
  return result.ok ? { ok: true, run: { ...result.run, updatedAt: at } } : result;
};

/** Parks a run past its time budget; the monitor calls this rather than any member. */
export const enforceTeamBudget = (run: TeamRun, nowMs: number): TeamRun | null =>
  run.status === "running" && nowMs - Date.parse(run.startedAt) > run.budget.maxMinutes * 60_000
    ? {
        ...run,
        status: "over_budget",
        waitingFor: `The run passed its ${run.budget.maxMinutes} minute budget.`,
      }
    : null;
