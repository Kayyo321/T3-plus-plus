import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const TeamRunId = TrimmedNonEmptyString.pipe(Schema.brand("TeamRunId"));
export type TeamRunId = typeof TeamRunId.Type;
export const TeamTaskId = TrimmedNonEmptyString.pipe(Schema.brand("TeamTaskId"));
export type TeamTaskId = typeof TeamTaskId.Type;
export const TeamMemberId = TrimmedNonEmptyString.pipe(Schema.brand("TeamMemberId"));
export type TeamMemberId = typeof TeamMemberId.Type;
export const TeamSheetId = TrimmedNonEmptyString.pipe(Schema.brand("TeamSheetId"));
export type TeamSheetId = typeof TeamSheetId.Type;
/** Stable across renames and edits: session bindings depend on it. */
export const TeamNodeId = TrimmedNonEmptyString.pipe(Schema.brand("TeamNodeId"));
export type TeamNodeId = typeof TeamNodeId.Type;
export const TeamFindingId = TrimmedNonEmptyString.pipe(Schema.brand("TeamFindingId"));
export type TeamFindingId = typeof TeamFindingId.Type;
export const TeamGrowthRequestId = TrimmedNonEmptyString.pipe(Schema.brand("TeamGrowthRequestId"));
export type TeamGrowthRequestId = typeof TeamGrowthRequestId.Type;

export const DEFAULT_TEAM_SHEET_ID = TeamSheetId.make("default");
/** The session of a team itself, as opposed to one of its members. */
export const TEAM_SESSION_SLOT = "team";
export const TEAM_LEAD_MEMBER_ID = TeamMemberId.make("lead");

const SheetName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
const Instructions = Schema.String.check(Schema.isMaxLength(8_000));
export const TEAM_SHEET_MAX_NODES = 32;
export const TEAM_SHEET_MAX_EDGES = 128;

export const TeamWorkKind = Schema.Literals(["build", "review", "validate"]);
export type TeamWorkKind = typeof TeamWorkKind.Type;

/** How far the lead may choose a team's model. Effort and team size stay the lead's in all three. */
export const TeamModelChoice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("lead") }),
  Schema.Struct({ type: Schema.Literal("provider"), instanceId: ProviderInstanceId }),
  Schema.Struct({
    type: Schema.Literal("pinned"),
    instanceId: ProviderInstanceId,
    model: TrimmedNonEmptyString,
  }),
]);
export type TeamModelChoice = typeof TeamModelChoice.Type;

export const TeamGrowthMode = Schema.Literals(["off", "on", "ask"]);
export type TeamGrowthMode = typeof TeamGrowthMode.Type;
export const TeamGrowthScope = Schema.Literals(["session", "sheet"]);
export type TeamGrowthScope = typeof TeamGrowthScope.Type;
export const TeamGrowth = Schema.Struct({ mode: TeamGrowthMode, scope: TeamGrowthScope });
export type TeamGrowth = typeof TeamGrowth.Type;

export const TeamNodePosition = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export type TeamNodePosition = typeof TeamNodePosition.Type;

const nodeFields = {
  id: TeamNodeId,
  name: SheetName,
  instructions: Instructions,
  position: TeamNodePosition,
};

/** Has no model of its own: the lead runs on the thread the run starts in. */
export const TeamLeadNode = Schema.Struct({
  ...nodeFields,
  kind: Schema.Literal("lead"),
  growth: TeamGrowth,
});
export type TeamLeadNode = typeof TeamLeadNode.Type;

export const TeamWorkNode = Schema.Struct({
  ...nodeFields,
  kind: TeamWorkKind,
  modelChoice: TeamModelChoice,
});
export type TeamWorkNode = typeof TeamWorkNode.Type;

export const TeamSheetNode = Schema.Union([TeamLeadNode, TeamWorkNode]);
export type TeamSheetNode = typeof TeamSheetNode.Type;

/** `handoff` moves work forward on a pass; `return` sends it back for correction. */
export const TeamEdgeKind = Schema.Literals(["handoff", "return"]);
export type TeamEdgeKind = typeof TeamEdgeKind.Type;

