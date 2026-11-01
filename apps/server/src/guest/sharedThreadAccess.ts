import {
  type ChatAttachment,
  ChatAttachmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type ThreadGuestMessage,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { chatMarkdownImageSources } from "@t3tools/shared/markdownPipeline";
import { htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
  threadHtmlRenderAttachmentIds,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  projectTurnItemForDetail,
  projectTurnItemForWire,
} from "../orchestration-v2/WireProjection.ts";
import {
  classifyGuestUploads,
  GUEST_UPLOAD_HEADER_BYTES,
  guestHostImageType,
  type GuestUpload,
  matchesImageSignature,
  repliesShowImage,
} from "./guestAttachments.ts";

// Reader records with no open stream whose sent image replies are still kept.
const SHARED_THREAD_REPLIES_LIMIT = 64;

/** Why a read of one shared thread, or a file sent to it, was refused. */
export class SharedThreadError extends Schema.TaggedError<SharedThreadError>()(
  "SharedThreadError",
  {
    reason: Schema.Literals([
      "unavailable",
      "rejected",
      "too_many_files",
      "too_large",
      "unsupported_file",
    ]),
  },
) {
  override get message(): string {
    return `The shared thread refused this request: ${this.reason}.`;
  }
}

const unavailable = new SharedThreadError({ reason: "unavailable" });
const uploadFailed = new SharedThreadError({ reason: "rejected" });

/** The thread record an event carries. */
export const threadOfEvent = (
  event: OrchestrationV2DomainEvent,
): OrchestrationV2AppThread | null => {
  switch (event.type) {
    case "thread.guest-share-updated":
    case "thread.metadata-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return event.payload;
    default:
      return null;
  }
};

/** A reply a reader's stream sent, with its image sources once a media request parsed them. */
interface SentReply {
  readonly text: string;
  sources?: ReadonlyArray<string>;
}

/**
 * What an outside reader of one thread can load, whichever credential let them in. Every method
 * takes an already authorized thread: credentials stay with the caller, and a thread is the widest
 * thing here.
 */
export const makeSharedThreadAccess = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const commandOutputs = yield* CommandOutputHub.CommandOutputHub;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;

  const removeStored = (attachments: ReadonlyArray<ChatAttachment>) =>
    Effect.forEach(
      attachments,
      (attachment) => {
        const path = resolveAttachmentPath({ attachmentsDir, attachment });
        return path === null
          ? Effect.void
          : fileSystem.remove(path, { force: true }).pipe(Effect.ignore);
      },
      { discard: true },
    );

  /**
   * Checks the files and stores them as the thread's attachments, so a message can wait longer
   * than the day the pending-upload sweep allows. Send uses them as they are; dismissing the
   * message or ending the share deletes them.
   */
  const storeUploads = Effect.fn("SharedThreadAccess.storeUploads")(function* (
    threadId: ThreadId,
    uploads: ReadonlyArray<GuestUpload>,
  ) {
    const inspected = yield* Effect.forEach(uploads, (upload) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(upload.path);
        const file = yield* fileSystem.open(upload.path, { flag: "r" });
        const header = Option.getOrElse(
          yield* file.readAlloc(GUEST_UPLOAD_HEADER_BYTES),
          () => new Uint8Array(),
        );
        return { ...upload, sizeBytes: Number(info.size), header };
      }).pipe(
        Effect.scoped,
        Effect.mapError(() => uploadFailed),
      ),
    );
    const classified = classifyGuestUploads(inspected);
    if (!classified.ok) return yield* new SharedThreadError({ reason: classified.reason });
    const stored: Array<ChatAttachment> = [];
    yield* Effect.forEach(
      classified.attachments,
      (draft, index) =>
        Effect.gen(function* () {
          const id = createAttachmentId(
            threadId,
            draft.type === "file" ? attachmentFileExtension(draft.name) : undefined,
          );
          if (id === null) return yield* uploadFailed;
          const attachment: ChatAttachment = { ...draft, id: ChatAttachmentId.make(id) };
          const path = resolveAttachmentPath({ attachmentsDir, attachment });
          if (path === null) return yield* uploadFailed;
          yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
          yield* fileSystem.copyFile(uploads[index]!.path, path);
          stored.push(attachment);
        }).pipe(Effect.mapError(() => uploadFailed)),
      { discard: true },
    ).pipe(Effect.onError(() => removeStored(stored)));
    return stored;
  });

  // The image replies each reader's stream has sent, in its opening snapshot or live, so an image
  // loads while the reader's page can show its reply, inherited ones included. A reader with an
  // open stream keeps its record; past the limit, closed ones are dropped.
  const sentImageReplies = new Map<
    string,
    { openStreams: number; readonly replies: Map<string, SentReply> }
  >();
  const sentRecord = (readerKey: string) => {
    let record = sentImageReplies.get(readerKey);
    if (record === undefined) {
      record = { openStreams: 0, replies: new Map() };
      sentImageReplies.set(readerKey, record);
      for (const [id, other] of sentImageReplies) {
        if (sentImageReplies.size <= SHARED_THREAD_REPLIES_LIMIT) break;
        if (other.openStreams === 0 && id !== readerKey) sentImageReplies.delete(id);
      }
    }
    return record;
  };
  const rememberSent = (readerKey: string, items: Iterable<OrchestrationV2TurnItem>) => {
    for (const item of items) {
      if (item.type !== "assistant_message") continue;
      const key = `${item.threadId}\u0000${item.id}`;
      // Only replies with image syntax can show an image. One edited to drop its images stops
      // allowing them.
      if (item.text.includes("![") || /<img/i.test(item.text)) {
        sentRecord(readerKey).replies.set(key, { text: item.text });
      } else {
        sentImageReplies.get(readerKey)?.replies.delete(key);
      }
    }
  };
  /** Counts an open stream for as long as the surrounding scope lives. */
  const holdSentRecord = (readerKey: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const record = sentRecord(readerKey);
        record.openStreams += 1;
        return record;
      }),
      (record) =>
        Effect.sync(() => {
          record.openStreams -= 1;
        }),
    );
  const hasSentRecord = (readerKey: string) => sentImageReplies.has(readerKey);

  const turnItem = Effect.fn("SharedThreadAccess.turnItem")(function* (
    threadId: ThreadId,
    itemId: string,
  ) {
    const item = yield* orchestrator
      .getTurnItem({ threadId, itemId: TurnItemId.make(itemId) })
      .pipe(Effect.mapError(() => unavailable));
    return item === null ? yield* unavailable : item;
  });

  const render = Effect.fn("SharedThreadAccess.render")(function* (
    threadId: ThreadId,
    itemId: string,
  ) {
    const item = yield* turnItem(threadId, itemId);
    if (item.type !== "dynamic_tool") return yield* unavailable;
    const reference = htmlRenderFromToolItem(item);
    const [attachmentId] = threadHtmlRenderAttachmentIds(threadId, [item]);
    const path =
      attachmentId === undefined
        ? null
        : resolveAttachmentPathById({ attachmentsDir, attachmentId });
    if (reference === undefined || path === null) return yield* unavailable;
    return { path, title: reference.title };
  });

  const item = Effect.fn("SharedThreadAccess.item")(function* (threadId: ThreadId, itemId: string) {
    const item = yield* turnItem(threadId, itemId);
    return {
      item:
        item.type === "file_change" ? projectTurnItemForWire(item) : projectTurnItemForDetail(item),
    };
  });

  const history = Effect.fn("SharedThreadAccess.history")(function* (
    threadId: ThreadId,
    cursor: string,
    readerKey: string,
  ) {
    const page = yield* orchestrator
      .getThreadHistoryPage(threadId, cursor)
      .pipe(Effect.mapError(() => unavailable));
    rememberSent(
      readerKey,
      page.items.map((row) => row.item),
    );
    return page;
  });

  /** A command's output frames until the command settles or `until` completes. */
  const commandOutput = Effect.fn("SharedThreadAccess.commandOutput")(function* <E, R>(
    threadId: ThreadId,
    itemId: string,
    until: Effect.Effect<unknown, E, R>,
  ) {
    const item = yield* turnItem(threadId, itemId);
    if (item.type !== "command_execution") return yield* unavailable;
    return commandOutputs.subscribe({ threadId, itemId: item.id }).pipe(
      // A lost hub stream ends the output; the row reloads it when reopened.
      Stream.catchCause(() => Stream.empty),
      Stream.interruptWhen(until),
    );
  });

  /** A file in the thread or one of the given waiting messages, never a dismissed one's. */
  const attachment = Effect.fn("SharedThreadAccess.attachment")(function* (
    threadId: ThreadId,
    messages: ReadonlyArray<ThreadGuestMessage>,
    attachmentId: string,
  ) {
    // A dismissed message's files are deleted with it.
    const fromShare = messages
      .flatMap((message) => (message.status === "dismissed" ? [] : (message.attachments ?? [])))
      .find((candidate) => candidate.id === attachmentId);
    const found =
      fromShare ??
      (yield* orchestrator.getThreadRecords(threadId, ["messages"]).pipe(
        Effect.map(({ messages: threadMessages }) =>
          threadMessages
            .flatMap((message) => message.attachments ?? [])
            .find((candidate) => candidate.id === attachmentId),
        ),
        Effect.mapError(() => unavailable),
      ));
    const path =
      found === undefined ? null : resolveAttachmentPath({ attachmentsDir, attachment: found });
    if (found === undefined || path === null) return yield* unavailable;
    const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
    return exists ? { path, attachment: found } : yield* unavailable;
  });

  /** An image on the host that an agent reply this reader's stream sent shows, and its type. */
  const media = Effect.fn("SharedThreadAccess.media")(function* (readerKey: string, path: string) {
    const mimeType = guestHostImageType(path);
    if (mimeType === null) return yield* unavailable;
    const sent = sentImageReplies.get(readerKey)?.replies.values() ?? [];
    // Each sent reply is parsed once, on the first request that needs it.
    if (
      !repliesShowImage(
        path,
        [...sent],
        (reply) => (reply.sources ??= chatMarkdownImageSources(reply.text)),
      )
    ) {
      return yield* unavailable;
    }
    // The bytes must be the image the name says, as for a guest's own upload.
    const header = yield* fileSystem.open(path, { flag: "r" }).pipe(
      Effect.flatMap((file) => file.readAlloc(GUEST_UPLOAD_HEADER_BYTES)),
      Effect.scoped,
      Effect.mapError(() => unavailable),
    );
    if (Option.isNone(header) || !matchesImageSignature(mimeType, header.value)) {
      return yield* unavailable;
    }
    return { path, mimeType };
  });

  return {
    removeStored,
    storeUploads,
    rememberSent,
    holdSentRecord,
    hasSentRecord,
    render,
    item,
    history,
    commandOutput,
    attachment,
    media,
  };
});
