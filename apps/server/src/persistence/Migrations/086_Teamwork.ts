import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE teamwork_runs (
      id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      run_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX teamwork_runs_parent ON teamwork_runs(parent_thread_id)`;
});
