import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const TeamRunId = TrimmedNonEmptyString.pipe(Schema.brand("TeamRunId"));
export type TeamRunId = typeof TeamRunId.Type;
export const TeamTaskId = TrimmedNonEmptyString.pipe(Schema.brand("TeamTaskId"));
export type TeamTaskId = typeof TeamTaskId.Type;
export const TeamMemberId = TrimmedNonEmptyString.pipe(Schema.brand("TeamMemberId"));
export type TeamMemberId = typeof TeamMemberId.Type;

export const TeamRole = Schema.Literals([
  "lead",
  "builder",
  "reviewer",
  "tester",
  "skeptic",
  "scribe",
]);
export type TeamRole = typeof TeamRole.Type;

export const TEAM_PHASES = [
  "intake",
  "plan",
  "plan_review",
  "build",
  "peer_review",
  "verification",
  "acceptance",
  "report",
] as const;
export const TeamPhase = Schema.Literals(TEAM_PHASES);
export type TeamPhase = typeof TeamPhase.Type;

/** How much the owner holds the wheel. */
export const TeamDial = Schema.Literals(["autonomous", "approve_plan", "approve_each_phase"]);
export type TeamDial = typeof TeamDial.Type;

export const TeamRunStatus = Schema.Literals([
  "running",
  "awaiting_owner",
  "over_budget",
  "stopped",
  "completed",
]);
export type TeamRunStatus = typeof TeamRunStatus.Type;

export const TeamBudget = Schema.Struct({
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  maxMinutes: NonNegativeInt,
  maxParallelAgents: NonNegativeInt,
  maxReviewLoops: NonNegativeInt,
});
export type TeamBudget = typeof TeamBudget.Type;

export const DEFAULT_TEAM_BUDGET: TeamBudget = {
  maxCostUsd: 25,
  maxMinutes: 240,
  maxParallelAgents: 4,
  maxReviewLoops: 3,
};

export const TeamPresetRole = Schema.Struct({
  role: TeamRole,
  count: NonNegativeInt.check(Schema.isLessThanOrEqualTo(8)),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamPresetRole = typeof TeamPresetRole.Type;

export const TeamPreset = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  roles: Schema.Array(TeamPresetRole),
});
export type TeamPreset = typeof TeamPreset.Type;

export const BUILT_IN_TEAM_PRESETS: ReadonlyArray<TeamPreset> = [
  {
    id: "fix-a-bug",
    name: "Fix a bug",
    roles: [
      { role: "lead", count: 1 },
      { role: "builder", count: 1 },
      { role: "tester", count: 1 },
      { role: "reviewer", count: 1 },
    ],
  },
  {
    id: "build-a-feature",
    name: "Build a feature",
    roles: [
      { role: "lead", count: 1 },
      { role: "builder", count: 2 },
      { role: "reviewer", count: 1 },
      { role: "tester", count: 1 },
      { role: "skeptic", count: 1 },
    ],
  },
  {
    id: "audit",
    name: "Audit",
    roles: [
      { role: "lead", count: 1 },
      { role: "reviewer", count: 2 },
      { role: "skeptic", count: 1 },
    ],
  },
];

export const TeamMember = Schema.Struct({
  id: TeamMemberId,
  role: TeamRole,
  threadId: Schema.NullOr(ThreadId),
  modelSelection: Schema.optional(ModelSelection),
});
export type TeamMember = typeof TeamMember.Type;

export const TeamTaskState = Schema.Literals(["todo", "doing", "blocked", "review", "done"]);
export type TeamTaskState = typeof TeamTaskState.Type;

export const TeamTask = Schema.Struct({
  id: TeamTaskId,
  title: TrimmedNonEmptyString,
  ownerId: Schema.NullOr(TeamMemberId),
  state: TeamTaskState,
  blocker: Schema.optional(Schema.String),
  /** Who built it, kept after it moves on, since they may not judge it. */
  builtBy: Schema.Array(TeamMemberId),
});
export type TeamTask = typeof TeamTask.Type;

