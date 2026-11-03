import {
  TEAM_LEAD_MEMBER_ID,
  TeamFindingId,
  type TeamAction,
  type TeamEdgeKind,
  type TeamFinding,
  type TeamGrowthRequest,
  type TeamHandoff,
  type TeamMember,
  type TeamMemberId,
  type TeamNodeId,
  type TeamRun,
  type TeamTask,
  type TeamVerdict,
  type TeamVerdictOutcome,
  type TeamworkErrorReason,
} from "@t3tools/contracts";

export interface TeamRefusal {
  readonly reason: TeamworkErrorReason;
  readonly detail: string;
}

export type TeamTransition =
  | { readonly ok: true; readonly run: TeamRun }
  | { readonly ok: false; readonly refusal: TeamRefusal };

type Action<T extends TeamAction["type"]> = Extract<TeamAction, { readonly type: T }>;

const refuse = (reason: TeamworkErrorReason, detail: string): TeamTransition => ({
  ok: false,
  refusal: { reason, detail },
});

const ok = (run: TeamRun): TeamTransition => ({ ok: true, run });

const CLOSED = new Set<TeamRun["status"]>(["stopped", "done"]);

const REVIEW_OUTCOMES: ReadonlyArray<TeamVerdictOutcome> = ["pass", "changes_required"];
const VALIDATE_OUTCOMES: ReadonlyArray<TeamVerdictOutcome> = ["pass", "fail", "blocked"];

const memberOf = (run: TeamRun, id: TeamMemberId): TeamMember | undefined =>
  run.members.find((member) => member.id === id);

const taskOf = (run: TeamRun, id: TeamTask["id"]): TeamTask | undefined =>
  run.tasks.find((task) => task.id === id);

const kindOf = (run: TeamRun, nodeId: TeamNodeId) =>
  run.flow.nodes.find((node) => node.id === nodeId)?.kind;

const leadNodeId = (run: TeamRun): TeamNodeId | null =>
  run.flow.nodes.find((node) => node.kind === "lead")?.id ?? null;

/** Where the edges of one kind leaving a node point. */
const reachable = (run: TeamRun, from: TeamNodeId | null, kind: TeamEdgeKind): TeamNodeId[] =>
  run.flow.edges.filter((edge) => edge.from === from && edge.kind === kind).map((edge) => edge.to);

const withTask = (run: TeamRun, task: TeamTask): TeamRun => ({
  ...run,
  tasks: run.tasks.map((candidate) => (candidate.id === task.id ? task : candidate)),
});

const upsertTask = (run: TeamRun, action: Action<"task_upsert">): TeamTransition => {
  const existing = taskOf(run, action.taskId);
  if (existing === undefined && action.objective === undefined) {
    return refuse("not_found", "A new task needs an objective.");
  }
  if (action.status !== undefined && action.status !== "queued" && action.status !== "building") {
    return refuse("wrong_phase", "Handoffs and verdicts move a task to its other states.");
  }
  const ownerId = action.ownerId === undefined ? (existing?.ownerId ?? null) : action.ownerId;
  const owner = ownerId === null ? undefined : memberOf(run, ownerId);
  if (ownerId !== null && owner === undefined) {
    return refuse("not_found", `No member ${ownerId} on this run.`);
  }
  if (owner?.kind === "review" || owner?.kind === "validate") {
    return refuse(
      "self_approval",
      "Review and validate members judge work. Give this task to a build member or keep it yourself.",
    );
  }
  const previous = existing?.builtBy ?? [];
  const builtBy =
    owner?.kind === "build" && !previous.includes(owner.id) ? [...previous, owner.id] : previous;
  const blocker = action.blocker ?? existing?.blocker;
  const task: TeamTask = {
    id: action.taskId,
    objective: action.objective ?? existing?.objective ?? "",
    ownerId,
    scope: action.scope ?? existing?.scope ?? "",
    dependencies: action.dependencies ?? existing?.dependencies ?? [],
    acceptanceCriteria: action.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [],
    deliverable: action.deliverable ?? existing?.deliverable ?? "",
    version: existing?.version ?? 0,
    status: existing === undefined ? "queued" : (action.status ?? existing.status),
    ...(blocker === undefined ? {} : { blocker }),
    builtBy,
    corrections: existing?.corrections ?? 0,
    findings: existing?.findings ?? [],
  };
  return ok(existing === undefined ? { ...run, tasks: [...run.tasks, task] } : withTask(run, task));
};

