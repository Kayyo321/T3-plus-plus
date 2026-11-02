import {
  NESTED_SESSION_CONTEXT_SEED_MAX_CHARS,
  TEAM_LEAD_MEMBER_ID,
  TEAM_SESSION_SLOT,
  type TeamGrowthRequest,
  type TeamMember,
  type TeamRosterSlot,
  type TeamRun,
  type TeamSheetNode,
  type TeamWorkNode,
} from "@t3tools/contracts";
import { teamLeadInstructions, teamMemberName } from "@t3tools/shared/teamSheets";

const modelRule = (node: TeamWorkNode) => {
  switch (node.modelChoice.type) {
    case "lead":
      return "you choose any provider and model";
    case "provider":
      return `you choose a model of provider instance ${node.modelChoice.instanceId}`;
    case "pinned":
      return `pinned to ${node.modelChoice.instanceId} ${node.modelChoice.model}; you choose effort only`;
  }
};

const flowLines = (run: TeamRun) => {
  const nameOf = (id: TeamSheetNode["id"]) =>
    run.flow.nodes.find((node) => node.id === id)?.name ?? id;
  return run.flow.nodes.flatMap((node) => {
    if (node.kind === "lead") return [];
    const edges = run.flow.edges.filter((edge) => edge.from === node.id);
    const next = edges.filter((edge) => edge.kind === "handoff").map((edge) => nameOf(edge.to));
    const back = edges.filter((edge) => edge.kind === "return").map((edge) => nameOf(edge.to));
    return [
      `- ${node.name} (node ${node.id}, ${node.kind}): ${modelRule(node)}.${
        next.length === 0 ? "" : ` A pass goes to ${next.join(", ")}.`
      }${back.length === 0 ? "" : ` Corrections go to ${back.join(", ")}.`}`,
    ];
  });
};

const rosterLines = (run: TeamRun, roster: ReadonlyArray<TeamRosterSlot>) => {
  if (roster.length === 0) return ["This run creates the roster. You decide each team's size."];
  return [
    "Sessions already on this thread's roster. Invoke these; never ask for new ones:",
    ...roster.map((slot) => {
      const node = run.flow.nodes.find((candidate) => candidate.id === slot.nodeId);
      const name = teamMemberName(node?.name ?? slot.nodeId, slot.slot);
      const where = node === undefined ? " (its node left the sheet; leave it uninvoked)" : "";
      return `- ${name}: node ${slot.nodeId}, slot ${slot.slot}, ${slot.status}${where}`;
    }),
  ];
};

/** Reaches the provider with the turn's prompt and never shows in the transcript. */
export const leadBrief = (run: TeamRun, roster: ReadonlyArray<TeamRosterSlot>) =>
  [
    `You are the Project Lead of teamwork run ${run.id} on the sheet "${run.flow.sheetName}". The user's message below is its request. You are member \`${TEAM_LEAD_MEMBER_ID}\`.`,
    teamLeadInstructions(run.flow),
    ["Teams:", ...flowLines(run)].join("\n"),
    rosterLines(run, roster).join("\n"),
    `Running it:
- Record the objective and tasks first with \`t3_team_act\` (task_upsert): owner, scope, dependencies, acceptance criteria.
- \`t3_team_start_member\` reaches a team (omit \`slot\`) or a member (\`slot\` such as m1). A bound slot gets a new turn in its existing session. An empty slot starts one only while this run is the first to use that node. Pick effort and model with \`modelSelection\`, within the rule above.
- Use \`t3_thread_wait\` and \`t3_thread_read\` to follow sessions. Summary cards are not the record: handoffs, evidence, and verdicts in \`t3_team_act\` are.
- Move the run with \`t3_team_act\` (advance). Finish with \`t3_team_act\` (report), once every task is done.
- A growth request arrives as a message. Decide it with \`t3_team_growth_decide\`, with a reason. Deny it when existing members can cover the work.`,
  ].join("\n\n");

export const ownerNoteBrief = (run: TeamRun) =>
  `The message below is an owner note for teamwork run ${run.id}, which is still active. You are its Project Lead: act on it within this run, and do not start another one.`;

export const memberSeed = (run: TeamRun, node: TeamWorkNode, member: TeamMember) =>
  [
    `You are ${member.name} in teamwork run ${run.id}, on the sheet "${run.flow.sheetName}". Your member id is \`${member.id}\`, and your work kind is ${node.kind}.`,
    node.instructions,
    run.request.length === 0 ? "" : `The request: ${run.request}`,
    taskLines(run, member),
    node.kind === "build"
      ? "You have your own worktree. Keep your work there between rounds."
      : "Read the candidate named in the handoff. Do not edit it.",
    `Use \`t3_team_list\` to read the board and \`t3_team_act\` as yourself to record tasks, handoffs, evidence, and verdicts. Leave summary cards with \`report_to_parent\`. If the team lacks a capacity, ask the lead with \`t3_team_growth_request\` and say what you already tried.`,
  ]
    .filter((part) => part !== "")
    .join("\n\n")
    .slice(0, NESTED_SESSION_CONTEXT_SEED_MAX_CHARS - 500);

const taskLines = (run: TeamRun, member: TeamMember) => {
  const tasks = run.tasks.filter(
    (task) => task.ownerId === member.id || member.slot === TEAM_SESSION_SLOT,
  );
  if (tasks.length === 0) return "";
  return [
    "Tasks:",
    ...tasks.map(
      (task) =>
        `- ${task.id} (${task.status}, version ${task.version}): ${task.objective}. Acceptance: ${
          task.acceptanceCriteria.join("; ") || "not set"
        }`,
    ),
  ].join("\n");
};

/** A bound session already has its history, so this is the new request and the board's state. */
export const memberTurn = (run: TeamRun, member: TeamMember, message: string) =>
  [
    `Teamwork run ${run.id}. Request: ${run.request}`,
    taskLines(run, member),
    `You are \`${member.id}\`.`,
    message,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

export const growthRequestForLead = (run: TeamRun, request: TeamGrowthRequest) =>
  `Growth request ${request.id} on run ${run.id} from ${request.fromId}: needs ${request.capacity}.\nWhy the current members cannot cover it: ${request.why}\nAlready tried: ${request.tried}\nDecide it with \`t3_team_growth_decide\`, accepting only if existing members cannot cover it.`;

export const growthAwaitsOwner = (run: TeamRun, request: TeamGrowthRequest) =>
  `Growth request ${request.id} on run ${run.id} from ${request.fromId} needs the owner first: ${request.capacity}. Tell the owner it is waiting on the run board. Do not decide it until they answer.`;

export const growthOwnerAnswer = (run: TeamRun, request: TeamGrowthRequest) =>
  request.status === "denied"
    ? `The owner denied growth request ${request.id} on run ${run.id}: ${request.reason ?? "no reason given"}. It is closed.`
    : `The owner allowed growth request ${request.id} on run ${run.id}. Decide it with \`t3_team_growth_decide\`.`;

export const growthDenied = (request: TeamGrowthRequest) =>
  `Your growth request (${request.capacity}) was denied: ${request.reason ?? "no reason given"}. Solve this with the members you have. Do not file it again this round.`;
