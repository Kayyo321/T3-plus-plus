import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folders_json TEXT NOT NULL,
      working_root TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_live_name
    ON workspaces(name COLLATE NOCASE) WHERE deleted_at IS NULL
  `;
  // `ciphertext` is useless without the key in the secrets directory, so a copy of this database
  // never carries a usable value. A provider secret stores only its reference.
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_secrets (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      ciphertext TEXT,
      reference_json TEXT,
      provider TEXT,
      unmasked INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, name)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_attachments (
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL,
      PRIMARY KEY (target_kind, target_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_workspace_attachments_workspace
    ON workspace_attachments(workspace_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      name TEXT NOT NULL,
      smart_filter_json TEXT,
      system_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_folders_live_name
    ON conversation_folders(COALESCE(parent_id, ''), name COLLATE NOCASE)
    WHERE deleted_at IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_folders_system_key
    ON conversation_folders(system_key) WHERE system_key IS NOT NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_folder_threads (
      thread_id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL,
      filed_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_conversation_folder_threads_folder
    ON conversation_folder_threads(folder_id)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS conversation_thread_tags (
      thread_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (thread_id, tag)
    )
  `;
});