export const TeamSheetEdge = Schema.Struct({
  from: TeamNodeId,
  to: TeamNodeId,
  kind: TeamEdgeKind,
});
export type TeamSheetEdge = typeof TeamSheetEdge.Type;

export const TeamSheet = Schema.Struct({
  id: TeamSheetId,
  name: SheetName,
  revision: NonNegativeInt,
  builtIn: Schema.Boolean,
  nestedSessions: Schema.Boolean,
  nodes: Schema.Array(TeamSheetNode).check(Schema.isMaxLength(TEAM_SHEET_MAX_NODES)),
  edges: Schema.Array(TeamSheetEdge).check(Schema.isMaxLength(TEAM_SHEET_MAX_EDGES)),
  updatedAt: IsoDateTime,
});
export type TeamSheet = typeof TeamSheet.Type;

/** One edit. Dragging a card sends one of these, never the sheet. */
export const TeamSheetChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("rename"), name: SheetName }),
  Schema.Struct({ type: Schema.Literal("set_nested_sessions"), enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("add_node"), node: TeamWorkNode }),
  Schema.Struct({
    type: Schema.Literal("update_node"),
    nodeId: TeamNodeId,
    name: Schema.optional(SheetName),
    instructions: Schema.optional(Instructions),
    position: Schema.optional(TeamNodePosition),
    modelChoice: Schema.optional(TeamModelChoice),
    work: Schema.optional(TeamWorkKind),
    growth: Schema.optional(TeamGrowth),
  }),
  Schema.Struct({ type: Schema.Literal("remove_node"), nodeId: TeamNodeId }),
  Schema.Struct({ type: Schema.Literal("connect"), edge: TeamSheetEdge }),
  Schema.Struct({ type: Schema.Literal("disconnect"), edge: TeamSheetEdge }),
]);
export type TeamSheetChange = typeof TeamSheetChange.Type;

export const TeamSheetDesign = Schema.Struct({
  nodes: TeamSheet.fields.nodes,
  edges: TeamSheet.fields.edges,
  nestedSessions: Schema.optional(Schema.Boolean),
});
export type TeamSheetDesign = typeof TeamSheetDesign.Type;

export const TeamSheetListResult = Schema.Struct({ sheets: ForwardCompatibleArray(TeamSheet) });
export type TeamSheetListResult = typeof TeamSheetListResult.Type;

export const TeamSheetGetInput = Schema.Struct({ sheetId: TeamSheetId });
export type TeamSheetGetInput = typeof TeamSheetGetInput.Type;

export const TeamSheetCreateInput = Schema.Struct({
  name: SheetName,
  /** A whole design. Without one the sheet starts as a copy of the default. */
  design: Schema.optional(TeamSheetDesign),
});
export type TeamSheetCreateInput = typeof TeamSheetCreateInput.Type;

export const TeamSheetUpdateInput = Schema.Struct({
  sheetId: TeamSheetId,
  baseRevision: NonNegativeInt,
  changes: Schema.Array(TeamSheetChange).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});
export type TeamSheetUpdateInput = typeof TeamSheetUpdateInput.Type;

export const TeamSheetDuplicateInput = Schema.Struct({
  sheetId: TeamSheetId,
  name: Schema.optional(SheetName),
});
export type TeamSheetDuplicateInput = typeof TeamSheetDuplicateInput.Type;

export const TeamSheetDeleteInput = Schema.Struct({
  sheetId: TeamSheetId,
  baseRevision: NonNegativeInt,
});
export type TeamSheetDeleteInput = typeof TeamSheetDeleteInput.Type;

/** Pass `design` to check a draft, or `sheetId` to check a saved sheet. */
export const TeamSheetValidateInput = Schema.Struct({
  sheetId: Schema.optional(TeamSheetId),
  design: Schema.optional(TeamSheetDesign),
});
export type TeamSheetValidateInput = typeof TeamSheetValidateInput.Type;