const advance = (run: TeamRun, action: Action<"advance">): TeamTransition => {
  if (memberOf(run, action.byId)?.kind !== "lead") {
    return refuse("not_lead", "Only the lead moves a run on.");
  }
  if (run.status === "awaiting_owner" || run.status === "blocked" || run.status === "over_budget") {
    return refuse("wrong_phase", run.waitingFor ?? "The run is parked until its owner acts.");
  }
  const from = run.activeNodeId ?? leadNodeId(run);
  if (!reachable(run, from, "handoff").includes(action.toNodeId)) {
    return refuse("wrong_phase", "The flow has no handoff from here to that node.");
  }
  return ok({ ...run, activeNodeId: action.toNodeId });
};

const handoff = (run: TeamRun, action: Action<"handoff">, at: string): TeamTransition => {
  const task = taskOf(run, action.taskId);
  if (task === undefined) return refuse("not_found", "No such task.");
  const actor = memberOf(run, action.fromId);
  if (actor === undefined) return refuse("not_a_member", "Only a team member may hand work off.");
  if (task.status === "done") return refuse("wrong_phase", "A finished task takes no handoff.");
  if (actor.kind !== "build" && task.ownerId !== actor.id) {
    return refuse("not_a_member", "Only a build member or the task's owner hands work off.");
  }
  const version = task.version + 1;
  const entry: TeamHandoff = {
    taskId: task.id,
    fromId: actor.id,
    version,
    changed: action.changed,
    where: action.where,
    requirements: action.requirements,
    checked: action.checked,
    uncertain: action.uncertain,
    at,
  };
  const updated: TeamTask = {
    ...task,
    version,
    status: "reviewing",
    builtBy: task.builtBy.includes(actor.id) ? task.builtBy : [...task.builtBy, actor.id],
  };
  return ok({
    ...withTask(run, updated),
    handoffs: [...run.handoffs, entry],
    activeNodeId: reachable(run, actor.nodeId, "handoff")[0] ?? run.activeNodeId,
  });
};

