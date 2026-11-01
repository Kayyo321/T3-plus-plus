import {
  GUEST_NAME_MAX_LENGTH,
  GUEST_ROUTE_PREFIX,
  GUEST_SHARE_PARAM,
  GuestMessageId,
  type GuestRedeemRequest,
  type GuestShareView,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useReducer, useState, type FormEvent } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import type { MessagesTimelineHistoryControls } from "../chat/MessagesTimeline";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  applyGuestStreamEvent,
  formatGuestExpiry,
  guestThreadRoutes,
  initialGuestStreamState,
  inviteShareId,
  type GuestStreamState,
  parseGuestStreamEvent,
  type SharedThreadRoutes,
} from "./guestStream.logic";
import {
  SHARED_THREAD_LANE,
  SharedNotice as Notice,
  SharedThreadComposer,
  SharedThreadTimeline,
  useSharedThreadHistory,
} from "./SharedThreadView";

interface GuestEntry {
  /** Unspent invite from the URL hash, if this load came from a link. */
  readonly credential: string | null;
  readonly shareId: string | null;
}

let capturedEntry: GuestEntry | null = null;

// A reload keeps the tab's session, so it keeps which messages still wait for a row too.
const AWAITING_ROWS_KEY = "t3:guest-awaiting-rows";
const AWAITING_ROWS_LIMIT = 50;

function readAwaitingRowIds(): ReadonlySet<GuestMessageId> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(AWAITING_ROWS_KEY) ?? "[]");
    return new Set(
      Array.isArray(stored)
        ? stored.filter((id) => typeof id === "string").map((id) => GuestMessageId.make(id))
        : [],
    );
  } catch {
    return new Set();
  }
}

function writeAwaitingRowIds(ids: ReadonlySet<GuestMessageId>) {
  try {
    sessionStorage.setItem(AWAITING_ROWS_KEY, JSON.stringify([...ids].slice(-AWAITING_ROWS_LIMIT)));
  } catch {}
}

/**
 * The invite credential travels in the URL hash so it never reaches a server log. It is read
 * once and removed from history, so it lives only in memory. Opening the page never redeems it:
 * only submitting a name does, so a reload before that leaves the link usable.
 */
