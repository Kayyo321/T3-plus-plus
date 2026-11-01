import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ConversationDocumentId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../../../audit/AuditTrail.ts";
import * as ConversationDocumentService from "../../../documents/ConversationDocumentService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as DocumentsHandlers from "./handlers.ts";
import { DocumentsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-chat");

const scope = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>, id = threadId) => ({
  environmentId: EnvironmentId.make("environment-documents"),
  requestNamespace: "provider:documents",
  thread: {
    threadId: id,
    providerSessionId: "provider:documents",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 0,
});

const documentsLayer = ConversationDocumentService.layer.pipe(
  Layer.provideMerge(AuditTrail.layer),
  Layer.provideMerge(Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({})),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const call = (
  caller: McpInvocationContext.McpInvocationScope,
  tool: keyof typeof DocumentsToolkit.tools,
  input: unknown,
) =>
  Effect.gen(function* () {
    const toolkit = yield* DocumentsToolkit;
    const results = yield* toolkit
      .handle(tool, input as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return results.at(-1)?.result;
  }).pipe(
    Effect.provide(McpToolAccess.HandlersLayer.layer(DocumentsHandlers.layer)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
  );

it.layer(documentsLayer)("document tools", (it) => {
  it.effect("reach a chat thread, whose only capability is documents", () =>
    Effect.gen(function* () {
      const chat = scope(["documents"]);
      const created = yield* call(chat, "document_create", { title: "Notes", content: "One" });
      expect(created).toMatchObject({ threadId, version: 1 });
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      expect((yield* documents.list(threadId)).documents[0]?.updatedBy).toBe("agent");
      const id = (yield* documents.list(threadId)).documents[0]!.id;
      yield* call(chat, "document_update", { id, expectedVersion: 1, content: "Two" });
      expect(yield* call(chat, "document_versions", { id })).toMatchObject({
        versions: [{ version: 2 }, { version: 1 }],
      });
      expect(yield* call(chat, "document_export", { id, version: 1 })).toMatchObject({
        markdown: expect.stringContaining("One"),
      });
      yield* call(chat, "document_restore_version", { id, version: 1 });
      expect((yield* documents.get({ id })).content).toBe("One");
      yield* call(chat, "document_delete", { id });
      expect((yield* documents.get({ id })).deletedAt).not.toBeNull();
      yield* call(chat, "document_restore", { id });
      expect((yield* documents.get({ id })).deletedAt).toBeNull();
    }),
  );

  it.effect("are refused without the capability", () =>
    Effect.gen(function* () {
      const failure = yield* call(scope(["orchestration"]), "document_list", {});
      expect(failure).toMatchObject({ code: "capability_denied" });
    }),
  );

  it.effect("cannot read or change another conversation's document", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const theirs = yield* documents.create({
        threadId: ThreadId.make("thread-other"),
        title: "Private",
        content: "Secret",
      });
      const chat = scope(["documents"]);
      const read = yield* call(chat, "document_read", { id: theirs.id });
      expect(read).toMatchObject({ code: "invalid_request" });
      const write = yield* call(chat, "document_update", {
        id: theirs.id,
        expectedVersion: 1,
        content: "Mine now",
      });
      expect(write).toMatchObject({ code: "invalid_request" });
      for (const tool of [
        "document_delete",
        "document_restore",
        "document_versions",
        "document_restore_version",
        "document_export",
      ] as const) {
        expect(yield* call(chat, tool, { id: theirs.id, version: 1 })).toMatchObject({
          code: "invalid_request",
        });
      }
      expect((yield* documents.get({ id: theirs.id })).content).toBe("Secret");
    }),
  );

  it.effect("report a stale write instead of overwriting the user's edit", () =>
    Effect.gen(function* () {
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      const created = yield* documents.create({ threadId, title: "Draft", content: "A" });
      yield* documents.update({ id: created.id, expectedVersion: 1, content: "User edit" });
      const failure = yield* call(scope(["documents"]), "document_update", {
        id: ConversationDocumentId.make(created.id),
        expectedVersion: 1,
        content: "Agent edit",
      });
      expect(failure).toMatchObject({ code: "invalid_request" });
      expect((yield* documents.get({ id: created.id })).content).toBe("User edit");
    }),
  );
});
