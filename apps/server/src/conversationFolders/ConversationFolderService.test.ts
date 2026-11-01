import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CONVERSATION_FOLDER_MAX_DEPTH,
  type ConversationFolderId,
  type ConversationFolderMutation,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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

const create = (name: string, parentId: ConversationFolderId | null = null) =>
  service.pipe(
    Effect.flatMap((folders) => folders.mutate({ type: "create", name: name as never, parentId })),
    Effect.map((result) => result.folder!.id),
  );

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
});
