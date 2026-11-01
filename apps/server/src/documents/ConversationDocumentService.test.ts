import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CONVERSATION_DOCUMENT_VERSION_RETENTION,
  ConversationDocumentError,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as ConversationDocumentService from "./ConversationDocumentService.ts";

const writes: Array<{ relativePath: string; contents: string }> = [];
let existing = false;

const TestLayer = ConversationDocumentService.layer.pipe(
  Layer.provideMerge(AuditTrail.layer),
  Layer.provideMerge(
    Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({
      getMetadata: () => Effect.succeed({ entries: [existing ? { kind: "file" as const } : null] }),
      writeFile: (input) =>
        Effect.sync(() => {
          writes.push({ relativePath: input.relativePath, contents: input.contents });
          return { relativePath: input.relativePath };
        }),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const thread = (name: string) => ThreadId.make(`thread-${name}`);

it.layer(TestLayer)("ConversationDocumentService", (it) => {
  it.effect("keeps every saved version and restores an old one as the newest", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const first = yield* documents.create({
        threadId: thread("versions"),
        title: "Plan",
        content: "one",
      });
      const second = yield* documents.update(
        { id: first.id, expectedVersion: 1, content: "two" },
        { author: "agent" },
      );
      assert.strictEqual(second.version, 2);
      assert.strictEqual(second.updatedBy, "agent");

      const old = yield* documents.get({ id: first.id, version: 1 });
      assert.strictEqual(old.content, "one");

      const restored = yield* documents.restoreVersion({ id: first.id, version: 1 });
      assert.strictEqual(restored.version, 3);
      assert.strictEqual(restored.content, "one");

      const { versions } = yield* documents.listVersions({ id: first.id });
      assert.deepStrictEqual(
        versions.map(({ version, createdBy }) => [version, createdBy]),
        [
          [3, "user"],
          [2, "agent"],
          [1, "user"],
        ],
      );
    }),
  );

  it.effect("refuses a stale write and names the current version", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const created = yield* documents.create({
        threadId: thread("conflict"),
        title: "Notes",
        content: "base",
      });
      yield* documents.update({ id: created.id, expectedVersion: 1, content: "agent edit" });
      const error = yield* documents
        .update({ id: created.id, expectedVersion: 1, content: "my edit" })
        .pipe(Effect.flip);
      assert.instanceOf(error, ConversationDocumentError);
      assert.strictEqual(error.code, "version_conflict");
      assert.strictEqual(error.currentVersion, 2);
      assert.strictEqual((yield* documents.get({ id: created.id })).content, "agent edit");
    }),
  );

  it.effect("keeps only the newest versions", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const created = yield* documents.create({
        threadId: thread("retention"),
        title: "Long",
        content: "0",
      });
      for (let version = 1; version <= CONVERSATION_DOCUMENT_VERSION_RETENTION; version += 1) {
        yield* documents.update({
          id: created.id,
          expectedVersion: version,
          content: String(version),
        });
      }
      const { versions } = yield* documents.listVersions({ id: created.id });
      assert.strictEqual(versions.length, CONVERSATION_DOCUMENT_VERSION_RETENTION);
      assert.strictEqual(versions.at(-1)?.version, 2);
      const error = yield* documents.get({ id: created.id, version: 1 }).pipe(Effect.flip);
      assert.strictEqual(error.code, "not_found");
    }),
  );

  it.effect("deleting hides a document until it is restored", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const threadId = thread("delete");
      const created = yield* documents.create({ threadId, title: "Gone", content: "x" });
      yield* documents.remove({ id: created.id });
      assert.isFalse(yield* documents.hasDocuments(threadId));
      const refused = yield* documents
        .update({ id: created.id, expectedVersion: 1, content: "y" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "not_found");
      yield* documents.restore({ id: created.id });
      assert.isTrue(yield* documents.hasDocuments(threadId));
    }),
  );

  it.effect("exports Markdown under the document's title", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const threadId = thread("export");
      const plain = yield* documents.create({ threadId, title: "Launch Plan!", content: "Body" });
      assert.deepStrictEqual(yield* documents.exportMarkdown({ id: plain.id }), {
        fileName: "launch-plan.md",
        markdown: "# Launch Plan!\n\nBody\n",
      });
      const headed = yield* documents.create({
        threadId,
        title: "Spec",
        content: "# Spec\n\nBody",
      });
      assert.strictEqual(
        (yield* documents.exportMarkdown({ id: headed.id })).markdown,
        "# Spec\n\nBody\n",
      );
    }),
  );

  it.effect("moving refuses to replace a file unless told to, and records the copy", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const created = yield* documents.create({
        threadId: thread("move"),
        title: "Design",
        content: "Body",
      });
      const target = { id: created.id, cwd: "/work/app", relativePath: "docs/design.md" };
      existing = true;
      const refused = yield* documents.moveToProject(target).pipe(Effect.flip);
      assert.strictEqual(refused.code, "file_exists");
      assert.isFalse(writes.some((write) => write.relativePath === "docs/design.md"));

      const moved = yield* documents.moveToProject({ ...target, overwrite: true });
      existing = false;
      assert.strictEqual(moved.movedTo?.relativePath, "docs/design.md");
      assert.strictEqual(moved.movedTo?.version, 1);
      assert.strictEqual(writes.at(-1)?.contents, "# Design\n\nBody\n");
    }),
  );

  it.effect("hands each version to a code turn once", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const threadId = thread("carry");
      const created = yield* documents.create({ threadId, title: "Plan", content: "first" });

      const context = yield* documents.takeTurnContext(threadId);
      assert.include(context ?? "", "first");
      assert.include(context ?? "", 'title="Plan"');
      assert.isNull(yield* documents.takeTurnContext(threadId));

      yield* documents.update({ id: created.id, expectedVersion: 1, content: "second" });
      assert.include((yield* documents.takeTurnContext(threadId)) ?? "", "second");
    }),
  );

  it.effect("records who changed a document", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const audit = yield* AuditTrail.AuditTrail;
      const threadId = thread("audit");
      yield* documents.create({ threadId, title: "Audited", content: "" }, { author: "agent" });
      const { entries } = yield* audit.list({ domain: "documents", limit: 1 });
      assert.strictEqual(entries[0]?.actor, "agent");
      assert.strictEqual(entries[0]?.action, "document.create");
    }),
  );
});
