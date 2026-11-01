import {
  CONVERSATION_DOCUMENT_MAX_PER_THREAD,
  CONVERSATION_DOCUMENT_VERSION_RETENTION,
  ConversationDocument,
  type ConversationDocumentAuthor,
  ConversationDocumentCopy,
  type ConversationDocumentCreateInput,
  ConversationDocumentError,
  type ConversationDocumentErrorCode,
  type ConversationDocumentExportInput,
  type ConversationDocumentExportResult,
  type ConversationDocumentGetInput,
  ConversationDocumentId,
  type ConversationDocumentIdInput,
  type ConversationDocumentListResult,
  type ConversationDocumentListVersionsResult,
  type ConversationDocumentMoveToProjectInput,
  type ConversationDocumentRestoreVersionInput,
  type ConversationDocumentUpdateInput,
  type ThreadId,
  ThreadId as ThreadIdSchema,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

/** Who changed a document, for its history and the audit trail. */
export interface DocumentActor {
  readonly author: ConversationDocumentAuthor;
  readonly label?: string;
}

const USER: DocumentActor = { author: "user" };

/** Headroom for the opening tag and notes around the documents in one turn. */
const TURN_CONTEXT_MAX_CHARS = 64_000;

const decodeCopy = Schema.decodeUnknownSync(Schema.fromJsonString(ConversationDocumentCopy));
const encodeCopy = Schema.encodeSync(Schema.fromJsonString(ConversationDocumentCopy));

interface DocumentRow {
  readonly document_id: string;
  readonly thread_id: string;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly carried_version: number;
  readonly updated_by: ConversationDocumentAuthor;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
  readonly moved_to_json: string | null;
}

const summaryOf = (row: DocumentRow) => ({
  id: ConversationDocumentId.make(row.document_id),
  threadId: ThreadIdSchema.make(row.thread_id),
  title: row.title,
  version: row.version,
  charCount: row.content.length,
  updatedBy: row.updated_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  movedTo: row.moved_to_json === null ? null : decodeCopy(row.moved_to_json),
});

const documentOf = (row: DocumentRow): ConversationDocument => ({
  ...summaryOf(row),
  content: row.content,
});

const failure = (code: ConversationDocumentErrorCode, message: string, cause?: unknown) =>
  new ConversationDocumentError({ code, message, ...(cause === undefined ? {} : { cause }) });

const storageFailure = (message: string) => (cause: unknown) => failure("storage", message, cause);

const notFound = () => failure("not_found", "That document no longer exists.");

function exportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${slug === "" ? "document" : slug}.md`;
}

/** A document that already opens with its title keeps its own heading. */
function exportMarkdown(title: string, content: string): string {
  const body = content.trimEnd();
  const first = body.trimStart().split("\n", 1)[0] ?? "";
  return /^#\s/.test(first) ? `${body}\n` : `# ${title}\n\n${body}\n`;
}

function turnContext(documents: ReadonlyArray<DocumentRow>): string {
  let remaining = TURN_CONTEXT_MAX_CHARS;
  const sections: string[] = [];
  for (const document of documents) {
    const content = document.content.slice(0, remaining);
    remaining -= content.length;
    const cut = content.length < document.content.length;
    sections.push(
      `<document id="${document.document_id}" title="${document.title.replaceAll('"', "'")}" version="${document.version}"${cut ? ' truncated="true"' : ""}>\n${content}\n</document>`,
    );
  }
  return [
    "<conversation-documents>",
    "Documents written earlier in this conversation. Treat them as background for this turn.",
    ...sections,
    "</conversation-documents>",
  ].join("\n");
}

