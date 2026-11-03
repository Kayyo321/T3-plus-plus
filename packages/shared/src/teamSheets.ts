import {
  DEFAULT_TEAM_SHEET_ID,
  TEAM_LEAD_MEMBER_ID,
  TEAM_SESSION_SLOT,
  TEAM_SHEET_MAX_EDGES,
  TEAM_SHEET_MAX_NODES,
  TeamMemberId,
  TeamNodeId,
  type TeamSheet,
  type TeamSheetChange,
  type TeamSheetEdge,
  type TeamSheetNode,
} from "@t3tools/contracts";

const LEAD_ID = TeamNodeId.make("lead");
const BUILD_ID = TeamNodeId.make("build");
const REVIEW_ID = TeamNodeId.make("review");
const VALIDATE_ID = TeamNodeId.make("validate");

const LEAD_INSTRUCTIONS = `Own the overall result. Turn the request into an objective and acceptance criteria. Break the work into tasks with explicit owners and dependencies. Decide which agents to use, how much reasoning each task needs, and what runs in parallel. Give each team the context, constraints, and artifacts it needs. Resolve disagreements with evidence. Make sure parallel changes are integrated before review and validation. Report progress and make the final completion decision. You stay responsible for the whole project even when tasks are delegated.`;

const BUILD_INSTRUCTIONS = `Members: workers, plus researchers or specialists when the lead wants them. Implement assigned tasks within scope. Coordinate dependencies and shared interfaces. Run relevant checks before handing over. Explain material decisions and unresolved questions. Fix issues returned by Review or Validate. Every task has one accountable owner; the lead assigns someone to assemble parallel contributions into one candidate result.

Required handoff: what changed, where to find it, which requirements it addresses, what was checked, and what remains uncertain.`;

const REVIEW_INSTRUCTIONS = `Members: independent reviewers, plus focused specialists as needed. Review the Build team's work directly. Check correctness and coverage of the requested behavior; regressions, unnecessary complexity, and relevant security concerns; how parallel contributions fit together; and whether the tests meaningfully cover the change.

Return one consolidated set of findings. Each finding states the problem, its impact, supporting evidence, and what must be true for it to be resolved. Blocking findings must be resolved before the work can pass. Suggestions may be accepted, deferred, or declined by the lead. Return corrections to the responsible worker. If a reviewer is reassigned to fix something, another agent reviews that change.

Required handoff: PASS or CHANGES REQUIRED, with findings and any review limitations. Review asks: does this implementation appear correct and complete?`;

const VALIDATE_INSTRUCTIONS = `Members: validators who verify the result independently. Check the completed work against the original acceptance criteria and confirm blocking findings were resolved. Check the integrated result, including interactions between contributions. Run tests, exercise workflows, or reproduce expected behavior. Record observed results and what could not be verified. Validation must refer to the same candidate version that was reviewed; later changes re-run the affected review and validation.

Required handoff: PASS, FAIL, or BLOCKED, with evidence for each acceptance criterion. Validation asks: what evidence shows that the finished result meets the requirements?`;

const TEAM_OPERATING_RULES = `- One owner per task, responsible for its implementation, handoff, and corrections.
- Parallel work has explicit boundaries: split by component or isolated change, agree shared interfaces before dependent work starts, and give each shared file one owner.
- Workers check their own work first. Downstream approval comes from an agent that did not author the change. For a small task, one independent agent may do review and validation if it reports both.
- Failures return to their owner. Then the affected checks repeat, plus any integration checks the correction could break.
- After two unsuccessful correction cycles on the same issue, the lead reassesses approach, breakdown, or staffing.
- Completion requires: required acceptance criteria pass, blocking findings are resolved, validation covers the integrated result, and limitations are disclosed. A required check that could not run stays blocked or unverified, never passed.`;

