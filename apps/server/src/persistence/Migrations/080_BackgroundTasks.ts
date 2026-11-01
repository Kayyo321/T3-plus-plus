import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      started_at TEXT NOT NULL,
      task_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_background_tasks_thread ON background_tasks(thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_background_tasks_state ON background_tasks(state)`;
});