export class ConversationDocumentService extends Context.Service<
  ConversationDocumentService,
  {
    readonly list: (
      threadId: ThreadId,
    ) => Effect.Effect<ConversationDocumentListResult, ConversationDocumentError>;
    /** The thread's document list now and after every change. */
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<ConversationDocumentListResult, ConversationDocumentError>;
    readonly get: (
      input: ConversationDocumentGetInput,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly create: (
      input: ConversationDocumentCreateInput,
      actor?: DocumentActor,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly update: (
      input: ConversationDocumentUpdateInput,
      actor?: DocumentActor,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    /** Hides a document. `restore` brings it back with its history. */
    readonly remove: (
      input: ConversationDocumentIdInput,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly restore: (
      input: ConversationDocumentIdInput,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly listVersions: (
      input: ConversationDocumentIdInput,
    ) => Effect.Effect<ConversationDocumentListVersionsResult, ConversationDocumentError>;
    /** Saves an old version as the newest one, so nothing is lost by going back. */
    readonly restoreVersion: (
      input: ConversationDocumentRestoreVersionInput,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly exportMarkdown: (
      input: ConversationDocumentExportInput,
    ) => Effect.Effect<ConversationDocumentExportResult, ConversationDocumentError>;
    /** Writes the document into a project. The document stays in the conversation. */
    readonly moveToProject: (
      input: ConversationDocumentMoveToProjectInput,
    ) => Effect.Effect<ConversationDocument, ConversationDocumentError>;
    readonly hasDocuments: (
      threadId: ThreadId,
    ) => Effect.Effect<boolean, ConversationDocumentError>;
    /** Documents a code turn has not seen yet, as prompt text. Each version is handed over once. */
    readonly takeTurnContext: (
      threadId: ThreadId,
    ) => Effect.Effect<string | null, ConversationDocumentError>;
    readonly deleteForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<void, ConversationDocumentError>;
  }
>()("t3pp/documents/ConversationDocumentService") {}

export const layer = Layer.effect(
  ConversationDocumentService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const audit = yield* AuditTrail.AuditTrail;
    const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    // Subscribers re-read the list, so a dropped signal is covered by the next one.
    const changes = yield* PubSub.sliding<ThreadId>(64);
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const findRow = (id: ConversationDocumentId) =>
      sql<DocumentRow>`SELECT * FROM conversation_documents WHERE document_id = ${id}`.pipe(
        NodeSqliteClient.readOnly,
        Effect.map((rows) => rows[0]),
        Effect.mapError(storageFailure("Could not read the document.")),
      );

    const loadRow = (id: ConversationDocumentId) =>
      findRow(id).pipe(Effect.filterOrFail((row) => row !== undefined, notFound));

    const record = (
      row: Pick<DocumentRow, "document_id" | "thread_id" | "title">,
      action: string,
      actor: DocumentActor,
    ) =>
      audit.record({
        actor: actor.author,
        ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
        domain: "documents",
        action,
        outcome: "succeeded",
        threadId: ThreadIdSchema.make(row.thread_id),
        target: { kind: "document", id: row.document_id, label: row.title },
      });

    const announce = (threadId: string) =>
      PubSub.publish(changes, ThreadIdSchema.make(threadId)).pipe(Effect.asVoid);

    const appendVersion = (input: {
      readonly id: string;
      readonly version: number;
      readonly title: string;
      readonly content: string;
      readonly author: ConversationDocumentAuthor;
      readonly at: string;
    }) =>
      sql`
        INSERT INTO conversation_document_versions
          (document_id, version, title, content, created_by, created_at)
        VALUES (
          ${input.id}, ${input.version}, ${input.title}, ${input.content},
          ${input.author}, ${input.at}
        )
      `.pipe(
        Effect.andThen(sql`
          DELETE FROM conversation_document_versions
          WHERE document_id = ${input.id}
            AND version <= ${input.version - CONVERSATION_DOCUMENT_VERSION_RETENTION}
        `),
      );

    const list: ConversationDocumentService["Service"]["list"] = Effect.fn(
      "ConversationDocumentService.list",
    )(function* (threadId) {
      const rows = yield* sql<DocumentRow>`
        SELECT * FROM conversation_documents WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, document_id ASC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not list documents.")),
      );
      return { documents: rows.map(summaryOf) };
    });

    const subscribe: ConversationDocumentService["Service"]["subscribe"] = (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading so a change in between is not missed.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list(threadId)),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((changed) => changed === threadId),
              Stream.mapEffect(() => list(threadId)),
            ),
          );
        }),
      );

    const get: ConversationDocumentService["Service"]["get"] = Effect.fn(
      "ConversationDocumentService.get",
    )(function* (input) {
      const row = yield* loadRow(input.id);
      if (input.version === undefined || input.version === row.version) return documentOf(row);
      const [version] = yield* sql<{
        readonly title: string;
        readonly content: string;
        readonly created_by: ConversationDocumentAuthor;
        readonly created_at: string;
      }>`
        SELECT title, content, created_by, created_at FROM conversation_document_versions
        WHERE document_id = ${input.id} AND version = ${input.version}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read that version.")),
      );
      if (version === undefined) {
        return yield* failure("not_found", `Version ${input.version} is no longer kept.`);
      }
      return documentOf({
        ...row,
        title: version.title,
        content: version.content,
        version: input.version,
        updated_by: version.created_by,
        updated_at: version.created_at,
      });
    });

    const create: ConversationDocumentService["Service"]["create"] = Effect.fn(
      "ConversationDocumentService.create",
    )(function* (input, actor = USER) {
      const at = yield* nowIso;
      const uuid = yield* crypto
        .randomUUIDv4()
        .pipe(Effect.mapError(storageFailure("Could not generate a document id.")));
      const id = ConversationDocumentId.make(`document:${uuid}`);
      const inserted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [count] = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM conversation_documents
              WHERE thread_id = ${input.threadId} AND deleted_at IS NULL
            `;
            if ((count?.count ?? 0) >= CONVERSATION_DOCUMENT_MAX_PER_THREAD) return false;
            yield* sql`
              INSERT INTO conversation_documents (
                document_id, thread_id, title, content, version, updated_by, created_at, updated_at
              ) VALUES (
                ${id}, ${input.threadId}, ${input.title}, ${input.content}, 1,
                ${actor.author}, ${at}, ${at}
              )
            `;
            yield* appendVersion({ ...input, id, version: 1, author: actor.author, at });
            return true;
          }),
        )
        .pipe(Effect.mapError(storageFailure("Could not save the document.")));
      if (!inserted) {
        return yield* failure(
          "limit_reached",
          `A conversation holds up to ${CONVERSATION_DOCUMENT_MAX_PER_THREAD} documents.`,
        );
      }
      const row = yield* loadRow(id);
      yield* record(row, "document.create", actor);
      yield* announce(row.thread_id);
      return documentOf(row);
    });

    /** Compares the version in the write, so two editors cannot both win. */
    const writeVersion = Effect.fn("ConversationDocumentService.writeVersion")(function* (input: {
      readonly id: ConversationDocumentId;
      readonly expectedVersion: number;
      readonly title: string;
      readonly content: string;
      readonly actor: DocumentActor;
      readonly action: string;
    }) {
      const at = yield* nowIso;
      const version = input.expectedVersion + 1;
      const written = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const updated = yield* sql<{ readonly document_id: string }>`
              UPDATE conversation_documents
              SET title = ${input.title}, content = ${input.content}, version = ${version},
                  updated_by = ${input.actor.author}, updated_at = ${at}
              WHERE document_id = ${input.id} AND version = ${input.expectedVersion}
                AND deleted_at IS NULL
              RETURNING document_id
            `;
            if (updated.length === 0) return false;
            yield* appendVersion({
              id: input.id,
              version,
              title: input.title,
              content: input.content,
              author: input.actor.author,
              at,
            });
            return true;
          }),
        )
        .pipe(Effect.mapError(storageFailure("Could not save the document.")));
      const row = yield* loadRow(input.id);
      if (!written) {
        return yield* new ConversationDocumentError({
          code: row.deleted_at === null ? "version_conflict" : "not_found",
          message:
            row.deleted_at === null
              ? `This document is at version ${row.version}. Read it again before saving.`
              : "That document was deleted.",
          currentVersion: row.version,
        });
      }
      yield* record(row, input.action, input.actor);
      yield* announce(row.thread_id);
      return documentOf(row);
    });

    const update: ConversationDocumentService["Service"]["update"] = Effect.fn(
      "ConversationDocumentService.update",
    )(function* (input, actor = USER) {
      const row = yield* loadRow(input.id);
      return yield* writeVersion({
        id: input.id,
        expectedVersion: input.expectedVersion,
        title: input.title ?? row.title,
        content: input.content ?? row.content,
        actor,
        action: "document.update",
      });
    });

    const setDeleted = Effect.fn("ConversationDocumentService.setDeleted")(function* (
      id: ConversationDocumentId,
      deletedAt: string | null,
      action: string,
    ) {
      yield* sql`
        UPDATE conversation_documents SET deleted_at = ${deletedAt} WHERE document_id = ${id}
      `.pipe(Effect.mapError(storageFailure("Could not change the document.")));
      const row = yield* loadRow(id);
      yield* record(row, action, USER);
      yield* announce(row.thread_id);
      return documentOf(row);
    });

    const remove: ConversationDocumentService["Service"]["remove"] = Effect.fn(
      "ConversationDocumentService.remove",
    )(function* (input) {
      return yield* setDeleted(input.id, yield* nowIso, "document.delete");
    });

    const restore: ConversationDocumentService["Service"]["restore"] = Effect.fn(
      "ConversationDocumentService.restore",
    )(function* (input) {
      return yield* setDeleted(input.id, null, "document.restore");
    });

    const listVersions: ConversationDocumentService["Service"]["listVersions"] = Effect.fn(
      "ConversationDocumentService.listVersions",
    )(function* (input) {
      yield* loadRow(input.id);
      const rows = yield* sql<{
        readonly version: number;
        readonly title: string;
        readonly char_count: number;
        readonly created_by: ConversationDocumentAuthor;
        readonly created_at: string;
      }>`
        SELECT version, title, LENGTH(content) AS char_count, created_by, created_at
        FROM conversation_document_versions
        WHERE document_id = ${input.id}
        ORDER BY version DESC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read the document's history.")),
      );
      return {
        versions: rows.map((row) => ({
          documentId: input.id,
          version: row.version,
          title: row.title,
          charCount: row.char_count,
          createdBy: row.created_by,
          createdAt: row.created_at,
        })),
      };
    });

    const restoreVersion: ConversationDocumentService["Service"]["restoreVersion"] = Effect.fn(
      "ConversationDocumentService.restoreVersion",
    )(function* (input) {
      const current = yield* loadRow(input.id);
      const old = yield* get(input);
      return yield* writeVersion({
        id: input.id,
        expectedVersion: current.version,
        title: old.title,
        content: old.content,
        actor: USER,
        action: "document.restore-version",
      });
    });

    const exportDocument: ConversationDocumentService["Service"]["exportMarkdown"] = Effect.fn(
      "ConversationDocumentService.exportMarkdown",
    )(function* (input) {
      const document = yield* get(input);
      return {
        fileName: exportFileName(document.title),
        markdown: exportMarkdown(document.title, document.content),
      };
    });

    const moveToProject: ConversationDocumentService["Service"]["moveToProject"] = Effect.fn(
      "ConversationDocumentService.moveToProject",
    )(function* (input) {
      const row = yield* loadRow(input.id);
      if (input.overwrite !== true) {
        const { entries } = yield* files.getMetadata({
          paths: [path.resolve(input.cwd, input.relativePath)],
        });
        if (entries[0] != null) {
          return yield* failure("file_exists", `${input.relativePath} already exists.`);
        }
      }
      const written = yield* files
        .writeFile({
          cwd: input.cwd,
          relativePath: input.relativePath,
          contents: exportMarkdown(row.title, row.content),
        })
        .pipe(Effect.mapError((cause) => failure("storage", cause.message, cause)));
      const movedTo = encodeCopy({
        cwd: input.cwd,
        relativePath: written.relativePath,
        version: row.version,
        at: yield* nowIso,
      });
      yield* sql`
        UPDATE conversation_documents SET moved_to_json = ${movedTo} WHERE document_id = ${input.id}
      `.pipe(Effect.mapError(storageFailure("Could not record the move.")));
      const moved = yield* loadRow(input.id);
      yield* record(moved, "document.move-to-project", USER);
      yield* announce(moved.thread_id);
      return documentOf(moved);
    });

    const hasDocuments: ConversationDocumentService["Service"]["hasDocuments"] = Effect.fn(
      "ConversationDocumentService.hasDocuments",
    )(function* (threadId) {
      const rows = yield* sql`
        SELECT 1 FROM conversation_documents
        WHERE thread_id = ${threadId} AND deleted_at IS NULL LIMIT 1
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read documents.")),
      );
      return rows.length > 0;
    });

    const takeTurnContext: ConversationDocumentService["Service"]["takeTurnContext"] = Effect.fn(
      "ConversationDocumentService.takeTurnContext",
    )(function* (threadId) {
      const pending = yield* sql<DocumentRow>`
        SELECT * FROM conversation_documents
        WHERE thread_id = ${threadId} AND deleted_at IS NULL AND carried_version < version
        ORDER BY created_at ASC, document_id ASC
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read documents.")),
      );
      if (pending.length === 0) return null;
      yield* Effect.forEach(
        pending,
        (row) => sql`
          UPDATE conversation_documents SET carried_version = ${row.version}
          WHERE document_id = ${row.document_id}
        `,
        { discard: true },
      ).pipe(Effect.mapError(storageFailure("Could not record the handover.")));
      return turnContext(pending);
    });

    const deleteForThread: ConversationDocumentService["Service"]["deleteForThread"] = Effect.fn(
      "ConversationDocumentService.deleteForThread",
    )(function* (threadId) {
      yield* sql
        .withTransaction(
          sql`
            DELETE FROM conversation_document_versions WHERE document_id IN (
              SELECT document_id FROM conversation_documents WHERE thread_id = ${threadId}
            )
          `.pipe(
            Effect.andThen(sql`DELETE FROM conversation_documents WHERE thread_id = ${threadId}`),
          ),
        )
        .pipe(Effect.mapError(storageFailure("Could not delete the documents.")));
      yield* announce(threadId);
    });

    return ConversationDocumentService.of({
      list,
      subscribe,
      get,
      create,
      update,
      remove,
      restore,
      listVersions,
      restoreVersion,
      exportMarkdown: exportDocument,
      moveToProject,
      hasDocuments,
      takeTurnContext,
      deleteForThread,
    });
  }),
);
