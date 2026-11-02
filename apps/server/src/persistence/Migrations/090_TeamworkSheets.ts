import { TEAM_LEAD_MEMBER_ID, TeamRun } from "@t3tools/contracts";
import { DEFAULT_TEAM_SHEET } from "@t3tools/shared/teamSheets";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

const nodeIdOf = (kind: "lead" | "build" | "review" | "validate") =>
  DEFAULT_TEAM_SHEET.nodes.find((node) => node.kind === kind)?.id ?? kind;

const KIND_BY_ROLE: Record<string, "lead" | "build" | "review" | "validate"> = {
  lead: "lead",
  builder: "build",
  reviewer: "review",
  tester: "validate",
  skeptic: "validate",
  scribe: "review",
};

const TASK_STATUS: Record<string, string> = {
  todo: "queued",
  doing: "building",
  review: "reviewing",
  blocked: "blocked",
  done: "done",
};

const NODE_BY_PHASE: Record<string, "review" | "validate"> = {
  peer_review: "review",
  plan_review: "review",
  verification: "validate",
  acceptance: "validate",
};

const mapRun = (old: Json): Json => {
  const oldMembers = list(old.members);
  const oldTasks = list(old.tasks);
  const lead = oldMembers.find((member) => member.role === "lead");
  const oldBudget = isRecord(old.budget) ? old.budget : {};
  const { maxReviewLoops, ...budget } = oldBudget;
  const firstTaskId = typeof oldTasks[0]?.id === "string" ? oldTasks[0].id : "legacy";
  return {
    id: old.id,
    parentThreadId: old.parentThreadId,
    sheetId: "default",
    flow: {
      sheetName: DEFAULT_TEAM_SHEET.name,
      sheetRevision: 0,
      nestedSessions: true,
      nodes: DEFAULT_TEAM_SHEET.nodes,
      edges: DEFAULT_TEAM_SHEET.edges,
    },
    request: old.request,
    leadModel: isRecord(lead?.modelSelection)
      ? lead.modelSelection
      : { instanceId: "codex", model: "unknown" },
    budget: {
      ...budget,
      maxCorrectionCycles: typeof maxReviewLoops === "number" ? maxReviewLoops : 3,
    },
    ...(old.costUsd === undefined ? {} : { costUsd: old.costUsd }),
    status: old.status === "completed" ? "done" : old.status,
    activeNodeId: null,
    waitingFor: old.waitingFor ?? null,
    correctionCycles: typeof old.reviewLoops === "number" ? old.reviewLoops : 0,
    members: oldMembers.map((member) => {
      const role = typeof member.role === "string" ? member.role : "lead";
      const kind = KIND_BY_ROLE[role] ?? "review";
      return {
        id: member.id,
        nodeId: member.id === TEAM_LEAD_MEMBER_ID ? nodeIdOf("lead") : nodeIdOf(kind),
        slot: member.id,
        kind,
        name: role,
        threadId: member.threadId ?? null,
        ...(isRecord(member.modelSelection) ? { modelSelection: member.modelSelection } : {}),
        state: "idle",
      };
    }),
    tasks: oldTasks.map((task) => ({
      id: task.id,
      objective: task.title,
      ownerId: task.ownerId ?? null,
      scope: "",
      dependencies: [],
      acceptanceCriteria: [],
      deliverable: "",
      version: 0,
      status: TASK_STATUS[String(task.state)] ?? "queued",
      ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
      builtBy: Array.isArray(task.builtBy) ? task.builtBy : [],
      corrections: 0,
      findings: [],
    })),
    notes: list(old.notes),
    handoffs: list(old.handoffs).map((handoff) => ({
      taskId: handoff.taskId,
      fromId: handoff.fromId,
      version: 0,
      changed: handoff.done,
      where: "",
      requirements: "",
      checked: handoff.howToVerify,
      uncertain: handoff.knownGaps,
      at: handoff.at,
    })),
    evidence: list(old.evidence),
    verdicts: list(old.verdicts).map((verdict) => ({
      taskId: firstTaskId,
      nodeId: nodeIdOf(NODE_BY_PHASE[String(verdict.phase)] ?? "review"),
      byId: verdict.byId,
      version: 0,
      outcome: verdict.passed === true ? "pass" : "fail",
      limitations: verdict.reason ?? "",
      criteria: [],
      at: verdict.at,
    })),
    growth: [],
    report: old.report ?? null,
    startedAt: old.startedAt,
    updatedAt: old.updatedAt,
  };
};

const decodeRun = Schema.decodeUnknownOption(TeamRun);

/** The new run JSON, or null for a row that cannot be read. Such rows stay as they are. */
const migrateRunJson = (runJson: string): string | null => {
  let old: unknown;
  try {
    old = JSON.parse(runJson);
  } catch {
    return null;
  }
  if (!isRecord(old)) return null;
  const decoded = decodeRun(mapRun(old));
  return Option.isSome(decoded) ? JSON.stringify(decoded.value) : null;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE teamwork_sheets (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      sheet_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE teamwork_thread_sheets (
      thread_id TEXT PRIMARY KEY,
      sheet_id TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE teamwork_roster (
      thread_id TEXT NOT NULL,
      sheet_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      session_thread_id TEXT,
      status TEXT NOT NULL,
      created_run_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      detail TEXT,
      PRIMARY KEY (thread_id, sheet_id, node_id, slot)
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX teamwork_roster_session ON teamwork_roster(session_thread_id)
    WHERE session_thread_id IS NOT NULL
  `;
  yield* sql`ALTER TABLE teamwork_runs ADD COLUMN origin_run_id TEXT`;
  yield* sql`
    CREATE UNIQUE INDEX teamwork_runs_origin_run ON teamwork_runs(origin_run_id)
    WHERE origin_run_id IS NOT NULL
  `;

  const rows = yield* sql<{ readonly id: string; readonly runJson: string }>`
    SELECT id, run_json AS "runJson" FROM teamwork_runs
  `;
  for (const row of rows) {
    const migrated = migrateRunJson(row.runJson);
    if (migrated === null) {
      yield* Effect.logWarning("Skipping a teamwork run that cannot be migrated").pipe(
        Effect.annotateLogs({ runId: row.id }),
      );
      continue;
    }
    yield* sql`UPDATE teamwork_runs SET run_json = ${migrated} WHERE id = ${row.id}`;
  }
});