/** The built-in sheet: code, read-only, and the start of every new sheet. */
export const DEFAULT_TEAM_SHEET: TeamSheet = {
  id: DEFAULT_TEAM_SHEET_ID,
  name: "Default teamwork",
  revision: 0,
  builtIn: true,
  nestedSessions: true,
  updatedAt: "2026-11-02T00:00:00.000Z",
  nodes: [
    {
      id: LEAD_ID,
      kind: "lead",
      name: "Project Lead",
      instructions: LEAD_INSTRUCTIONS,
      position: { x: 40, y: 24 },
      growth: { mode: "off", scope: "session" },
    },
    {
      id: BUILD_ID,
      kind: "build",
      name: "Build",
      instructions: BUILD_INSTRUCTIONS,
      position: { x: 40, y: 144 },
      modelChoice: { type: "lead" },
    },
    {
      id: REVIEW_ID,
      kind: "review",
      name: "Review",
      instructions: REVIEW_INSTRUCTIONS,
      position: { x: 40, y: 264 },
      modelChoice: { type: "lead" },
    },
    {
      id: VALIDATE_ID,
      kind: "validate",
      name: "Validate",
      instructions: VALIDATE_INSTRUCTIONS,
      position: { x: 40, y: 384 },
      modelChoice: { type: "lead" },
    },
  ],
  edges: [
    { from: LEAD_ID, to: BUILD_ID, kind: "handoff" },
    { from: BUILD_ID, to: REVIEW_ID, kind: "handoff" },
    { from: REVIEW_ID, to: VALIDATE_ID, kind: "handoff" },
    { from: VALIDATE_ID, to: LEAD_ID, kind: "handoff" },
    { from: REVIEW_ID, to: BUILD_ID, kind: "return" },
    { from: VALIDATE_ID, to: BUILD_ID, kind: "return" },
  ],
};

export const leadNodeOf = (sheet: Pick<TeamSheet, "nodes">) => {
  const lead = sheet.nodes.find((node) => node.kind === "lead");
  return lead?.kind === "lead" ? lead : undefined;
};

const sameEdge = (left: TeamSheetEdge, right: TeamSheetEdge) =>
  left.from === right.from && left.to === right.to && left.kind === right.kind;

const reachableFrom = (
  start: TeamSheetNode["id"],
  edges: ReadonlyArray<TeamSheetEdge>,
  through: (edge: TeamSheetEdge) => boolean = () => true,
) => {
  const seen = new Set([start]);
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const edge of edges) {
      if (edge.from !== current || !through(edge) || seen.has(edge.to)) continue;
      seen.add(edge.to);
      pending.push(edge.to);
    }
  }
  return seen;
};

/** A forward path out of the lead and back to it, past a team that did not build the work. */
const hasAcceptancePath = (sheet: Pick<TeamSheet, "nodes" | "edges">, leadId: TeamNodeId) => {
  const forward = (edge: TeamSheetEdge) => edge.kind === "handoff" && edge.to !== leadId;
  const reached = reachableFrom(leadId, sheet.edges, forward);
  const checkers = sheet.nodes.filter(
    (node) => (node.kind === "review" || node.kind === "validate") && reached.has(node.id),
  );
  return checkers.some((checker) => {
    const after = reachableFrom(checker.id, sheet.edges, (edge) => edge.kind === "handoff");
    return sheet.edges.some(
      (edge) => edge.kind === "handoff" && edge.to === leadId && after.has(edge.from),
    );
  });
};

export interface TeamSheetValidationOptions {
  /** Provider instances this environment has. Omit where they are not known. */
  readonly instanceIds?: ReadonlySet<string>;
}