export const TeamHandoff = Schema.Struct({
  taskId: TeamTaskId,
  fromId: TeamMemberId,
  done: Schema.String,
  howToVerify: Schema.String,
  knownGaps: Schema.String,
  at: IsoDateTime,
});
export type TeamHandoff = typeof TeamHandoff.Type;

/** A command and what it printed. Verification and acceptance do not pass without these. */
export const TeamEvidence = Schema.Struct({
  taskId: Schema.optional(TeamTaskId),
  byId: TeamMemberId,
  command: TrimmedNonEmptyString,
  output: Schema.String,
  passed: Schema.Boolean,
  at: IsoDateTime,
});
export type TeamEvidence = typeof TeamEvidence.Type;

export const TeamVerdict = Schema.Struct({
  phase: TeamPhase,
  byId: TeamMemberId,
  passed: Schema.Boolean,
  reason: TrimmedNonEmptyString,
  at: IsoDateTime,
});
export type TeamVerdict = typeof TeamVerdict.Type;

export const TeamNote = Schema.Struct({
  kind: Schema.Literals(["plan", "decision", "question", "standup"]),
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

export const TeamRun = Schema.Struct({
  id: TeamRunId,
  parentThreadId: ThreadId,
  request: TrimmedNonEmptyString,
  presetId: TrimmedNonEmptyString,
  dial: TeamDial,
  budget: TeamBudget,
  costUsd: Schema.optional(Schema.NullOr(Schema.Number)),
  dryRun: Schema.Boolean,
  phase: TeamPhase,
  status: TeamRunStatus,
  /** What the owner must do, in plain words, while the run waits. */
  waitingFor: Schema.NullOr(Schema.String),
  reviewLoops: NonNegativeInt,
  members: Schema.Array(TeamMember),
  tasks: Schema.Array(TeamTask),
  notes: Schema.Array(TeamNote),
  handoffs: Schema.Array(TeamHandoff),
  evidence: Schema.Array(TeamEvidence),
  verdicts: Schema.Array(TeamVerdict),
  report: Schema.NullOr(TeamReport),
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TeamRun = typeof TeamRun.Type;

export const TeamAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("advance"), byId: TeamMemberId }),
  Schema.Struct({ type: Schema.Literal("owner_approve") }),
  Schema.Struct({ type: Schema.Literal("owner_stop"), reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal("owner_resume"), budget: TeamBudget }),
  Schema.Struct({
    type: Schema.Literal("verdict"),
    byId: TeamMemberId,
    passed: Schema.Boolean,
    reason: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("task_upsert"),
    byId: TeamMemberId,
    taskId: TeamTaskId,
    title: Schema.optional(TrimmedNonEmptyString),
    ownerId: Schema.optional(Schema.NullOr(TeamMemberId)),
    state: Schema.optional(TeamTaskState),
    blocker: Schema.optional(Schema.String),
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
    done: Schema.String,
    howToVerify: Schema.String,
    knownGaps: Schema.String,
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
  presetId: TrimmedNonEmptyString,
  roles: Schema.optional(
    Schema.Array(TeamPresetRole).check(Schema.isMinLength(1), Schema.isMaxLength(6)),
  ),
  dial: TeamDial,
  budget: Schema.optional(TeamBudget),
  /** Plan and team assignment only, before spending anything. */
  dryRun: Schema.optional(Schema.Boolean),
});
export type TeamStartInput = typeof TeamStartInput.Type;

export const TeamActInput = Schema.Struct({ runId: TeamRunId, action: TeamAction });
export type TeamActInput = typeof TeamActInput.Type;

export const TeamStartMemberInput = Schema.Struct({
  runId: TeamRunId,
  memberId: TeamMemberId,
  message: TrimmedNonEmptyString,
});
export type TeamStartMemberInput = typeof TeamStartMemberInput.Type;

export const TeamListInput = Schema.Struct({ parentThreadId: Schema.optional(ThreadId) });
export const TeamListResult = Schema.Struct({ runs: ForwardCompatibleArray(TeamRun) });

export const TeamworkErrorReason = Schema.Literals([
  "not_found",
  "unknown_preset",
  "invalid_team",
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
