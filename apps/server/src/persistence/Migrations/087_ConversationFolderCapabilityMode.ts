import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE conversation_folders ADD COLUMN capability_mode TEXT NOT NULL DEFAULT 'code'`;
  // Folders used to mix modes. A top-level folder becomes chat when a chat thread is filed anywhere
  // in its tree, and the whole tree takes that mode, since subfolders always follow their top level.
  // The thread table is created by migration 055, which always runs before this one.
  yield* sql`
    WITH RECURSIVE tree(folder_id, root_id) AS (
      SELECT id, id FROM conversation_folders WHERE parent_id IS NULL
      UNION
      SELECT child.id, tree.root_id
      FROM conversation_folders AS child
      JOIN tree ON child.parent_id = tree.folder_id
    ),
    chat_roots AS (
      SELECT tree.root_id
      FROM tree
      JOIN conversation_folder_threads AS placed ON placed.folder_id = tree.folder_id
      JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = placed.thread_id
      WHERE json_extract(thread.payload_json, '$.capabilityMode') = 'chat'
    )
    UPDATE conversation_folders SET capability_mode = 'chat'
    WHERE id IN (SELECT folder_id FROM tree WHERE root_id IN (SELECT root_id FROM chat_roots))
  `;
  // Top-level names are unique per mode, so "Work" can exist once in each. Subfolders already share
  // their parent's mode, so the same index covers them.
  yield* sql`DROP INDEX IF EXISTS idx_conversation_folders_live_name`;
  yield* sql`
    CREATE UNIQUE INDEX idx_conversation_folders_live_name
    ON conversation_folders(COALESCE(parent_id, ''), capability_mode, name COLLATE NOCASE)
    WHERE deleted_at IS NULL
  `;
});
