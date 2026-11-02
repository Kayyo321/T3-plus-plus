import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CONVERSATION_FOLDER_MAX_DEPTH,
  type ConversationFolderId,
  ConversationFolderMutation,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ConversationFolderService from "./ConversationFolderService.ts";

const TestLayer = ConversationFolderService.layer.pipe(
  Layer.provideMerge(AuditTrail.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const service = ConversationFolderService.ConversationFolderService;
const threadA = ThreadId.make("thread-folder-a");
const threadB = ThreadId.make("thread-folder-b");
const threadChat = ThreadId.make("thread-folder-chat");
const decodeMutation = Schema.decodeSync(ConversationFolderMutation);

const create = (
  name: string,
  parentId: ConversationFolderId | null = null,
  capabilityMode?: "chat",
) =>
  service.pipe(
    Effect.flatMap((folders) =>
      folders.mutate({
        type: "create",
        name: name as never,
        parentId,
        ...(capabilityMode === undefined ? {} : { capabilityMode }),
      }),
    ),
    Effect.map((result) => result.folder!.id),
  );

/** Filing reads a thread's mode from the V2 projection, so the fixture writes one there. */
const insertThread = (threadId: ThreadId, capabilityMode?: "chat") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const payload = JSON.stringify({
      id: threadId,
      ...(capabilityMode === undefined ? {} : { capabilityMode }),
    });
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      ) VALUES (
        ${threadId}, 'project-1', ${threadId}, 'codex', 'full-access', 'default',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ${payload}
      )
    `;
  });

const mutate = (mutation: ConversationFolderMutation) =>
  service.pipe(Effect.flatMap((folders) => folders.mutate(mutation)));

const live = service.pipe(
  Effect.flatMap((folders) => folders.snapshot),
  Effect.map((snapshot) => snapshot.folders.filter((folder) => folder.deletedAt === null)),
);

const threadsIn = (folderId: ConversationFolderId) =>
  service.pipe(
    Effect.flatMap((folders) => folders.snapshot),
    Effect.map(
      (snapshot) =>
        snapshot.placements.find((placement) => placement.folderId === folderId)?.threadIds ?? [],
    ),
  );

it.layer(TestLayer)("ConversationFolderService", (it) => {
  it.effect("deleting a folder keeps its conversations and restore brings the subtree back", () =>
    Effect.gen(function* () {
      const parent = yield* create("Work");
      const child = yield* create("Client", parent);
      yield* mutate({ type: "move-threads", threadIds: [threadA, threadB], folderId: child });

      yield* mutate({ type: "delete", id: parent });
      assert.notInclude(
        (yield* live).map((folder) => folder.id),
        parent,
      );
      assert.notInclude(
        (yield* live).map((folder) => folder.id),
        child,
      );
      assert.sameMembers([...(yield* threadsIn(child))], [threadA, threadB]);

      yield* mutate({ type: "restore", id: parent });
      const restored = (yield* live).find((folder) => folder.id === child);
      assert.strictEqual(restored?.parentId, parent);
      assert.sameMembers([...(yield* threadsIn(child))], [threadA, threadB]);
    }),
  );

  it.effect("restores to the root when the old parent is gone", () =>
    Effect.gen(function* () {
      const parent = yield* create("Gone");
      const child = yield* create("Kept", parent);
      yield* mutate({ type: "delete", id: child });
      yield* mutate({ type: "delete", id: parent });
      yield* mutate({ type: "restore", id: child });
      assert.isNull((yield* live).find((folder) => folder.id === child)?.parentId);
    }),
  );

  it.effect("refuses a move into its own subtree and past the depth limit", () =>
    Effect.gen(function* () {
      let parent = yield* create("Depth 1");
      const top = parent;
      for (let depth = 2; depth <= CONVERSATION_FOLDER_MAX_DEPTH; depth += 1) {
        parent = yield* create(`Depth ${depth}`, parent);
      }
      const folders = yield* service;
      const tooDeep = yield* folders
        .mutate({ type: "create", name: "Too deep" as never, parentId: parent })
        .pipe(Effect.flip);
      assert.strictEqual(tooDeep.reason, "too_deep");
      const cycle = yield* mutate({ type: "move", id: top, parentId: parent }).pipe(Effect.flip);
      assert.strictEqual(cycle.reason, "cycle");

      const shallow = yield* create("Two levels");
      yield* create("Inner", shallow);
      const subtreeTooDeep = yield* mutate({ type: "move", id: shallow, parentId: parent }).pipe(
        Effect.flip,
      );
      assert.strictEqual(subtreeTooDeep.reason, "too_deep");
    }),
  );

  it.effect("refuses a sibling with the same name, whatever its case", () =>
    Effect.gen(function* () {
      const parent = yield* create("Names");
      yield* create("Inbox", parent);
      const folders = yield* service;
      const error = yield* folders
        .mutate({ type: "create", name: "INBOX" as never, parentId: parent })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "name_taken");
    }),
  );

  it.effect("smart folders hold no conversations", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      const { folder } = yield* folders.mutate({
        type: "create",
        name: "Running" as never,
        parentId: null,
        smartFilter: { statuses: ["running"] },
      });
      assert.deepStrictEqual(folder?.smartFilter, { statuses: ["running"] });
      const error = yield* mutate({
        type: "move-threads",
        threadIds: [threadA],
        folderId: folder!.id,
      }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "smart_folder");
    }),
  );

  it.effect("a create without parentId files the folder at the top level", () =>
    Effect.gen(function* () {
      const { folder } = yield* mutate(decodeMutation({ type: "create", name: "Top level" }));
      assert.strictEqual(folder?.name, "Top level");
      assert.isNull(folder?.parentId);
    }),
  );

  it.effect("files scheduled runs in one folder, restoring it if the user deleted it", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      const first = yield* folders.fileScheduledRun(threadA);
      assert.strictEqual(first.systemKey, "scheduled");
      assert.strictEqual(first.name, "Scheduled");
      yield* mutate({ type: "delete", id: first.id });
      const second = yield* folders.fileScheduledRun(threadB);
      assert.strictEqual(second.id, first.id);
      assert.isNull(second.deletedAt);
      assert.includeMembers([...(yield* threadsIn(first.id))], [threadA, threadB]);
    }),
  );

  it.effect("adopts a folder the user already named Scheduled", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      const snapshot = yield* folders.snapshot;
      const existing = snapshot.folders.find((folder) => folder.systemKey === "scheduled");
      assert.isDefined(existing, "the previous case made one");
      const adopted = yield* folders.fileScheduledRun(threadA);
      assert.strictEqual(adopted.id, existing?.id);
    }),
  );

  it.effect("streams a snapshot, then only what changed", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      const events = yield* folders.subscribe.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );
      const folderId = yield* create("Streamed");
      yield* mutate({ type: "move-threads", threadIds: [threadA], folderId });
      const [snapshot, created, moved] = yield* Fiber.join(events);
      assert.strictEqual(snapshot?.type, "snapshot");
      assert.strictEqual(created?.type, "folders-updated");
      assert.deepStrictEqual(moved, { type: "threads-moved", threadIds: [threadA], folderId });
    }),
  );

  it.effect("sets tags as a whole and clears them", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      yield* mutate({
        type: "set-thread-tags",
        threadId: threadA,
        tags: ["billing", "billing", "urgent"] as never,
      });
      const tagged = (yield* folders.snapshot).tags.find((entry) => entry.threadId === threadA);
      assert.deepStrictEqual(tagged?.tags, ["billing", "urgent"]);
      yield* mutate({ type: "set-thread-tags", threadId: threadA, tags: [] });
      assert.isUndefined(
        (yield* folders.snapshot).tags.find((entry) => entry.threadId === threadA),
      );
    }),
  );

  it.effect("refuses to file a conversation in a folder of the other mode", () =>
    Effect.gen(function* () {
      yield* insertThread(threadChat, "chat");
      const codeFolder = yield* create("Mode filing code");
      const chatFolder = yield* create("Mode filing chat", null, "chat");
      const wrong = yield* mutate({
        type: "move-threads",
        threadIds: [threadChat],
        folderId: codeFolder,
      }).pipe(Effect.flip);
      assert.strictEqual(wrong.reason, "wrong_mode");
      const mixed = yield* mutate({
        type: "move-threads",
        threadIds: [threadA, threadChat],
        folderId: chatFolder,
      }).pipe(Effect.flip);
      assert.strictEqual(mixed.reason, "wrong_mode");
      assert.deepStrictEqual([...(yield* threadsIn(chatFolder))], []);

      yield* mutate({ type: "move-threads", threadIds: [threadChat], folderId: chatFolder });
      assert.deepStrictEqual([...(yield* threadsIn(chatFolder))], [threadChat]);
      yield* mutate({ type: "move-threads", threadIds: [threadChat], folderId: null });
      assert.deepStrictEqual([...(yield* threadsIn(chatFolder))], []);
    }),
  );

  it.effect("refuses to nest a folder under a parent of the other mode", () =>
    Effect.gen(function* () {
      const chatParent = yield* create("Mode nest chat", null, "chat");
      const codeFolder = yield* create("Mode nest code");
      const wrong = yield* mutate({
        type: "move",
        id: codeFolder,
        parentId: chatParent,
      }).pipe(Effect.flip);
      assert.strictEqual(wrong.reason, "wrong_mode");
      const chatChild = yield* create("Mode nest chat child", null, "chat");
      yield* mutate({ type: "move", id: chatChild, parentId: chatParent });
      const moved = (yield* live).find((folder) => folder.id === chatChild);
      assert.strictEqual(moved?.parentId, chatParent);
    }),
  );

  it.effect("gives a subfolder its parent's mode, whatever was asked for", () =>
    Effect.gen(function* () {
      const folders = yield* service;
      const { folder: top } = yield* folders.mutate({
        type: "create",
        name: "Mode inherit" as never,
      });
      assert.strictEqual(top?.capabilityMode, "code");
      const chatTop = yield* create("Mode inherit chat", null, "chat");
      const { folder: child } = yield* folders.mutate({
        type: "create",
        name: "Mode inherit child" as never,
        parentId: chatTop,
        capabilityMode: "code",
      });
      assert.strictEqual(child?.capabilityMode, "chat");
      const snapshot = yield* folders.snapshot;
      assert.strictEqual(
        snapshot.folders.find((folder) => folder.id === child?.id)?.capabilityMode,
        "chat",
      );
    }),
  );

  it.effect("allows the same top-level name once per mode", () =>
    Effect.gen(function* () {
      yield* create("Mode shared");
      yield* create("Mode shared", null, "chat");
      const folders = yield* service;
      const error = yield* folders
        .mutate({
          type: "create",
          name: "Mode shared" as never,
          parentId: null,
          capabilityMode: "chat",
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "name_taken");
    }),
  );
});