const verdict = (run: TeamRun, action: Action<"verdict">, at: string): TeamTransition => {
  const task = taskOf(run, action.taskId);
  if (task === undefined) return refuse("not_found", "No such task.");
  const judge = memberOf(run, action.byId);
  if (judge === undefined || (judge.kind !== "review" && judge.kind !== "validate")) {
    return refuse("wrong_phase", "Only a review or validate member gives a verdict.");
  }
  if (task.builtBy.includes(judge.id)) {
    return refuse("self_approval", "A member who built part of this cannot judge it.");
  }
  if (action.version !== task.version) {
    return refuse("wrong_phase", `The candidate changed; it is now version ${task.version}.`);
  }
  const outcomes = judge.kind === "review" ? REVIEW_OUTCOMES : VALIDATE_OUTCOMES;
  if (!outcomes.includes(action.outcome)) {
    return refuse("wrong_phase", `A ${judge.kind} member cannot give a ${action.outcome} verdict.`);
  }
  const waiting =
    judge.kind === "review"
      ? task.status === "reviewing"
      : task.status === "reviewing" || task.status === "validating";
  if (!waiting) return refuse("wrong_phase", "The task is not waiting for this verdict.");

  const added: TeamFinding[] = (action.findings ?? []).map((finding, index) => ({
    ...finding,
    id: TeamFindingId.make(`${task.id}-f${task.findings.length + index + 1}`),
    status: "open",
  }));
  const findings = [...task.findings, ...added];
  const openBlocking = findings.some(
    (finding) => finding.severity === "blocking" && finding.status === "open",
  );
  const record: TeamVerdict = {
    taskId: task.id,
    nodeId: judge.nodeId,
    byId: judge.id,
    version: task.version,
    outcome: action.outcome,
    limitations: action.limitations,
    criteria: action.criteria ?? [],
    at,
  };
  const recorded: TeamRun = { ...run, verdicts: [...run.verdicts, record] };
  const settle = (updated: TeamTask, patch: Partial<TeamRun>): TeamTransition =>
    ok({ ...withTask(recorded, updated), ...patch });

  if (action.outcome === "blocked") {
    return settle(
      { ...task, findings, status: "blocked", blocker: action.limitations },
      { activeNodeId: leadNodeId(run) },
    );
  }

  if (action.outcome === "pass" && judge.kind === "review") {
    if (openBlocking) return refuse("failed_checks", "A blocking finding is still open.");
    const validateNode = reachable(run, judge.nodeId, "handoff").find(
      (nodeId) => kindOf(run, nodeId) === "validate",
    );
    return settle(
      { ...task, findings, status: validateNode === undefined ? "done" : "validating" },
      { activeNodeId: validateNode ?? leadNodeId(run) },
    );
  }

  if (action.outcome === "pass") {
    const hasReview = run.flow.nodes.some((node) => node.kind === "review");
    const reviewPassed = run.verdicts.some(
      (candidate) =>
        candidate.taskId === task.id &&
        candidate.version === task.version &&
        candidate.outcome === "pass" &&
        kindOf(run, candidate.nodeId) === "review",
    );
    if (hasReview && !reviewPassed) {
      return refuse("needs_verdict", "A review must pass this version first.");
    }
    const criteria = action.criteria ?? [];
    const uncovered = task.acceptanceCriteria.filter(
      (text) => !criteria.some((result) => result.criterion === text && result.result === "pass"),
    );
    if (uncovered.length > 0) {
      return refuse("needs_evidence", `No passing result for: ${uncovered.join("; ")}`);
    }
    if (openBlocking) return refuse("failed_checks", "A blocking finding is still open.");
    const latest = new Map(
      run.evidence
        .filter((entry) => entry.taskId === task.id)
        .map((entry) => [entry.command, entry.passed]),
    );
    if (![...latest.values()].some(Boolean)) {
      return refuse("needs_evidence", "Record a passing check for this task first.");
    }
    const failing = [...latest].find(([, passed]) => !passed);
    if (failing !== undefined) {
      return refuse("failed_checks", `The latest run of ${failing[0]} failed.`);
    }
    return settle({ ...task, findings, status: "done" }, { activeNodeId: leadNodeId(run) });
  }

  const corrections = task.corrections + 1;
  const cycles = run.correctionCycles + 1;
  const overBudget = cycles > run.budget.maxCorrectionCycles;
  const notes =
    corrections === 2
      ? [
          ...run.notes,
          {
            kind: "decision" as const,
            byId: TEAM_LEAD_MEMBER_ID,
            text: `Task ${task.id} needed two corrections: the lead must reassess approach, breakdown, or staffing.`,
            at,
          },
        ]
      : run.notes;
  return settle(
    { ...task, findings, status: "building", corrections },
    {
      correctionCycles: cycles,
      notes,
      activeNodeId: reachable(run, judge.nodeId, "return")[0] ?? leadNodeId(run),
      ...(overBudget
        ? {
            status: "blocked" as const,
            waitingFor: `The run used its ${run.budget.maxCorrectionCycles} correction cycles. Decide whether to change the plan, staff differently, or stop.`,
          }
        : {}),
    },
  );
};

const report = (run: TeamRun, action: Action<"report">): TeamTransition => {
  if (memberOf(run, action.byId)?.kind !== "lead") {
    return refuse("not_lead", "The lead writes the report.");
  }
  if (run.tasks.some((task) => task.status !== "done")) {
    return refuse("wrong_phase", "Every task must be done before the report.");
  }
  if (
    run.tasks.some((task) =>
      task.findings.some((finding) => finding.severity === "blocking" && finding.status === "open"),
    )
  ) {
    return refuse("failed_checks", "A blocking finding is still open.");
  }
  // A failed check stays visible: it must appear unless a later run of it passed.
  const unresolved = [
    ...new Map(
      run.evidence.map((entry) => [JSON.stringify([entry.taskId ?? null, entry.command]), entry]),
    ).values(),
  ].filter((entry) => !entry.passed);
  const named = action.report.notVerified.join("\n");
  const hidden = unresolved.filter((entry) => !named.includes(entry.command));
  if (hidden.length > 0) {
    return refuse("failed_checks", `The report must name ${hidden[0]?.command}.`);
  }
  return ok({
    ...run,
    report: action.report,
    status: "done",
    waitingFor: null,
    activeNodeId: null,
  });
};

const awaitingOwnerWait = (request: TeamGrowthRequest) =>
  `Answer the growth request for ${request.capacity}.`;

