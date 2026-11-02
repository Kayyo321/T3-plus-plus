import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const at = "2026-10-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const thread = (threadId: string, payload: Record<string, unknown>) => {
    const payloadJson = JSON.stringify({ id: threadId, ...payload });
    return sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${threadId}, 'project-1', ${threadId}, 'codex', 'full-access', 'default',
        ${at}, ${at}, ${payloadJson}
      )
    `;
  };
  const folder = (id: string, name: string, parentId: string | null, deletedAt?: string) => sql`
    INSERT INTO conversation_folders (id, parent_id, name, smart_filter_json, system_key,
      created_at, updated_at, deleted_at)
    VALUES (${id}, ${parentId}, ${name}, NULL, NULL, ${at}, ${at}, ${deletedAt ?? null})
  `;
  const file = (folderId: string, threadId: string) => sql`
    INSERT INTO conversation_folder_threads (thread_id, folder_id, filed_at)
    VALUES (${threadId}, ${folderId}, ${at})
  `;
  yield* thread("chat-1", { capabilityMode: "chat" });
  yield* thread("chat-2", { capabilityMode: "chat" });
  yield* thread("chat-3", { capabilityMode: "chat" });
  yield* thread("code-1", {});
  yield* thread("code-2", { capabilityMode: "code" });
  yield* thread("code-3", {});
  yield* folder("f-chat", "Chat notes", null);
  yield* file("f-chat", "chat-1");
  yield* folder("f-mixed", "Mixed", null);
  yield* file("f-mixed", "code-1");
  yield* folder("f-tree", "Tree", null);
  yield* folder("f-tree-child", "Tree child", "f-tree");
  yield* file("f-tree-child", "chat-2");
  yield* folder("f-tree-grand", "Tree grandchild", "f-tree-child");
  yield* file("f-tree-grand", "code-2");
  yield* folder("f-empty", "Empty", null);
  yield* folder("f-deleted", "Deleted chat", null, at);
  yield* file("f-deleted", "chat-3");
  yield* folder("f-unknown", "Unknown thread", null);
  yield* file("f-unknown", "missing-thread");
  yield* file("f-mixed", "code-3");
});

it.effect("backfills each top-level folder from the chat threads anywhere in its tree", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    yield* seed;

    assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 87 }), [
      [87, "ConversationFolderCapabilityMode"],
    ]);
    const rows = yield* sql<{ readonly id: string; readonly capability_mode: string }>`
      SELECT id, capability_mode FROM conversation_folders ORDER BY id
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.id, row.capability_mode]),
      [
        ["f-chat", "chat"],
        ["f-deleted", "chat"],
        ["f-empty", "code"],
        ["f-mixed", "code"],
        ["f-tree", "chat"],
        ["f-tree-child", "chat"],
        ["f-tree-grand", "chat"],
        ["f-unknown", "code"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keys folder names by mode, so the same top-level name fits once per mode", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    yield* seed;
    yield* runMigrations({ toMigrationInclusive: 87 });

    yield* sql`
      INSERT INTO conversation_folders (id, parent_id, name, created_at, updated_at, capability_mode)
      VALUES ('f-mixed-chat', NULL, 'Mixed', ${at}, ${at}, 'chat')
    `;
    const duplicate = yield* Effect.exit(sql`
      INSERT INTO conversation_folders (id, parent_id, name, created_at, updated_at, capability_mode)
      VALUES ('f-mixed-dupe', NULL, 'mixed', ${at}, ${at}, 'code')
    `);
    assert.strictEqual(duplicate._tag, "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
