import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN policy_json TEXT`;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN repeater_iterations INTEGER NOT NULL DEFAULT 0`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      trigger TEXT NOT NULL,
      scheduled_for TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      outcome TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      iteration INTEGER NOT NULL DEFAULT 0,
      verdict TEXT,
      summary TEXT,
      error TEXT,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL,
      parked_at TEXT,
      parked_ms INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task
    ON scheduled_task_runs(task_id, started_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_active
    ON scheduled_task_runs(thread_id) WHERE finished_at IS NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS computer_use_steps (
      step_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      at TEXT NOT NULL,
      target TEXT NOT NULL,
      action TEXT NOT NULL,
      intent TEXT NOT NULL,
      sensitivity TEXT,
      status TEXT NOT NULL,
      result TEXT,
      has_screenshot INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_computer_use_steps_thread
    ON computer_use_steps(thread_id, sequence DESC)
  `;
});
