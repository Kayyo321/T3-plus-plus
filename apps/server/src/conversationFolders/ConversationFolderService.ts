// Folder placement stays out of the event store and the shell stream: only filed threads cost
// anything, and only clients showing folders pay for it.
import {
  type AuditActorKind,
  CONVERSATION_FOLDER_MAX_DEPTH,
  ConversationFolder,
  ConversationFolderError,
  type ConversationFolderErrorReason,
  ConversationFolderId,
  type ConversationFolderMutation,
  type ConversationFolderMutationResult,
  type ConversationFolderSnapshot,
  type ConversationFolderStreamEvent,
  ConversationSmartFilter,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import type * as Statement from "effect/sql/Statement";

import * as AuditTrail from "../audit/AuditTrail.ts";

const SCHEDULED_FOLDER_NAME = "Scheduled";
const RETAINED_DELETED_FOLDERS = 50;

const decodeSmartFilter = Schema.decodeUnknownOption(
  Schema.fromJsonString(ConversationSmartFilter),
);
const encodeSmartFilter = Schema.encodeSync(Schema.fromJsonString(ConversationSmartFilter));

interface FolderRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly smartFilterJson: string | null;
  readonly systemKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

const toFolder = (row: FolderRow): ConversationFolder => {
  const smartFilter =
    row.smartFilterJson === null ? Option.none() : decodeSmartFilter(row.smartFilterJson);
  return {
    id: ConversationFolderId.make(row.id),
    parentId: row.parentId === null ? null : ConversationFolderId.make(row.parentId),
    name: row.name as ConversationFolder["name"],
    ...(Option.isSome(smartFilter) ? { smartFilter: smartFilter.value } : {}),
    ...(row.systemKey === "scheduled" ? { systemKey: "scheduled" as const } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
};

export interface ConversationFolderActor {
  readonly actor: AuditActorKind;
  readonly actorLabel?: string;
}

const USER_ACTOR: ConversationFolderActor = { actor: "user" };

export class ConversationFolderService extends Context.Service<
  ConversationFolderService,
  {
    readonly snapshot: Effect.Effect<ConversationFolderSnapshot, ConversationFolderError>;
    /** A snapshot, then deltas: one move never resends every placement. */
    readonly subscribe: Stream.Stream<ConversationFolderStreamEvent, ConversationFolderError>;
    readonly mutate: (
      mutation: ConversationFolderMutation,
      actor?: ConversationFolderActor,
    ) => Effect.Effect<ConversationFolderMutationResult, ConversationFolderError>;
    /** Files a scheduled task's run under the Scheduled folder, bringing it back if it was deleted. */
    readonly fileScheduledRun: (
      threadId: ThreadId,
    ) => Effect.Effect<ConversationFolder, ConversationFolderError>;
  }
>()("t3pp/conversationFolders/ConversationFolderService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const audit = yield* AuditTrail.AuditTrail;
  const events = yield* PubSub.unbounded<ConversationFolderStreamEvent>();

  const failWith = (reason: ConversationFolderErrorReason) =>
    new ConversationFolderError({ reason });
  const storageFailed = () => failWith("storage_failed");
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const selectFolders = (where: Statement.Fragment) => sql<FolderRow>`
    SELECT id, parent_id AS "parentId", name, smart_filter_json AS "smartFilterJson",
      system_key AS "systemKey", created_at AS "createdAt", updated_at AS "updatedAt",
      deleted_at AS "deletedAt"
    FROM conversation_folders
    ${where}
  `;

  const readLive = Effect.fn("ConversationFolderService.readLive")(function* (id: string) {
    const [row] = yield* selectFolders(sql`WHERE id = ${id} AND deleted_at IS NULL`).pipe(
      Effect.mapError(storageFailed),
    );
    if (row === undefined) return yield* failWith("not_found");
    return row;
  });

  const readFolders = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed([])
      : selectFolders(sql`WHERE ${sql.in("id", ids)}`).pipe(
          Effect.map((rows) => rows.map(toFolder)),
          Effect.mapError(storageFailed),
        );

  const liveFolders = selectFolders(sql`WHERE deleted_at IS NULL`).pipe(
    Effect.mapError(storageFailed),
  );

  const depthOf = (rows: ReadonlyArray<FolderRow>, id: string | null) => {
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    let depth = 0;
    for (let current = id; current !== null; depth += 1) {
      current = byId.get(current)?.parentId ?? null;
    }
    return depth;
  };

  /** Levels from `id` down to its deepest live descendant, counting `id`. */
  const subtreeOf = (rows: ReadonlyArray<FolderRow>, id: string) => {
    const children = Map.groupBy(rows, (row) => row.parentId);
    const ids: Array<string> = [];
    const visit = (current: string, level: number): number => {
      ids.push(current);
      return Math.max(
        level,
        ...(children.get(current) ?? []).map((child) => visit(child.id, level + 1)),
      );
    };
    const height = visit(id, 1);
    return { ids, height };
  };

  const mapUniqueName = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "UniqueViolation" ? failWith("name_taken") : storageFailed(),
      ),
    );

  const requireHoldable = Effect.fn("ConversationFolderService.requireHoldable")(function* (
    id: string,
  ) {
    const row = yield* readLive(id);
    if (row.smartFilterJson !== null) return yield* failWith("smart_folder");
    return row;
  });

  const newId = crypto.randomUUIDv4().pipe(
    Effect.map((id) => ConversationFolderId.make(id)),
    Effect.mapError(storageFailed),
  );

  const placeThreads = Effect.fn("ConversationFolderService.placeThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    folderId: ConversationFolderId | null,
  ) {
    const now = yield* nowIso;
    yield* sql
      .withTransaction(
        folderId === null
          ? sql`DELETE FROM conversation_folder_threads WHERE ${sql.in("thread_id", threadIds)}`.pipe(
              Effect.asVoid,
            )
          : Effect.forEach(
              threadIds,
              (threadId) => sql`
                INSERT INTO conversation_folder_threads (thread_id, folder_id, filed_at)
                VALUES (${threadId}, ${folderId}, ${now})
                ON CONFLICT (thread_id)
                DO UPDATE SET folder_id = excluded.folder_id, filed_at = excluded.filed_at
              `,
              { discard: true },
            ),
      )
      .pipe(Effect.mapError(storageFailed));
    yield* PubSub.publish(events, { type: "threads-moved", threadIds, folderId });
  });

  const publishFolders = Effect.fn("ConversationFolderService.publishFolders")(function* (
    ids: ReadonlyArray<string>,
  ) {
    const folders = yield* readFolders(ids);
    yield* PubSub.publish(events, { type: "folders-updated", folders });
    return folders;
  });

  const pruneDeleted = sql`
    DELETE FROM conversation_folders WHERE id IN (
      SELECT id FROM conversation_folders WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC LIMIT -1 OFFSET ${RETAINED_DELETED_FOLDERS}
    )
  `.pipe(Effect.mapError(storageFailed));

  const apply = Effect.fn("ConversationFolderService.apply")(function* (
    mutation: ConversationFolderMutation,
  ): Effect.fn.Return<ConversationFolderMutationResult, ConversationFolderError> {
    const now = yield* nowIso;
    switch (mutation.type) {
      case "create": {
        const rows = yield* liveFolders;
        const parentId = mutation.parentId ?? null;
        if (parentId !== null) yield* requireHoldable(parentId);
        if (depthOf(rows, parentId) + 1 > CONVERSATION_FOLDER_MAX_DEPTH) {
          return yield* failWith("too_deep");
        }
        const id = yield* newId;
        yield* mapUniqueName(sql`
          INSERT INTO conversation_folders ${sql.insert({
            id,
            parent_id: parentId,
            name: mutation.name,
            smart_filter_json:
              mutation.smartFilter === undefined ? null : encodeSmartFilter(mutation.smartFilter),
            system_key: null,
            created_at: now,
            updated_at: now,
            deleted_at: null,
          })}
        `);
        const [folder] = yield* publishFolders([id]);
        return folder === undefined ? {} : { folder };
      }
      case "rename": {
        yield* readLive(mutation.id);
        yield* mapUniqueName(sql`
          UPDATE conversation_folders SET name = ${mutation.name}, updated_at = ${now}
          WHERE id = ${mutation.id}
        `);
        const [folder] = yield* publishFolders([mutation.id]);
        return folder === undefined ? {} : { folder };
      }
      case "move": {
        const rows = yield* liveFolders;
        yield* readLive(mutation.id);
        if (mutation.parentId !== null) yield* requireHoldable(mutation.parentId);
        const { ids, height } = subtreeOf(rows, mutation.id);
        if (mutation.parentId !== null && ids.includes(mutation.parentId)) {
          return yield* failWith("cycle");
        }
        if (depthOf(rows, mutation.parentId) + height > CONVERSATION_FOLDER_MAX_DEPTH) {
          return yield* failWith("too_deep");
        }
        yield* mapUniqueName(sql`
          UPDATE conversation_folders SET parent_id = ${mutation.parentId}, updated_at = ${now}
          WHERE id = ${mutation.id}
        `);
        const [folder] = yield* publishFolders([mutation.id]);
        return folder === undefined ? {} : { folder };
      }
      case "delete": {
        const rows = yield* liveFolders;
        yield* readLive(mutation.id);
        const { ids } = subtreeOf(rows, mutation.id);
        // One timestamp marks the subtree, so restore brings back exactly what this removed.
        yield* sql`
          UPDATE conversation_folders SET deleted_at = ${now}, updated_at = ${now}
          WHERE ${sql.in("id", ids)}
        `.pipe(Effect.mapError(storageFailed));
        yield* pruneDeleted;
        yield* publishFolders(ids);
        return {};
      }
      case "restore": {
        const [row] = yield* selectFolders(sql`WHERE id = ${mutation.id}`).pipe(
          Effect.mapError(storageFailed),
        );
        if (row === undefined || row.deletedAt === null) return yield* failWith("not_found");
        const deletedTogether = yield* selectFolders(sql`WHERE deleted_at = ${row.deletedAt}`).pipe(
          Effect.mapError(storageFailed),
        );
        const { ids } = subtreeOf(deletedTogether, mutation.id);
        const live = new Set((yield* liveFolders).map((folder) => folder.id));
        const parentId = row.parentId !== null && live.has(row.parentId) ? row.parentId : null;
        yield* mapUniqueName(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE conversation_folders SET deleted_at = NULL, updated_at = ${now}
                WHERE ${sql.in("id", ids)}
              `;
              yield* sql`
                UPDATE conversation_folders SET parent_id = ${parentId} WHERE id = ${mutation.id}
              `;
            }),
          ),
        );
        const folders = yield* publishFolders(ids);
        const folder = folders.find((candidate) => candidate.id === mutation.id);
        return folder === undefined ? {} : { folder };
      }
      case "move-threads": {
        if (mutation.folderId !== null) yield* requireHoldable(mutation.folderId);
        yield* placeThreads(mutation.threadIds, mutation.folderId);
        return {};
      }
      case "set-thread-tags": {
        const tags = [...new Set(mutation.tags)];
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM conversation_thread_tags WHERE thread_id = ${mutation.threadId}`;
              yield* Effect.forEach(
                tags,
                (tag) => sql`
                  INSERT INTO conversation_thread_tags (thread_id, tag)
                  VALUES (${mutation.threadId}, ${tag})
                `,
                { discard: true },
              );
            }),
          )
          .pipe(Effect.mapError(storageFailed));
        yield* PubSub.publish(events, {
          type: "tags-updated",
          threadId: mutation.threadId,
          tags,
        });
        return {};
      }
    }
  });

  const mutate: ConversationFolderService["Service"]["mutate"] = Effect.fn(
    "ConversationFolderService.mutate",
  )(function* (mutation, actor = USER_ACTOR) {
    const result = yield* apply(mutation);
    const id = "id" in mutation ? mutation.id : result.folder?.id;
    yield* audit.record({
      actor: actor.actor,
      ...(actor.actorLabel === undefined ? {} : { actorLabel: actor.actorLabel }),
      domain: "conversation-folders",
      action: mutation.type,
      outcome: "succeeded",
      ...(id === undefined ? {} : { target: { kind: "folder", id } }),
      ...(mutation.type === "move-threads"
        ? { result: `${mutation.threadIds.length} conversations` }
        : {}),
    });
    return result;
  });

  const snapshot: ConversationFolderService["Service"]["snapshot"] = Effect.gen(function* () {
    const folders = yield* selectFolders(sql`ORDER BY name COLLATE NOCASE`);
    const placements = yield* sql<{ readonly folderId: string; readonly threadId: string }>`
      SELECT folder_id AS "folderId", thread_id AS "threadId" FROM conversation_folder_threads
    `;
    const tags = yield* sql<{ readonly threadId: string; readonly tag: string }>`
      SELECT thread_id AS "threadId", tag FROM conversation_thread_tags ORDER BY tag
    `;
    return {
      folders: folders.map(toFolder),
      placements: [...Map.groupBy(placements, (row) => row.folderId)].map(([folderId, rows]) => ({
        folderId: ConversationFolderId.make(folderId),
        threadIds: rows.map((row) => row.threadId as ThreadId),
      })),
      tags: [...Map.groupBy(tags, (row) => row.threadId)].map(([threadId, rows]) => ({
        threadId: threadId as ThreadId,
        tags: rows.map(
          (row) => row.tag as ConversationFolderSnapshot["tags"][number]["tags"][number],
        ),
      })),
    };
  }).pipe(Effect.mapError(storageFailed), Effect.withSpan("ConversationFolderService.snapshot"));

  const subscribe: ConversationFolderService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading: a delta already in the snapshot replays harmlessly.
      const subscription = yield* PubSub.subscribe(events);
      return Stream.concat(
        Stream.fromEffect(
          snapshot.pipe(Effect.map((value) => ({ type: "snapshot", snapshot: value }) as const)),
        ),
        Stream.fromSubscription(subscription),
      );
    }),
  );

  const fileScheduledRun: ConversationFolderService["Service"]["fileScheduledRun"] = Effect.fn(
    "ConversationFolderService.fileScheduledRun",
  )(function* (threadId) {
    const [existing] = yield* selectFolders(sql`WHERE system_key = 'scheduled'`).pipe(
      Effect.mapError(storageFailed),
    );
    const now = yield* nowIso;
    let folderId: ConversationFolderId;
    if (existing === undefined) {
      folderId = yield* newId;
      yield* sql`
        INSERT INTO conversation_folders ${sql.insert({
          id: folderId,
          parent_id: null,
          name: SCHEDULED_FOLDER_NAME,
          smart_filter_json: null,
          system_key: "scheduled",
          created_at: now,
          updated_at: now,
          deleted_at: null,
        })}
        ON CONFLICT DO NOTHING
      `.pipe(Effect.mapError(storageFailed));
      // A folder the user named Scheduled keeps its name; ours waits for the user to rename one.
      const [row] = yield* selectFolders(sql`WHERE system_key = 'scheduled'`).pipe(
        Effect.mapError(storageFailed),
      );
      if (row === undefined) {
        const [named] = yield* selectFolders(
          sql`WHERE parent_id IS NULL AND name = ${SCHEDULED_FOLDER_NAME} COLLATE NOCASE AND deleted_at IS NULL`,
        ).pipe(Effect.mapError(storageFailed));
        if (named === undefined) return yield* storageFailed();
        yield* sql`
          UPDATE conversation_folders SET system_key = 'scheduled', updated_at = ${now}
          WHERE id = ${named.id}
        `.pipe(Effect.mapError(storageFailed));
        folderId = ConversationFolderId.make(named.id);
      } else {
        folderId = ConversationFolderId.make(row.id);
      }
    } else {
      folderId = ConversationFolderId.make(existing.id);
      if (existing.deletedAt !== null) {
        yield* sql`
          UPDATE conversation_folders SET deleted_at = NULL, parent_id = NULL, updated_at = ${now}
          WHERE id = ${folderId}
        `.pipe(Effect.mapError(storageFailed));
      }
    }
    const [folder] = yield* publishFolders([folderId]);
    if (folder === undefined) return yield* storageFailed();
    yield* placeThreads([threadId], folderId);
    return folder;
  });

  return ConversationFolderService.of({ snapshot, subscribe, mutate, fileScheduledRun });
});

export const layer = Layer.effect(ConversationFolderService, make);