export const TeamSheetValidateResult = Schema.Struct({
  valid: Schema.Boolean,
  problems: Schema.Array(Schema.String),
});
export type TeamSheetValidateResult = typeof TeamSheetValidateResult.Type;

export const TeamThreadSheetInput = Schema.Struct({ threadId: ThreadId });
export type TeamThreadSheetInput = typeof TeamThreadSheetInput.Type;

export const TeamThreadSheetSetInput = Schema.Struct({
  threadId: ThreadId,
  /** Null turns teamwork off for this thread. Its rosters stay. */
  sheetId: Schema.NullOr(TeamSheetId),
});
export type TeamThreadSheetSetInput = typeof TeamThreadSheetSetInput.Type;

export const TeamThreadSheet = Schema.Struct({
  threadId: ThreadId,
  sheetId: Schema.NullOr(TeamSheetId),
  sheetName: Schema.NullOr(Schema.String),
});
export type TeamThreadSheet = typeof TeamThreadSheet.Type;

export const TeamSlotStatus = Schema.Literals(["bound", "blocked", "vacant"]);
export type TeamSlotStatus = typeof TeamSlotStatus.Type;

/** One entry of a thread's roster for one sheet. `slot` is `team` or a member such as `m1`. */
export const TeamRosterSlot = Schema.Struct({
  threadId: ThreadId,
  sheetId: TeamSheetId,
  nodeId: TeamNodeId,
  slot: TrimmedNonEmptyString,
  sessionThreadId: Schema.NullOr(ThreadId),
  status: TeamSlotStatus,
  /** The run that created it. A later run may not add to that node. */
  createdRunId: TeamRunId,
  origin: Schema.Literals(["staffed", "growth"]),
  detail: Schema.NullOr(Schema.String),
});
export type TeamRosterSlot = typeof TeamRosterSlot.Type;

export const TeamReplaceSlotInput = Schema.Struct({
  threadId: ThreadId,
  sheetId: TeamSheetId,
  nodeId: TeamNodeId,
  slot: TrimmedNonEmptyString,
});
export type TeamReplaceSlotInput = typeof TeamReplaceSlotInput.Type;

export const TeamRunStatus = Schema.Literals([
  "running",
  "awaiting_owner",
  "blocked",
  "over_budget",
  "stopped",
  "done",
]);
export type TeamRunStatus = typeof TeamRunStatus.Type;

export const TeamBudget = Schema.Struct({
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  maxMinutes: NonNegativeInt,
  maxParallelAgents: NonNegativeInt,
  maxCorrectionCycles: NonNegativeInt,
});
export type TeamBudget = typeof TeamBudget.Type;

export const DEFAULT_TEAM_BUDGET: TeamBudget = {
  maxCostUsd: 25,
  maxMinutes: 240,
  maxParallelAgents: 4,
  maxCorrectionCycles: 3,
};

export const TeamMember = Schema.Struct({
  id: TeamMemberId,
  nodeId: TeamNodeId,
  slot: TrimmedNonEmptyString,
  kind: Schema.Literals(["lead", "build", "review", "validate"]),
  name: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  modelSelection: Schema.optional(ModelSelection),
  /** `removed` keeps a session whose node left the sheet: it stays in place, uninvoked. */
  state: Schema.Literals(["idle", "invoked", "blocked", "removed"]),
  detail: Schema.optional(Schema.String),
});
export type TeamMember = typeof TeamMember.Type;

export const TeamTaskStatus = Schema.Literals([
  "queued",
  "building",
  "reviewing",
  "validating",
  "blocked",
  "done",
]);
export type TeamTaskStatus = typeof TeamTaskStatus.Type;

export const TeamFinding = Schema.Struct({
  id: TeamFindingId,
  severity: Schema.Literals(["blocking", "suggestion"]),
  problem: TrimmedNonEmptyString,
  impact: Schema.String,
  evidence: Schema.String,
  resolvedWhen: Schema.String,
  status: Schema.Literals(["open", "resolved", "accepted", "deferred", "declined"]),
});
export type TeamFinding = typeof TeamFinding.Type;

