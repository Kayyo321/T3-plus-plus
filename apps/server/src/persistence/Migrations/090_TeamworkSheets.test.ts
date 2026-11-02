import { assert, it } from "@effect/vitest";
import { TeamRun } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const decodeTeamRun = Schema.decodeUnknownSync(TeamRun);

const oldRun = {
  id: "run-old",
  parentThreadId: "thread-1",
  presetId: "build-review",
  request: "Ship it",
  status: "completed",
  phase: "acceptance",
  reviewLoops: 2,
  budget: { maxCostUsd: 25, maxMinutes: 240, maxParallelAgents: 4, maxReviewLoops: 3 },
  members: [
    {
      id: "lead",
      role: "lead",
      threadId: "thread-1",
      state: "idle",
      modelSelection: { instanceId: "codex", model: "gpt" },
    },
    { id: "builder-1", role: "builder", threadId: "s-1", state: "idle" },
    { id: "skeptic-1", role: "skeptic", threadId: "s-2", state: "idle" },
  ],
  tasks: [
    { id: "task-1", title: "Parser", ownerId: "builder-1", state: "done", builtBy: ["builder-1"] },
  ],
  notes: [],
  handoffs: [
    {
      taskId: "task-1",
      fromId: "builder-1",
      done: "parser",
      howToVerify: "tests",
      knownGaps: "none",
      at: "2026-11-01T12:00:00.000Z",
    },
  ],
  evidence: [],
  verdicts: [
    {
      phase: "acceptance",
      byId: "skeptic-1",
      passed: true,
      reason: "",
      at: "2026-11-01T12:01:00.000Z",
    },
  ],
  startedAt: "2026-11-01T11:00:00.000Z",
  updatedAt: "2026-11-01T12:01:00.000Z",
};

it.effect("rewrites an old run into the sheet shape and leaves unreadable rows alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 89 });
    yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json) VALUES ('run-old', 'thread-1', ${JSON.stringify(oldRun)})`;
    yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json) VALUES ('run-broken', 'thread-1', 'not json')`;
    yield* runMigrations({ toMigrationInclusive: 90 });
    const stored = yield* sql<{ readonly id: string; readonly runJson: string }>`
      SELECT id, run_json AS "runJson" FROM teamwork_runs ORDER BY id
    `;
    const migrated = decodeTeamRun(JSON.parse(stored[1]!.runJson));
    assert.strictEqual(stored[0]!.id, "run-broken");
    assert.strictEqual(stored[0]!.runJson, "not json");
    assert.strictEqual(migrated.sheetId, "default");
    assert.strictEqual(migrated.status, "done");
    assert.strictEqual(migrated.correctionCycles, 2);
    assert.strictEqual(migrated.budget.maxCorrectionCycles, 3);
    assert.deepStrictEqual(
      { instanceId: String(migrated.leadModel.instanceId), model: migrated.leadModel.model },
      { instanceId: "codex", model: "gpt" },
    );
    assert.deepStrictEqual(
      migrated.members.map((member) => [member.id, member.kind, member.state]),
      [
        ["lead", "lead", "idle"],
        ["builder-1", "build", "idle"],
        ["skeptic-1", "validate", "idle"],
      ],
    );
    assert.deepStrictEqual(
      migrated.tasks.map((task) => [task.objective, task.status, task.version]),
      [["Parser", "done", 0]],
    );
    assert.deepStrictEqual(
      migrated.verdicts.map((verdict) => [verdict.taskId, verdict.nodeId, verdict.outcome]),
      [["task-1", "validate", "pass"]],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
