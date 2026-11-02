import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadCapabilityMode } from "./providerPolicy.ts";

export const CONVERSATION_FOLDER_MAX_DEPTH = 8;
const CONVERSATION_FOLDER_BULK_MOVE_MAX = 1_000;
const CONVERSATION_THREAD_MAX_TAGS = 16;

export const ConversationFolderId = TrimmedNonEmptyString.pipe(
  Schema.brand("ConversationFolderId"),
);
export type ConversationFolderId = typeof ConversationFolderId.Type;

export const ConversationFolderName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type ConversationFolderName = typeof ConversationFolderName.Type;

export const ConversationTag = TrimmedNonEmptyString.check(Schema.isMaxLength(40));
export type ConversationTag = typeof ConversationTag.Type;

export const ConversationSmartStatus = Schema.Literals(["running", "needs-input"]);
export type ConversationSmartStatus = typeof ConversationSmartStatus.Type;

/** Clients evaluate this against the threads they already hold, so a filter costs no server work. */
export const ConversationSmartFilter = Schema.Struct({
  statuses: Schema.optional(Schema.Array(ConversationSmartStatus)),
  updatedWithinDays: Schema.optional(PositiveInt),
  tag: Schema.optional(ConversationTag),
});
export type ConversationSmartFilter = typeof ConversationSmartFilter.Type;

export const ConversationFolderSystemKey = Schema.Literals(["scheduled"]);
export type ConversationFolderSystemKey = typeof ConversationFolderSystemKey.Type;

export const ConversationFolder = Schema.Struct({
  id: ConversationFolderId,
  parentId: Schema.NullOr(ConversationFolderId),
  name: ConversationFolderName,
  smartFilter: Schema.optional(ConversationSmartFilter),
  systemKey: Schema.optional(ConversationFolderSystemKey),
  /** Absent means Code. */
  capabilityMode: Schema.optional(ThreadCapabilityMode),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set while it can be restored. Its conversations show as unfiled until then. */
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ConversationFolder = typeof ConversationFolder.Type;

export const ConversationFolderSnapshot = Schema.Struct({
  folders: Schema.Array(ConversationFolder),
  /** Only filed threads, grouped so thousands of them repeat each folder id once. */
  placements: Schema.Array(
    Schema.Struct({ folderId: ConversationFolderId, threadIds: Schema.Array(ThreadId) }),
  ),
  tags: Schema.Array(Schema.Struct({ threadId: ThreadId, tags: Schema.Array(ConversationTag) })),
});
export type ConversationFolderSnapshot = typeof ConversationFolderSnapshot.Type;

export const ConversationFolderStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: ConversationFolderSnapshot }),
  Schema.Struct({
    type: Schema.Literal("folders-updated"),
    folders: Schema.Array(ConversationFolder),
  }),
  Schema.Struct({
    type: Schema.Literal("threads-moved"),
    threadIds: Schema.Array(ThreadId),
    folderId: Schema.NullOr(ConversationFolderId),
  }),
  Schema.Struct({
    type: Schema.Literal("tags-updated"),
    threadId: ThreadId,
    tags: Schema.Array(ConversationTag),
  }),
]);
export type ConversationFolderStreamEvent = typeof ConversationFolderStreamEvent.Type;

export const ConversationFolderMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    name: ConversationFolderName,
    /** Omitted or null creates a top-level folder. */
    parentId: Schema.optionalKey(Schema.NullOr(ConversationFolderId)),
    smartFilter: Schema.optional(ConversationSmartFilter),
    /** Omitted means Code. A subfolder always takes its parent's mode. */
    capabilityMode: Schema.optionalKey(ThreadCapabilityMode),
  }),
  Schema.Struct({
    type: Schema.Literal("rename"),
    id: ConversationFolderId,
    name: ConversationFolderName,
  }),
  Schema.Struct({
    type: Schema.Literal("move"),
    id: ConversationFolderId,
    parentId: Schema.NullOr(ConversationFolderId),
  }),
  Schema.Struct({ type: Schema.Literal("delete"), id: ConversationFolderId }),
  Schema.Struct({ type: Schema.Literal("restore"), id: ConversationFolderId }),
  Schema.Struct({
    type: Schema.Literal("move-threads"),
    threadIds: Schema.Array(ThreadId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(CONVERSATION_FOLDER_BULK_MOVE_MAX),
    ),
    /** Null unfiles them. */
    folderId: Schema.NullOr(ConversationFolderId),
  }),
  Schema.Struct({
    type: Schema.Literal("set-thread-tags"),
    threadId: ThreadId,
    tags: Schema.Array(ConversationTag).check(Schema.isMaxLength(CONVERSATION_THREAD_MAX_TAGS)),
  }),
]);
export type ConversationFolderMutation = typeof ConversationFolderMutation.Type;

export const ConversationFolderMutationResult = Schema.Struct({
  folder: Schema.optional(ConversationFolder),
});
export type ConversationFolderMutationResult = typeof ConversationFolderMutationResult.Type;

export const ConversationFolderErrorReason = Schema.Literals([
  "not_found",
  "name_taken",
  "too_deep",
  "cycle",
  "smart_folder",
  "wrong_mode",
  "storage_failed",
]);
export type ConversationFolderErrorReason = typeof ConversationFolderErrorReason.Type;

const CONVERSATION_FOLDER_ERROR_MESSAGES: Record<ConversationFolderErrorReason, string> = {
  not_found: "That folder no longer exists.",
  name_taken: "This folder already holds a subfolder with that name.",
  too_deep: `Folders nest at most ${CONVERSATION_FOLDER_MAX_DEPTH} levels deep.`,
  cycle: "A folder cannot move inside itself.",
  smart_folder: "Smart folders show a saved filter and cannot hold conversations.",
  wrong_mode: "This folder belongs to the other mode.",
  storage_failed: "The folder change could not be saved.",
};

export class ConversationFolderError extends Schema.TaggedError<ConversationFolderError>()(
  "ConversationFolderError",
  { reason: ConversationFolderErrorReason },
) {
  override get message(): string {
    return CONVERSATION_FOLDER_ERROR_MESSAGES[this.reason];
  }
}
