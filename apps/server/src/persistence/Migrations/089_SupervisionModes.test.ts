import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const rows = [
  ["watched", { mode: "on", automatic: false }, "modest"],
  ["let-run", { mode: "off", automatic: false }, "off"],
  ["automatic", { mode: "on", automatic: true }, null],
] as const;

it.effect("maps stored on and off to modes, and lets automatic rows follow the default", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 88 });
    for (const [threadId, state] of rows) {
      yield* sql`INSERT INTO supervision_thread_state (thread_id, state_json) VALUES (${threadId}, ${JSON.stringify({ ...state, reviews: 2 })})`;
    }
    yield* runMigrations({ toMigrationInclusive: 89 });
    const stored = yield* sql<{ readonly threadId: string; readonly stateJson: string }>`
      SELECT thread_id AS "threadId", state_json AS "stateJson" FROM supervision_thread_state
    `;
    for (const [threadId, , mode] of rows) {
      const row = stored.find((candidate) => candidate.threadId === threadId)!;
      assert.deepStrictEqual(JSON.parse(row.stateJson), { mode, reviews: 2 });
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
