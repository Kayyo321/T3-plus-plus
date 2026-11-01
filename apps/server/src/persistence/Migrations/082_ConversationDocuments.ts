import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_documents (
      document_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER NOT NULL,
      carried_version INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      moved_to_json TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_conversation_documents_thread
    ON conversation_documents(thread_id, created_at)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_document_versions (
      document_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (document_id, version)
    )
  `;
});