/** Plain sentences for a person or an agent; empty means the sheet can be saved. */
export function teamSheetProblems(
  sheet: Pick<TeamSheet, "nodes" | "edges">,
  options: TeamSheetValidationOptions = {},
): ReadonlyArray<string> {
  const leads = sheet.nodes.filter((node) => node.kind === "lead");
  if (leads.length === 0) return ["This sheet has no Project Lead."];
  if (leads.length > 1) return ["This sheet has more than one Project Lead."];
  const problems: Array<string> = [];
  if (sheet.nodes.length > TEAM_SHEET_MAX_NODES)
    problems.push(`A sheet has room for ${TEAM_SHEET_MAX_NODES} teams at most.`);
  if (sheet.edges.length > TEAM_SHEET_MAX_EDGES)
    problems.push(`A sheet has room for ${TEAM_SHEET_MAX_EDGES} lines at most.`);
  const ids = new Set(sheet.nodes.map((node) => node.id));
  if (ids.size !== sheet.nodes.length) problems.push("Two nodes share an id.");
  const names = new Set(sheet.nodes.map((node) => node.name.toLocaleLowerCase()));
  if (names.size !== sheet.nodes.length) problems.push("Two nodes share a name.");
  const edges = sheet.edges.filter((edge) => {
    const known = ids.has(edge.from) && ids.has(edge.to);
    if (!known) problems.push("A line connects a node that is no longer on the sheet.");
    else if (edge.from === edge.to) problems.push("A line connects a node to itself.");
    return known;
  });
  const leadId = leads[0]!.id;
  const reachable = reachableFrom(leadId, edges);
  for (const node of sheet.nodes) {
    if (!reachable.has(node.id)) problems.push(`The Project Lead cannot reach ${node.name}.`);
    if (node.kind === "lead" || node.modelChoice.type === "lead") continue;
    if (
      options.instanceIds !== undefined &&
      !options.instanceIds.has(node.modelChoice.instanceId)
    ) {
      problems.push(`${node.name} uses a provider this environment does not have.`);
    }
  }
  if (!hasAcceptancePath({ nodes: sheet.nodes, edges }, leadId)) {
    problems.push("Work needs a path from the Project Lead, past a check, back to the lead.");
  }
  return problems;
}

const applyChange = (sheet: TeamSheet, change: TeamSheetChange): TeamSheet => {
  const updateNode = (id: TeamNodeId, update: (node: TeamSheetNode) => TeamSheetNode) => ({
    ...sheet,
    nodes: sheet.nodes.map((node) => (node.id === id ? update(node) : node)),
  });
  switch (change.type) {
    case "rename":
      return { ...sheet, name: change.name };
    case "set_nested_sessions":
      return { ...sheet, nestedSessions: change.enabled };
    case "add_node":
      return sheet.nodes.some((node) => node.id === change.node.id)
        ? sheet
        : { ...sheet, nodes: [...sheet.nodes, change.node] };
    case "update_node":
      return updateNode(change.nodeId, (node) => {
        const common = {
          ...(change.name === undefined ? {} : { name: change.name }),
          ...(change.instructions === undefined ? {} : { instructions: change.instructions }),
          ...(change.position === undefined ? {} : { position: change.position }),
        };
        return node.kind === "lead"
          ? {
              ...node,
              ...common,
              ...(change.growth === undefined ? {} : { growth: change.growth }),
            }
          : {
              ...node,
              ...common,
              ...(change.work === undefined ? {} : { kind: change.work }),
              ...(change.modelChoice === undefined ? {} : { modelChoice: change.modelChoice }),
            };
      });
    case "remove_node":
      return {
        ...sheet,
        nodes: sheet.nodes.filter((node) => node.id !== change.nodeId),
        edges: sheet.edges.filter(
          (edge) => edge.from !== change.nodeId && edge.to !== change.nodeId,
        ),
      };
    case "connect":
      return sheet.edges.some((edge) => sameEdge(edge, change.edge))
        ? sheet
        : { ...sheet, edges: [...sheet.edges, change.edge] };
    case "disconnect":
      return { ...sheet, edges: sheet.edges.filter((edge) => !sameEdge(edge, change.edge)) };
  }
};

/** The editor and the server both run this, so a draft shows what saving it will store. */
export const applyTeamSheetChanges = (
  sheet: TeamSheet,
  changes: ReadonlyArray<TeamSheetChange>,
): TeamSheet => changes.reduce(applyChange, sheet);

export const teamMemberId = (nodeId: TeamNodeId, slot: string) =>
  TeamMemberId.make(`${nodeId}/${slot}`);

export const isTeamLead = (memberId: TeamMemberId) => memberId === TEAM_LEAD_MEMBER_ID;

export const teamMemberName = (nodeName: string, slot: string) =>
  slot === TEAM_SESSION_SLOT ? nodeName : `${nodeName} ${slot}`;

/** Every sheet's lead works under the same rules, whatever its node says. */
export const teamLeadInstructions = (sheet: Pick<TeamSheet, "nodes">) =>
  [leadNodeOf(sheet)?.instructions ?? "", `Operating rules:\n${TEAM_OPERATING_RULES}`]
    .filter((part) => part !== "")
    .join("\n\n");
