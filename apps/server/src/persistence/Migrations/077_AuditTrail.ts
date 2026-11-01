import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS audit_trail (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      domain TEXT NOT NULL,
      thread_id TEXT,
      entry_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_audit_trail_actor ON audit_trail(actor, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_audit_trail_domain ON audit_trail(domain, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_audit_trail_thread ON audit_trail(thread_id, sequence)`;
});