/** The shared task record, updated by every team. */
export const TeamTask = Schema.Struct({
  id: TeamTaskId,
  objective: TrimmedNonEmptyString,
  ownerId: Schema.NullOr(TeamMemberId),
  scope: Schema.String,
  dependencies: Schema.Array(TeamTaskId),
  acceptanceCriteria: Schema.Array(Schema.String),
  deliverable: Schema.String,
  /** Bumped by every handoff, so a verdict can name the candidate it judged. */
  version: NonNegativeInt,
  status: TeamTaskStatus,
  blocker: Schema.optional(Schema.String),
  /** Who built it, kept after it moves on, since they may not judge it. */
  builtBy: Schema.Array(TeamMemberId),
  corrections: NonNegativeInt,
  findings: Schema.Array(TeamFinding),
});
export type TeamTask = typeof TeamTask.Type;

export const TeamHandoff = Schema.Struct({
  taskId: TeamTaskId,
  fromId: TeamMemberId,
  version: NonNegativeInt,
  changed: Schema.String,
  where: Schema.String,
  requirements: Schema.String,
  checked: Schema.String,
  uncertain: Schema.String,
  at: IsoDateTime,
});
export type TeamHandoff = typeof TeamHandoff.Type;

/** A command and what it printed. A pass does not stand without these. */
export const TeamEvidence = Schema.Struct({
  taskId: Schema.optional(TeamTaskId),
  byId: TeamMemberId,
  command: TrimmedNonEmptyString,
  output: Schema.String,
  passed: Schema.Boolean,
  at: IsoDateTime,
});
export type TeamEvidence = typeof TeamEvidence.Type;

export const TeamCriterionResult = Schema.Struct({
  criterion: TrimmedNonEmptyString,
  result: Schema.Literals(["pass", "fail", "unverified"]),
  evidence: Schema.String,
});
export type TeamCriterionResult = typeof TeamCriterionResult.Type;

export const TeamVerdictOutcome = Schema.Literals(["pass", "changes_required", "fail", "blocked"]);
export type TeamVerdictOutcome = typeof TeamVerdictOutcome.Type;

export const TeamVerdict = Schema.Struct({
  taskId: TeamTaskId,
  nodeId: TeamNodeId,
  byId: TeamMemberId,
  /** The candidate this judged. A later handoff makes it stale. */
  version: NonNegativeInt,
  outcome: TeamVerdictOutcome,
  limitations: Schema.String,
  criteria: Schema.Array(TeamCriterionResult),
  at: IsoDateTime,
});
export type TeamVerdict = typeof TeamVerdict.Type;

