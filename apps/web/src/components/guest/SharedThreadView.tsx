import {
  EnvironmentId,
  GUEST_MESSAGE_MAX_LENGTH,
  type GuestMessageId,
  type GuestThreadModel,
  OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadProjection,
  type ThreadGuestMessage,
  type ThreadGuestMessageStatus,
} from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { formatAttachmentSize } from "@t3tools/client-runtime/state/attachments";
import {
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadStructureRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import { ArrowUpIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { useIncrementalTimelineEntries } from "~/hooks/useIncrementalTimelineEntries";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { deriveActiveWorkStartedAt, derivePhase } from "~/session-logic";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { GuestMessageAttachments } from "../chat/GuestMessageAttachments";
import { HostImageUrlContext } from "../chat/hostImageUrl";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import { GuestMessageName, guestBubbleClassName } from "../chat/guestMessageStyle";
import { MessagesTimeline, type MessagesTimelineHistoryControls } from "../chat/MessagesTimeline";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getDisplayModelName, getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { ScrollToEndButton } from "../chat/TimelineOverlays";
import type { TimelineRow } from "../chat/timelineRowContext";
import { useTimelineFollow } from "../chat/useTimelineFollow";
import { Button } from "../ui/button";
import { GuestHtmlRender } from "./GuestHtmlRender";
import {
  createSharedAttachmentUrls,
  guestFilesProblem,
  type SharedThreadRoutes,
  unplacedGuestMessages,
} from "./guestStream.logic";
import { sharedTurnItemSource } from "./guestTurnItemSource";

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
const decodeHistoryPage = Schema.decodeUnknownOption(
  Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
);

/** Resolves to the page, or to a message the reader can read. */
async function fetchHistoryPage(url: string): Promise<OrchestrationV2ThreadHistoryPage | string> {
  const failed = "Could not load earlier turns. Try again.";
  try {
    const response = await fetch(url);
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return Option.match(decodeErrorBody(json), {
        onNone: () => failed,
        onSome: ({ message }) => message,
      });
    }
    return Option.getOrElse(decodeHistoryPage(json), () => failed);
  } catch {
    return "Could not reach the server.";
  }
}

/** "Load earlier turns", for a page that holds its thread in the shared stream reducer. */
export function useSharedThreadHistory(input: {
  readonly historyCursor: string | null;
  readonly routes: SharedThreadRoutes;
  readonly onPage: (cursor: string, page: OrchestrationV2ThreadHistoryPage) => void;
}): MessagesTimelineHistoryControls | undefined {
  const { historyCursor, routes, onPage } = input;
  const [historyLoad, setHistoryLoad] = useState<{
    readonly cursor: string;
    readonly error: string | null;
  } | null>(null);
  // A load for an older cursor is stale: a page or a reconnect snapshot moved the cursor on.
  const currentLoad = historyLoad?.cursor === historyCursor ? historyLoad : null;
  const loadingHistory = currentLoad !== null && currentLoad.error === null;
  const historyError = currentLoad?.error ?? null;
  const loadEarlier = async () => {
    if (historyCursor === null || loadingHistory) return;
    setHistoryLoad({ cursor: historyCursor, error: null });
    const result = await fetchHistoryPage(routes.history(historyCursor));
    if (typeof result === "string") setHistoryLoad({ cursor: historyCursor, error: result });
    else onPage(historyCursor, result);
  };
  return historyCursor === null
    ? undefined
    : {
        hasMoreHistory: true,
        loading: loadingHistory,
        error: historyError,
        onLoadEarlier: () => void loadEarlier(),
      };
}

/** Same column as the owner's timeline, so both views wrap text at the same width. */
export const SHARED_THREAD_LANE = "chat-content-lane px-4";

export function SharedNotice({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="m-auto flex max-w-sm flex-col gap-1 p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      {children}
    </div>
  );
}

const STATUS_LABEL: Record<ThreadGuestMessageStatus, string> = {
  pending: "Waiting for approval",
  sent: "Sent",
  dismissed: "Not sent",
};

// The timeline needs an environment id to key its rows. Nothing behind it loads on these pages;
// see isGuestPage.
const SHARED_ENVIRONMENT_ID = EnvironmentId.make("guest");
const NO_TURN_DIFFS: ReadonlyArray<never> = [];
const NO_OPTIMISTIC_MESSAGES: ReadonlyArray<never> = [];
const ignore = () => {};

const BUBBLE =
  "flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl p-3 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]";

const openInNewTab = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
/** These pages have no image viewer; the browser shows the picture in its own tab. */
const openExpandedImage = (preview: ExpandedImagePreview) => {
  const src = preview.images[preview.index]?.src;
  if (src) openInNewTab(src);
};

/**
 * The owner's timeline, read-only: every action that would reach the owner's machine (fork,
 * revert, diffs, files, other threads, shell) is left out, so its control does not render.
 */
export function SharedThreadTimeline({
  threadKey,
  projection,
  routes,
  messages,
  awaitingRowIds,
  historyControls,
}: {
  readonly threadKey: string;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly routes: SharedThreadRoutes;
  readonly messages: ReadonlyArray<ThreadGuestMessage>;
  readonly awaitingRowIds: ReadonlySet<GuestMessageId>;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
}) {
  const listRef = useRef<LegendListRef | null>(null);
  const { resolvedTheme } = useTheme();
  // The rest is what ChatView derives from the same projection.
  const [projectQuestionHistory] = useState(() => createQuestionHistoryProjector());
  const items = projectQuestionHistory(projection);
  // Files load through the page's own routes.
  const [attachmentUrls] = useState(() => createSharedAttachmentUrls(routes.attachment));
  // Expanded rows read detail and command output through the same routes.
  const [turnItemSource] = useState(() => sharedTurnItemSource(routes));
  const attachmentUrlById = attachmentUrls(items);
  const entries = useIncrementalTimelineEntries(threadKey, {
    visibleTurnItems: items,
    optimisticMessages: NO_OPTIMISTIC_MESSAGES,
    attachmentUrlById,
    attempts: projection.attempts,
    nodes: projection.nodes,
    plans: projection.plans,
  });
  const openFile = useStableCallback((file: { readonly id: string }) =>
    openInNewTab(routes.attachment(file.id)),
  );
  const hostImageUrl = useStableCallback((path: string) => routes.media(path));
  const activityRun = deriveThreadActivityRun(projection);
  const runtime = deriveThreadStructureRuntime(projection);
  const runlessWorkStartedAt = deriveRunlessWorkStartedAt(projection);
  const isWorking = derivePhase(runtime) === "running" || runlessWorkStartedAt !== null;
  const workStartedAt =
    deriveActiveWorkStartedAt(activityRun, runtime, null) ?? runlessWorkStartedAt;
  const runningRunId = runtime?.activeRunId ?? null;
  const follow = useTimelineFollow({
    legendListRef: listRef,
    composerTimelineInset: 0,
    routeThreadKey: threadKey,
    activeThreadKey: threadKey,
    // Not a server thread: new turns follow the end instead of anchoring near the top.
    isServerThread: false,
    serverProjection: null,
    threadStatus: "live",
    activeActivityRun: activityRun,
    activeRunningTurnId: runningRunId,
    timelineEntries: entries,
    timelineAnchorMessageId: null,
    setTimelineAnchor: ignore,
  });
  const renderHtmlRender = useStableCallback(
    (row: Extract<TimelineRow, { kind: "html-render" }>) => (
      <GuestHtmlRender renderUrl={routes.render(row.id)} reference={row.htmlRender} />
    ),
  );
  const unplaced = unplacedGuestMessages(messages, items, awaitingRowIds);
  // The reader's waiting messages sit in the list footer, which the list does not follow on its
  // own (the owner's view does the same in ChatView). A new one is the reader's own send, so it
  // comes into view even if they had scrolled up, as the owner's send does. While following, the
  // footer stays in view as it grows, such as when its images load.
  const unplacedKey = unplaced.map((message) => message.id).join(",");
  const previousUnplacedKey = useRef(unplacedKey);
  const following = useRef(follow.timelineLiveFollowEnabled);
  const scrollToEnd = useStableCallback(follow.scrollToEnd);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the timeline to the end after commit when new unplaced messages appear
  useEffect(() => {
    following.current = follow.timelineLiveFollowEnabled;
    const previous = new Set(previousUnplacedKey.current.split(","));
    previousUnplacedKey.current = unplacedKey;
    if (unplacedKey.split(",").some((id) => id !== "" && !previous.has(id))) scrollToEnd(true);
  }, [follow.timelineLiveFollowEnabled, unplacedKey, scrollToEnd, following, previousUnplacedKey]);
  const footerRef = useRef<HTMLOListElement>(null);
  const hasFooter = unplaced.length > 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ResizeObserver on the footer keeps it scrolled into view while following
  useEffect(() => {
    const footer = footerRef.current;
    if (!hasFooter || footer === null) return;
    return observeResize(footer, () => {
      if (following.current) scrollToEnd();
    });
  }, [hasFooter, scrollToEnd, following]);
  return (
    <div className="relative min-h-0 flex-1">
      <HostImageUrlContext value={hostImageUrl}>
        <MessagesTimeline
          listRef={listRef}
          timelineEntries={entries}
          isWorking={isWorking}
          activeTurnStartedAt={workStartedAt}
          latestRun={activityRun}
          runningRunId={runningRunId}
          turnDiffSummaries={NO_TURN_DIFFS}
          runs={projection.runs}
          routeThreadKey={threadKey}
          onOpenThread={ignore}
          supportsConversationRollback={false}
          onRevertToTurnCount={ignore}
          isRevertingCheckpoint={false}
          onImageExpand={openExpandedImage}
          onFileOpen={openFile}
          onFileDownload={openFile}
          renderHtmlRender={renderHtmlRender}
          turnItemSource={turnItemSource}
          historyControls={historyControls}
          activeThreadEnvironmentId={SHARED_ENVIRONMENT_ID}
          markdownCwd={undefined}
          resolvedTheme={resolvedTheme}
          timestampFormat="locale"
          workspaceRoot={undefined}
          anchorMessageId={null}
          onAnchorReady={ignore}
          onAnchorSizeChanged={ignore}
          contentInsetEndAdjustment={0}
          emptyPlaceholderInset={0}
          liveFollowEnabled={follow.timelineLiveFollowEnabled}
          onIsAtEndChange={follow.onIsAtEndChangeStable}
          onViewportAttach={follow.attachTimelineViewport}
          footer={
            unplaced.length === 0 ? null : (
              <ol ref={footerRef} className="chat-content-lane flex flex-col gap-4 pb-4">
                {unplaced.map((message) => (
                  <li key={message.id}>
                    <UnplacedMessage routes={routes} message={message} />
                  </li>
                ))}
              </ol>
            )
          }
        />
      </HostImageUrlContext>
      {follow.showScrollToBottom ? (
        <ScrollToEndButton
          summary={null}
          bottom={4}
          onScrollToEnd={() => follow.scrollToEnd(true)}
        />
      ) : null}
    </div>
  );
}

/** A message the owner has not sent yet, or chose not to send. */
function UnplacedMessage({
  routes,
  message,
}: {
  readonly routes: SharedThreadRoutes;
  readonly message: ThreadGuestMessage;
}) {
  // A dismissed message's files are deleted, so only their names remain.
  const served = message.status !== "dismissed";
  const url = (attachment: { readonly id: string }) => routes.attachment(attachment.id);
  return (
    <div className="flex flex-col items-end gap-1">
      <GuestMessageName name={message.senderName ?? "You"} />
      <div
        className={cn(
          BUBBLE,
          guestBubbleClassName(message.status !== "sent"),
          message.status === "dismissed" ? "text-muted-foreground" : "text-message-foreground",
        )}
      >
        <GuestMessageAttachments
          attachments={message.attachments ?? []}
          imageUrl={(attachment) => (served ? url(attachment) : undefined)}
          onOpenImage={(attachment) => openInNewTab(url(attachment))}
          {...(served ? { fileHref: url } : {})}
        />
        {message.text ? <span>{message.text}</span> : null}
      </div>
      <p className="me-1 text-2xs text-muted-foreground">{STATUS_LABEL[message.status]}</p>
    </div>
  );
}

/** The thread's model, labeled as the owner's composer labels it, with no way to change it. */
function SharedModelLabel({ model }: { readonly model: GuestThreadModel }) {
  const label = getTriggerDisplayModelName({ slug: model.name, ...model }, model.driver);
  const fullLabel = getDisplayModelName({ slug: model.name, ...model });
  return (
    <ComposerControl
      render={<span />}
      aria-label={`Model: ${fullLabel}`}
      className="pointer-events-none min-w-0 shrink"
    >
      {model.driver === null ? null : (
        <ProviderInstanceIcon
          driverKind={model.driver}
          displayName={label}
          className="size-4"
          iconClassName="size-4"
        />
      )}
      <span className="min-w-0 truncate" data-chat-provider-model-picker-label="true">
        {label}
      </span>
    </ComposerControl>
  );
}

interface StagedFile {
  readonly key: string;
  readonly file: File;
}

/** A staged image's thumbnail; its object URL lives as long as the element. */
function StagedImage({ file }: { readonly file: File }) {
  return (
    <img
      alt={file.name}
      className="size-full object-cover"
      ref={(image) => {
        if (!image) return;
        const url = URL.createObjectURL(file);
        image.src = url;
        return () => URL.revokeObjectURL(url);
      }}
    />
  );
}

export function SharedThreadComposer({
  model,
  hint,
  controls,
  onStop,
  onSend,
}: {
  readonly model: GuestThreadModel;
  readonly hint: string;
  /** Takes the model label's place, for a reader who can change what it shows. */
  readonly controls?: ReactNode;
  /** Replaces Send while a run can be stopped and nothing is written. */
  readonly onStop?: (() => void) | undefined;
  /** Resolves to null on success, or to a message the reader can read. */
  readonly onSend: (text: string, files: ReadonlyArray<File>) => Promise<string | null>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReadonlyArray<StagedFile>>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextFileKey = useRef(0);
  const { resolvedTheme } = useTheme();
  const addFiles = (added: ReadonlyArray<File>) => {
    if (added.length === 0) return;
    const next = [
      ...files,
      ...added.map((file) => ({ key: `staged-${nextFileKey.current++}`, file })),
    ];
    const problem = guestFilesProblem(next.map((staged) => staged.file));
    setError(problem);
    if (problem === null) setFiles(next);
  };
  const send = async () => {
    const trimmed = text.trim();
    if ((trimmed === "" && files.length === 0) || sending) return;
    setSending(true);
    const sentFiles = files;
    const failure = await onSend(
      trimmed,
      sentFiles.map((staged) => staged.file),
    );
    setSending(false);
    setError(failure);
    // Keep anything typed or attached while the request was in flight.
    if (failure === null) {
      setText((current) => (current.trim() === trimmed ? "" : current));
      setFiles((current) => current.filter((staged) => !sentFiles.includes(staged)));
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same as the app composer: Enter sends, Shift+Enter adds a line, IME composition is left alone.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  // As in the app composer: pasted images attach, and other files attach when no text came along.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files);
    const hasImage = pasted.some((file) => file.type.startsWith("image/"));
    if (pasted.length === 0 || (!hasImage && event.clipboardData.getData("text/plain") !== "")) {
      return;
    }
    event.preventDefault();
    addFiles(pasted);
  };
  return (
    <form
      className="flex flex-col gap-2 rounded-3xl border border-border bg-card px-4 pt-3 pb-2.5 shadow-composer dark:shadow-composer-dark"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached files">
          {files.map((staged) => (
            <li
              key={staged.key}
              className="flex h-14 min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-border/80 bg-background/70 pe-1"
            >
              {staged.file.type.startsWith("image/") ? (
                <span className="size-14 shrink-0">
                  <StagedImage file={staged.file} />
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-2 ps-2 text-sm">
                  <PierreEntryIcon pathValue={staged.file.name} kind="file" theme={resolvedTheme} />
                  <span className="max-w-40 truncate">{staged.file.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatAttachmentSize(staged.file.size)}
                  </span>
                </span>
              )}
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${staged.file.name}`}
                onClick={() => {
                  setError(null);
                  setFiles((current) => current.filter((candidate) => candidate !== staged));
                }}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        aria-label="Message"
        placeholder="Message"
        rows={2}
        maxLength={GUEST_MESSAGE_MAX_LENGTH}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        className="max-h-60 min-h-12 w-full resize-none bg-transparent text-sm outline-none field-sizing-content placeholder:text-placeholder"
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          aria-label="Files to attach"
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            // The same file can be picked again after it is removed.
            event.target.value = "";
          }}
        />
        <ComposerControl aria-label="Attach files" onClick={() => fileInputRef.current?.click()}>
          <ComposerControlIcon icon={PaperclipIcon} />
        </ComposerControl>
        {controls ?? <SharedModelLabel model={model} />}
        {error !== null ? (
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">
            {error}
          </p>
        ) : (
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {controls === undefined ? hint : null}
          </p>
        )}
        {onStop !== undefined && text.trim() === "" && files.length === 0 ? (
          <button
            type="button"
            aria-label="Stop generation"
            onClick={onStop}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <rect x="2" y="2" width="8" height="8" rx="1.5" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send"
            disabled={sending || (text.trim() === "" && files.length === 0)}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-message-action text-message-action-foreground shadow-xs hover:bg-message-action-hover focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64"
          >
            <ArrowUpIcon aria-hidden className="size-4" />
          </button>
        )}
      </div>
    </form>
  );
}
