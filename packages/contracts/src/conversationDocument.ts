import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectWriteFileInput } from "./project.ts";

/** @public */
export const CONVERSATION_DOCUMENT_MAX_CHARS = 256_000;
export const CONVERSATION_DOCUMENT_MAX_PER_THREAD = 100;
export const CONVERSATION_DOCUMENT_VERSION_RETENTION = 100;
const DOCUMENT_TITLE_MAX_CHARS = 200;

export const ConversationDocumentId = TrimmedNonEmptyString.pipe(
  Schema.brand("ConversationDocumentId"),
);
export type ConversationDocumentId = typeof ConversationDocumentId.Type;

const DocumentVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const DocumentTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(DOCUMENT_TITLE_MAX_CHARS));

const DocumentContent = Schema.String.check(Schema.isMaxLength(CONVERSATION_DOCUMENT_MAX_CHARS));

export const ConversationDocumentAuthor = Schema.Literals(["user", "agent"]);
export type ConversationDocumentAuthor = typeof ConversationDocumentAuthor.Type;

export const ConversationDocumentCopy = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString,
  version: DocumentVersion,
  at: IsoDateTime,
});
export type ConversationDocumentCopy = typeof ConversationDocumentCopy.Type;

export const ConversationDocumentSummary = Schema.Struct({
  id: ConversationDocumentId,
  threadId: ThreadId,
  title: DocumentTitle,
  version: DocumentVersion,
  charCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedBy: ConversationDocumentAuthor,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  /** The last time this document was written into a project. */
  movedTo: Schema.NullOr(ConversationDocumentCopy),
});
export type ConversationDocumentSummary = typeof ConversationDocumentSummary.Type;

export const ConversationDocument = Schema.Struct({
  ...ConversationDocumentSummary.fields,
  content: Schema.String,
});
export type ConversationDocument = typeof ConversationDocument.Type;

export const ConversationDocumentVersionSummary = Schema.Struct({
  documentId: ConversationDocumentId,
  version: DocumentVersion,
  title: DocumentTitle,
  charCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdBy: ConversationDocumentAuthor,
  createdAt: IsoDateTime,
});
export type ConversationDocumentVersionSummary = typeof ConversationDocumentVersionSummary.Type;

export const ConversationDocumentListInput = Schema.Struct({ threadId: ThreadId });
export type ConversationDocumentListInput = typeof ConversationDocumentListInput.Type;

export const ConversationDocumentListResult = Schema.Struct({
  documents: Schema.Array(ConversationDocumentSummary),
});
export type ConversationDocumentListResult = typeof ConversationDocumentListResult.Type;

export const ConversationDocumentGetInput = Schema.Struct({
  id: ConversationDocumentId,
  version: Schema.optional(DocumentVersion).annotate({ description: "Default: the latest." }),
});
export type ConversationDocumentGetInput = typeof ConversationDocumentGetInput.Type;

export const ConversationDocumentCreateInput = Schema.Struct({
  threadId: ThreadId,
  title: DocumentTitle,
  content: DocumentContent,
});
export type ConversationDocumentCreateInput = typeof ConversationDocumentCreateInput.Type;

export const ConversationDocumentUpdateInput = Schema.Struct({
  id: ConversationDocumentId,
  expectedVersion: DocumentVersion.annotate({
    description: "The version you read. A newer one refuses the write.",
  }),
  title: Schema.optional(DocumentTitle),
  content: Schema.optional(DocumentContent),
});
export type ConversationDocumentUpdateInput = typeof ConversationDocumentUpdateInput.Type;

export const ConversationDocumentIdInput = Schema.Struct({ id: ConversationDocumentId });
export type ConversationDocumentIdInput = typeof ConversationDocumentIdInput.Type;

export const ConversationDocumentRestoreVersionInput = Schema.Struct({
  id: ConversationDocumentId,
  version: DocumentVersion,
});
export type ConversationDocumentRestoreVersionInput =
  typeof ConversationDocumentRestoreVersionInput.Type;

export const ConversationDocumentListVersionsResult = Schema.Struct({
  versions: Schema.Array(ConversationDocumentVersionSummary),
});
export type ConversationDocumentListVersionsResult =
  typeof ConversationDocumentListVersionsResult.Type;

export const ConversationDocumentExportInput = ConversationDocumentGetInput;
export type ConversationDocumentExportInput = typeof ConversationDocumentExportInput.Type;

export const ConversationDocumentExportResult = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  markdown: Schema.String,
});
export type ConversationDocumentExportResult = typeof ConversationDocumentExportResult.Type;

/** Only a person moves a document into a project: no MCP tool reaches this. */
export const ConversationDocumentMoveToProjectInput = Schema.Struct({
  id: ConversationDocumentId,
  cwd: ProjectWriteFileInput.fields.cwd,
  relativePath: ProjectWriteFileInput.fields.relativePath,
  overwrite: Schema.optional(Schema.Boolean),
});
export type ConversationDocumentMoveToProjectInput =
  typeof ConversationDocumentMoveToProjectInput.Type;

export const ConversationDocumentErrorCode = Schema.Literals([
  "not_found",
  "version_conflict",
  "limit_reached",
  "file_exists",
  "storage",
]);
export type ConversationDocumentErrorCode = typeof ConversationDocumentErrorCode.Type;

export class ConversationDocumentError extends Schema.TaggedError<ConversationDocumentError>()(
  "ConversationDocumentError",
  {
    code: ConversationDocumentErrorCode,
    message: Schema.String,
    /** The newest version, on a version conflict. */
    currentVersion: Schema.optional(DocumentVersion),
    cause: Schema.optional(Schema.Defect()),
  },
) {}