export const TeamNote = Schema.Struct({
  kind: Schema.Literals(["plan", "decision", "question", "standup", "owner", "roster"]),
  byId: TeamMemberId,
  text: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type TeamNote = typeof TeamNote.Type;

export const TeamReport = Schema.Struct({
  summary: TrimmedNonEmptyString,
  verified: Schema.Array(Schema.String),
  notVerified: Schema.Array(Schema.String),
  openRisks: Schema.Array(Schema.String),
});
export type TeamReport = typeof TeamReport.Type;

export const TeamGrowthStatus = Schema.Literals([
  /** Refused before it reached the lead, because Growth is off. */
  "refused",
  "open",
  "awaiting_owner",
  "owner_allowed",
  "accepted",
  "denied",
]);
export type TeamGrowthStatus = typeof TeamGrowthStatus.Type;

export const TeamGrowthRequest = Schema.Struct({
  id: TeamGrowthRequestId,
  nodeId: TeamNodeId,
  fromId: TeamMemberId,
  capacity: TrimmedNonEmptyString,
  why: TrimmedNonEmptyString,
  tried: TrimmedNonEmptyString,
  status: TeamGrowthStatus,
  decidedBy: Schema.NullOr(Schema.Literals(["system", "lead", "owner"])),
  reason: Schema.NullOr(Schema.String),
  memberId: Schema.NullOr(TeamMemberId),
  scope: Schema.NullOr(TeamGrowthScope),
  requestedAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type TeamGrowthRequest = typeof TeamGrowthRequest.Type;

/** The sheet as a run saw it when it started, so a later edit cannot rewrite the run. */
export const TeamRunFlow = Schema.Struct({
  sheetName: Schema.String,
  sheetRevision: NonNegativeInt,
  nestedSessions: Schema.Boolean,
  nodes: TeamSheet.fields.nodes,
  edges: TeamSheet.fields.edges,
});
export type TeamRunFlow = typeof TeamRunFlow.Type;

export const TeamRun = Schema.Struct({
  id: TeamRunId,
  parentThreadId: ThreadId,
  sheetId: TeamSheetId,
  flow: TeamRunFlow,
  request: TrimmedNonEmptyString,
  /** The thread's selection when the run started. The lead's node shows it, and has no picker. */
  leadModel: ModelSelection,
  budget: TeamBudget,
  costUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  status: TeamRunStatus,
  /** Null once the run is done or before the lead moves it on. */
  activeNodeId: Schema.NullOr(TeamNodeId),
  /** What the owner must do, in plain words, while the run waits. */
  waitingFor: Schema.NullOr(Schema.String),
  correctionCycles: NonNegativeInt,
  members: Schema.Array(TeamMember),
  tasks: Schema.Array(TeamTask),
  notes: Schema.Array(TeamNote),
  handoffs: Schema.Array(TeamHandoff),
  evidence: Schema.Array(TeamEvidence),
  verdicts: Schema.Array(TeamVerdict),
  growth: Schema.Array(TeamGrowthRequest),
  report: Schema.NullOr(TeamReport),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamRun = typeof TeamRun.Type;

const NewFinding = Schema.Struct({
  severity: TeamFinding.fields.severity,
  problem: TeamFinding.fields.problem,
  impact: TeamFinding.fields.impact,
  evidence: TeamFinding.fields.evidence,
  resolvedWhen: TeamFinding.fields.resolvedWhen,
});

export const TeamAction = Schema.Union([
  /** The lead moves the run along an edge of the flow chart. */
  Schema.Struct({ type: Schema.Literal("advance"), byId: TeamMemberId, toNodeId: TeamNodeId }),
  Schema.Struct({ type: Schema.Literal("owner_stop"), reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal("owner_resume"), budget: TeamBudget }),
  Schema.Struct({
    type: Schema.Literal("owner_growth_answer"),
    requestId: TeamGrowthRequestId,
    allow: Schema.Boolean,
    note: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("verdict"),
    byId: TeamMemberId,
    taskId: TeamTaskId,
    version: NonNegativeInt,
    outcome: TeamVerdictOutcome,
    limitations: Schema.String,
    findings: Schema.optional(Schema.Array(NewFinding)),
    criteria: Schema.optional(Schema.Array(TeamCriterionResult)),
  }),
  Schema.Struct({
    type: Schema.Literal("task_upsert"),
    byId: TeamMemberId,
    taskId: TeamTaskId,
    objective: Schema.optional(TrimmedNonEmptyString),
    ownerId: Schema.optional(Schema.NullOr(TeamMemberId)),
    scope: Schema.optional(Schema.String),
    dependencies: Schema.optional(Schema.Array(TeamTaskId)),
    acceptanceCriteria: Schema.optional(Schema.Array(Schema.String)),
    deliverable: Schema.optional(Schema.String),
    status: Schema.optional(TeamTaskStatus),
    blocker: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("finding_update"),
    byId: TeamMemberId,
    taskId: TeamTaskId,
    findingId: TeamFindingId,
    status: TeamFinding.fields.status,
  }),
  Schema.Struct({
    type: Schema.Literal("note"),
    byId: TeamMemberId,
    kind: TeamNote.fields.kind,
    text: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("handoff"),
    fromId: TeamMemberId,
    taskId: TeamTaskId,
    changed: Schema.String,
    where: Schema.String,
    requirements: Schema.String,
    checked: Schema.String,
    uncertain: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("evidence"),
    byId: TeamMemberId,
    taskId: Schema.optional(TeamTaskId),
    command: TrimmedNonEmptyString,
    output: Schema.String,
    passed: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("report"), byId: TeamMemberId, report: TeamReport }),
]);
export type TeamAction = typeof TeamAction.Type;

export const TeamStartInput = Schema.Struct({
  parentThreadId: ThreadId,
  request: TrimmedNonEmptyString,
  /** Defaults to the sheet enabled on the thread, then the default sheet. */
  sheetId: Schema.optional(TeamSheetId),
  budget: Schema.optional(TeamBudget),
});
export type TeamStartInput = typeof TeamStartInput.Type;

export const TeamActInput = Schema.Struct({ runId: TeamRunId, action: TeamAction });
export type TeamActInput = typeof TeamActInput.Type;

export const TeamStartMemberInput = Schema.Struct({
  runId: TeamRunId,
  nodeId: TeamNodeId,
  /** Omit for the team's own session. Name a member such as `m1` to staff or invoke it. */
  slot: Schema.optional(TrimmedNonEmptyString),
  message: TrimmedNonEmptyString,
  /** Provider, model, and effort, within what the node's model option allows. */
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamStartMemberInput = typeof TeamStartMemberInput.Type;

export const TeamGrowthRequestInput = Schema.Struct({
  runId: TeamRunId,
  capacity: TeamGrowthRequest.fields.capacity,
  why: TeamGrowthRequest.fields.why,
  tried: TeamGrowthRequest.fields.tried,
});
export type TeamGrowthRequestInput = typeof TeamGrowthRequestInput.Type;

export const TeamGrowthDecideInput = Schema.Struct({
  runId: TeamRunId,
  requestId: TeamGrowthRequestId,
  accept: Schema.Boolean,
  reason: TrimmedNonEmptyString,
  /** The new member's assignment, needed to accept. */
  brief: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamGrowthDecideInput = typeof TeamGrowthDecideInput.Type;

export const TeamListInput = Schema.Struct({ parentThreadId: Schema.optional(ThreadId) });
export const TeamListResult = Schema.Struct({ runs: ForwardCompatibleArray(TeamRun) });

export const TeamRosterInput = Schema.Struct({ threadId: ThreadId, sheetId: TeamSheetId });
export type TeamRosterInput = typeof TeamRosterInput.Type;
export const TeamRosterResult = Schema.Struct({ slots: ForwardCompatibleArray(TeamRosterSlot) });
export type TeamRosterResult = typeof TeamRosterResult.Type;

/** What changed, so a client re-reads only that. */
export const TeamworkChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run"), runId: TeamRunId, updatedAt: IsoDateTime }),
  Schema.Struct({
    type: Schema.Literal("sheet"),
    sheetId: TeamSheetId,
    revision: Schema.NullOr(NonNegativeInt),
  }),
  Schema.Struct({ type: Schema.Literal("thread"), threadId: ThreadId }),
]);
export type TeamworkChange = typeof TeamworkChange.Type;

export const TeamworkErrorReason = Schema.Literals([
  "not_found",
  "not_a_member",
  "self_approval",
  "needs_evidence",
  "needs_verdict",
  "failed_checks",
  "wrong_phase",
  "run_closed",
  "budget",
  "store_failed",
  "start_failed",
  "chat_thread",
  "invalid_sheet",
  "read_only_sheet",
  "revision_conflict",
  "roster_fixed",
  "slot_blocked",
  "model_not_allowed",
  "growth_off",
  "growth_refused",
  "not_lead",
]);
export type TeamworkErrorReason = typeof TeamworkErrorReason.Type;

export class TeamworkError extends Schema.TaggedError<TeamworkError>()("TeamworkError", {
  reason: TeamworkErrorReason,
  detail: TrimmedNonEmptyString,
}) {
  override get message(): string {
    return this.detail;
  }
}
