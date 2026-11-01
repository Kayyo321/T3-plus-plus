import {
  type ConversationDocumentError,
  type ConversationDocumentId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ConversationDocumentService from "../../../documents/ConversationDocumentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DocumentsToolkit } from "./tools.ts";

const toFailure = (error: ConversationDocumentError) =>
  new OrchestratorMcpFailure({
    code: error.code === "storage" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

const documentCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.capabilities.has("documents"),
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "This conversation has no documents.",
      }),
  ),
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Documents")),
  Effect.map((scope) => scope.thread.threadId),
);

/** A document is reachable only from its own conversation. */
const ownDocument = Effect.fn("DocumentsToolkit.ownDocument")(function* (input: {
  readonly id: ConversationDocumentId;
  readonly version?: number | undefined;
}) {
  const threadId = yield* documentCaller;
  const documents = yield* ConversationDocumentService.ConversationDocumentService;
  const document = yield* documents.get(input).pipe(Effect.mapError(toFailure));
  if (document.threadId !== threadId) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "That document no longer exists.",
    });
  }
  return document;
});

export const layer = McpToolAccess.toLayer(DocumentsToolkit, {
  document_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* documentCaller;
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      return yield* documents.list(threadId).pipe(Effect.mapError(toFailure));
    }),
  ),
  document_read: McpToolAccess.readsAsCaller(ownDocument),
  document_create: McpToolAccess.writesOwnConversation((input) =>
    Effect.gen(function* () {
      const threadId = yield* documentCaller;
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      return yield* documents
        .create({ ...input, threadId }, { author: "agent" })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  document_update: McpToolAccess.writesOwnConversation((input) =>
    Effect.gen(function* () {
      yield* ownDocument({ id: input.id });
      const documents = yield* ConversationDocumentService.ConversationDocumentService;
      return yield* documents.update(input, { author: "agent" }).pipe(Effect.mapError(toFailure));
    }),
  ),
});