const answerGrowth = (
  run: TeamRun,
  action: Action<"owner_growth_answer">,
  at: string,
): TeamTransition => {
  const request = run.growth.find((candidate) => candidate.id === action.requestId);
  if (request === undefined || request.status !== "awaiting_owner") {
    return refuse("growth_refused", "No growth request is waiting for the owner.");
  }
  const decided: TeamGrowthRequest = action.allow
    ? { ...request, status: "owner_allowed" }
    : {
        ...request,
        status: "denied",
        decidedBy: "owner",
        reason: action.note ?? "The owner declined this growth request.",
        decidedAt: at,
      };
  const growth = run.growth.map((candidate) => (candidate.id === decided.id ? decided : candidate));
  const stillAwaiting = growth.find((candidate) => candidate.status === "awaiting_owner");
  if (run.status !== "awaiting_owner") return ok({ ...run, growth });
  return ok({
    ...run,
    growth,
    status: stillAwaiting === undefined ? "running" : "awaiting_owner",
    waitingFor: stillAwaiting === undefined ? null : awaitingOwnerWait(stillAwaiting),
  });
};

/** The member an action speaks for. Owner actions speak for no member. */
const actorOf = (action: TeamAction): TeamMemberId | null => {
  switch (action.type) {
    case "handoff":
      return action.fromId;
    case "owner_stop":
    case "owner_resume":
    case "owner_growth_answer":
      return null;
    default:
      return action.byId;
  }
};

/** Every rule of a run, with no I/O, so each is tested directly. */
export const applyTeamAction = (run: TeamRun, action: TeamAction, at: string): TeamTransition => {
  if (CLOSED.has(run.status)) return refuse("run_closed", "This run has ended.");
  const actorId = actorOf(action);
  if (actorId !== null && memberOf(run, actorId) === undefined) {
    return refuse("not_a_member", "Only a team member may update this board.");
  }
  const applied = (): TeamTransition => {
    switch (action.type) {
      case "owner_resume": {
        if (run.status !== "over_budget" && run.status !== "blocked") {
          return refuse("wrong_phase", "Only a run over budget or blocked can be resumed.");
        }
        const awaiting = run.growth.find((request) => request.status === "awaiting_owner");
        const resumed: TeamRun = {
          ...run,
          budget: action.budget,
          status: awaiting === undefined ? "running" : "awaiting_owner",
          waitingFor: awaiting === undefined ? null : awaitingOwnerWait(awaiting),
          correctionCycles: run.status === "blocked" ? 0 : run.correctionCycles,
        };
        return enforceTeamBudget(resumed, Date.parse(at)) === null
          ? ok(resumed)
          : refuse("budget", "The budget is still exhausted; raise it before resuming.");
      }
      case "owner_stop":
        return ok({ ...run, status: "stopped", waitingFor: action.reason });
      case "owner_growth_answer":
        return answerGrowth(run, action, at);
      case "advance":
        return advance(run, action);
      case "verdict":
        return verdict(run, action, at);
      case "task_upsert":
        return upsertTask(run, action);
      case "finding_update": {
        if (memberOf(run, action.byId)?.kind !== "lead") {
          return refuse("not_lead", "Only the lead updates findings.");
        }
        const task = taskOf(run, action.taskId);
        if (
          task === undefined ||
          !task.findings.some((finding) => finding.id === action.findingId)
        ) {
          return refuse("not_found", "No such finding.");
        }
        return ok(
          withTask(run, {
            ...task,
            findings: task.findings.map((finding) =>
              finding.id === action.findingId ? { ...finding, status: action.status } : finding,
            ),
          }),
        );
      }
      case "note":
        return ok({
          ...run,
          notes: [...run.notes, { kind: action.kind, byId: action.byId, text: action.text, at }],
        });
      case "handoff":
        return handoff(run, action, at);
      case "evidence":
        return ok({
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
        });
      case "report":
        return report(run, action);
    }
  };
  const result = applied();
  return result.ok ? { ok: true, run: { ...result.run, updatedAt: at } } : result;
};

export const enforceTeamBudget = (run: TeamRun, nowMs: number): TeamRun | null => {
  if (run.status !== "running" && run.status !== "awaiting_owner") return null;
  const limit = run.budget.maxCostUsd;
  const reason =
    nowMs - Date.parse(run.startedAt) > run.budget.maxMinutes * 60_000
      ? `The run passed its ${run.budget.maxMinutes} minute budget.`
      : limit !== undefined && run.costUsd === null
        ? "The cost of this run cannot be priced; review its budget before continuing."
        : limit !== undefined && (run.costUsd ?? 0) >= limit
          ? `The run reached its $${limit} cost budget.`
          : null;
  return reason === null ? null : { ...run, status: "over_budget", waitingFor: reason };
};