function takeGuestEntry(): GuestEntry {
  if (capturedEntry === null) {
    // A malformed fragment is an invalid link, not a crash.
    let credential = "";
    try {
      credential = decodeURIComponent(window.location.hash.slice(1)).trim();
    } catch {}
    const shareId =
      credential !== ""
        ? inviteShareId(credential)
        : new URLSearchParams(window.location.search).get(GUEST_SHARE_PARAM);
    // The share stays in the URL, so a reload or bookmark finds this browser's session for it.
    window.history.replaceState(
      window.history.state,
      "",
      shareId === null
        ? window.location.pathname
        : `${window.location.pathname}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
    );
    capturedEntry = { credential: credential === "" ? null : credential, shareId };
  }
  return capturedEntry;
}

const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));
/** Resolves to null on success, or to a message the guest can read. */
async function postGuest(
  path: "redeem" | `messages?${string}`,
  body: typeof GuestRedeemRequest.Encoded | FormData,
): Promise<string | null> {
  try {
    const response = await fetch(
      `${GUEST_ROUTE_PREFIX}/${path}`,
      body instanceof FormData
        ? { method: "POST", body }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (response.ok) return null;
    const json: unknown = await response.json().catch(() => null);
    return Option.match(decodeErrorBody(json), {
      onNone: () => "Something went wrong. Try again.",
      onSome: ({ message }) => message,
    });
  } catch {
    return "Could not reach the server.";
  }
}

type GuestAccess = "checking" | "session" | "name" | "none";

export function GuestPage() {
  const [{ credential, shareId }] = useState(takeGuestEntry);
  // A browser that already joined this share goes straight back in, even from the spent link.
  // Sessions are per share, so one for another link never stands in for this one.
  const [access, setAccess] = useState<GuestAccess>(shareId === null ? "none" : "checking");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches whether this browser already has a guest session and ignores the answer after cleanup
  useEffect(() => {
    if (shareId === null) return;
    let live = true;
    void fetch(`${GUEST_ROUTE_PREFIX}/session?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`)
      .then(
        (response): GuestAccess =>
          response.ok ? "session" : credential !== null ? "name" : "none",
        // Offline: an invite still needs the name form; without one, the stream reports what
        // it finds once the network is back.
        (): GuestAccess => (credential !== null ? "name" : "session"),
      )
      .then((next) => {
        if (live) setAccess(next);
      });
    return () => {
      live = false;
    };
  }, [credential, shareId]);
  // Pasting another guest link into this tab changes only the hash, which does not reload the
  // page; reload so the new invite is read instead of the one already captured.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hashchange listener reloads the page when another guest link is pasted into this tab
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {access === "checking" ? (
        <Notice title="Connecting..." />
      ) : access === "name" && credential !== null ? (
        <NameForm
          credential={credential}
          onJoined={() => {
            // The invite is spent; a remount must open the session, not the name form again.
            capturedEntry = { credential: null, shareId };
            setAccess("session");
          }}
        />
      ) : access === "session" && shareId !== null ? (
        <GuestSession shareId={shareId} />
      ) : (
        <Notice
          title="This link has ended or is not valid"
          detail="Ask the owner for a new link. Each link works in one browser."
        />
      )}
    </div>
  );
}

function GuestSession({ shareId }: { readonly shareId: string }) {
  const [routes] = useState(() => guestThreadRoutes(shareId));
  const [stream, dispatch] = useReducer(applyGuestStreamEvent<GuestShareView>, null, () => ({
    ...initialGuestStreamState,
    awaitingRowIds: readAwaitingRowIds(),
  }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- persists the awaiting row ids to sessionStorage so a reload keeps them
  useEffect(() => writeAwaitingRowIds(stream.awaitingRowIds), [stream.awaitingRowIds]);
  // EventSource closes for good only on a non-200 response, which the guest routes send for a
  // missing, invalid, or ended session. Network drops reconnect on their own.
  const [rejected, setRejected] = useState(false);

  const historyControls = useSharedThreadHistory({
    historyCursor: stream.historyCursor,
    routes,
    onPage: (cursor, page) => dispatch({ type: "history-page", cursor, page }),
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets document.title to the shared thread's title
  useEffect(() => {
    if (stream.view) document.title = stream.view.title;
  }, [stream.view]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the guest EventSource stream and closes it on cleanup
  useEffect(() => {
    const source = new EventSource(
      `${GUEST_ROUTE_PREFIX}/stream?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`,
    );
    source.addEventListener("message", (message) => {
      const event = parseGuestStreamEvent(message.data);
      if (event === null) return;
      dispatch(event);
      if (event.type === "ended") source.close();
    });
    source.addEventListener("error", () => {
      if (source.readyState === EventSource.CLOSED) setRejected(true);
    });
    return () => source.close();
  }, [shareId]);

  if (stream.ended || (rejected && stream.view !== null)) {
    return <Notice title="This link has ended" detail="The owner stopped sharing this thread." />;
  }
  if (stream.view !== null) {
    if (stream.projection === null) return <Notice title="Connecting..." />;
    return (
      <GuestThread
        routes={routes}
        view={stream.view}
        projection={stream.projection}
        awaitingRowIds={stream.awaitingRowIds}
        historyControls={historyControls}
      />
    );
  }
  if (!rejected) return <Notice title="Connecting..." />;
  return (
    <Notice
      title="This link has ended or is not valid"
      detail="Ask the owner for a new link. Each link works in one browser."
    />
  );
}

function NameForm({
  credential,
  onJoined,
}: {
  readonly credential: string;
  readonly onJoined: () => void;
}) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "" || submitting) return;
    setSubmitting(true);
    const failure = await postGuest("redeem", { credential, name: trimmed });
    setSubmitting(false);
    if (failure === null) onJoined();
    else setError(failure);
  };
  return (
    <form className="m-auto flex w-full max-w-xs flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Join a shared thread</h1>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="guest-name">
        Your name
        <Input
          id="guest-name"
          autoFocus
          autoComplete="name"
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || name.trim() === ""}>
        Join
      </Button>
      <p className="text-xs text-muted-foreground">
        The owner sees your name and approves each message before the agent gets it.
      </p>
    </form>
  );
}

function GuestThread({
  routes,
  view: { shareId, title, expiresAt, messages, model },
  projection,
  awaitingRowIds,
  historyControls,
}: {
  readonly routes: SharedThreadRoutes;
  readonly view: GuestShareView;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly awaitingRowIds: GuestStreamState["awaitingRowIds"];
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
}) {
  const send = async (text: string, files: ReadonlyArray<File>) => {
    const form = new FormData();
    form.append("shareId", shareId);
    form.append("text", text);
    for (const file of files) form.append("file", file, file.name);
    return postGuest(`messages?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}`, form);
  };
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
        <ExpiryLabel expiresAt={expiresAt} />
      </header>
      {/* No ":" so the timeline finds no environment thread behind the key. */}
      <SharedThreadTimeline
        threadKey={`guest-${shareId}`}
        projection={projection}
        routes={routes}
        messages={messages}
        awaitingRowIds={awaitingRowIds}
        historyControls={historyControls}
      />
      <div className={cn(SHARED_THREAD_LANE, "shrink-0 pb-4")}>
        <SharedThreadComposer model={model} hint="The owner approves each message" onSend={send} />
      </div>
    </>
  );
}

function ExpiryLabel({ expiresAt }: { readonly expiresAt: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {formatGuestExpiry(expiresAt, Date.parse(`${nowMinute}Z`))}
    </span>
  );
}
