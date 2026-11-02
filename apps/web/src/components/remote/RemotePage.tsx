import { RemoteComputerUse } from "./RemoteComputerUse";
import { RemoteComposerControls, remoteProvidersUrl } from "./RemoteConversationControls";
import { RemoteOrchestrator } from "./RemoteOrchestrator";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { derivePhase } from "~/session-logic";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import {
  derivePendingThreadRequests,
  type ThreadPendingApproval,
  type ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  GUEST_NAME_MAX_LENGTH,
  type GuestMessageId,
  type OrchestrationV2ThreadProjection,
  REMOTE_CONTROL_LEVEL_INFO,
  REMOTE_CONTROL_MESSAGES_ROUTE,
  REMOTE_CONTROL_MODE_ROUTE,
  REMOTE_CONTROL_MODEL_ROUTE,
  REMOTE_CONTROL_PAIR_CODE_ROUTE,
  REMOTE_CONTROL_PAIR_START_ROUTE,
  REMOTE_CONTROL_PAIR_STATUS_ROUTE,
  REMOTE_CONTROL_RENAME_ROUTE,
  REMOTE_CONTROL_RESPOND_ROUTE,
  REMOTE_CONTROL_SESSION_ROUTE,
  REMOTE_CONTROL_SIGN_OUT_ROUTE,
  REMOTE_CONTROL_STOP_ROUTE,
  REMOTE_CONTROL_SWITCH_PARAM,
  RemoteControlFailureBody,
  RemoteControlPairingProgress,
  type RemoteControlPermission,
  type RemoteControlView,
  remoteControlLevelAllows,
  type RuntimeRequestId,
  type ThreadCapabilityMode,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { LogOutIcon, MousePointer2Icon } from "lucide-react";
import { useEffect, useReducer, useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { MessagesTimelineHistoryControls } from "../chat/MessagesTimeline";
import { OrchestratorGlyph } from "../orchestrator/OrchestratorGlyph";
import { WORKSPACE_MODE_TABS } from "../sidebar/workspaceModeTabs";
import {
  SHARED_THREAD_LANE,
  SharedNotice,
  SharedThreadComposer,
  SharedThreadTimeline,
  useSharedThreadHistory,
} from "../guest/SharedThreadView";
import {
  applyRemoteStreamEvent,
  END_REASON_MESSAGES,
  formatRemaining,
  initialRemoteStreamState,
  linkSwitchId,
  OWNER_OFFLINE_AFTER_ATTEMPTS,
  parseRemoteStreamEvent,
  reconnectDelayMs,
  remoteStreamUrl,
  remoteThreadRoutes,
  streamEventSequence,
  suggestedDeviceLabel,
} from "./remoteStream.logic";

interface RemoteEntry {
  /** The unspent link from the URL hash, if this load came from one. */
  readonly credential: string | null;
  readonly switchId: string | null;
}

let capturedEntry: RemoteEntry | null = null;

/**
 * The link travels in the URL hash so it never reaches a server log. It is read once and removed
 * from history, so it lives only in memory. Opening the page never spends it: only choosing to
 * join does, so a preview that loads the page leaves the link usable.
 */
function takeRemoteEntry(): RemoteEntry {
  if (capturedEntry === null) {
    let credential = "";
    try {
      credential = decodeURIComponent(window.location.hash.slice(1)).trim();
    } catch {}
    const switchId =
      credential !== ""
        ? linkSwitchId(credential)
        : new URLSearchParams(window.location.search).get(REMOTE_CONTROL_SWITCH_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      switchId === null
        ? window.location.pathname
        : `${window.location.pathname}?${REMOTE_CONTROL_SWITCH_PARAM}=${encodeURIComponent(switchId)}`,
    );
    capturedEntry = { credential: credential === "" ? null : credential, switchId };
  }
  return capturedEntry;
}

const decodeFailure = Schema.decodeUnknownOption(Schema.toCodecJson(RemoteControlFailureBody));
const decodeProgress = Schema.decodeUnknownOption(Schema.toCodecJson(RemoteControlPairingProgress));

type RemoteFailure = typeof RemoteControlFailureBody.Type;

const UNREACHABLE: RemoteFailure = {
  reason: "rejected",
  message: "Could not reach the owner's machine.",
};

const routeFor = (route: string, switchId: string) =>
  `${route}?${REMOTE_CONTROL_SWITCH_PARAM}=${encodeURIComponent(switchId)}`;

async function failureOf(response: Response): Promise<RemoteFailure> {
  const json: unknown = await response.json().catch(() => null);
  return Option.getOrElse(decodeFailure(json), () => UNREACHABLE);
}

/** Resolves to null on success, or to why the server refused. */
async function postRemote(url: string, body?: unknown): Promise<RemoteFailure | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      ...(body === undefined
        ? {}
        : body instanceof FormData
          ? { body }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return response.ok ? null : await failureOf(response);
  } catch {
    return UNREACHABLE;
  }
}

async function postPairing(
  url: string,
  body?: unknown,
): Promise<RemoteControlPairingProgress | RemoteFailure> {
  try {
    const response = await fetch(url, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) return await failureOf(response);
    const json: unknown = await response.json().catch(() => null);
    return Option.getOrElse(decodeProgress(json), () => UNREACHABLE);
  } catch {
    return UNREACHABLE;
  }
}

const isFailure = (result: RemoteControlPairingProgress | RemoteFailure): result is RemoteFailure =>
  "reason" in result;

type SessionCheck = "active" | "ended" | "unreachable";

/** Whether this browser's session works, or the machine behind it cannot be reached at all. */
async function checkSession(switchId: string): Promise<SessionCheck> {
  try {
    const response = await fetch(routeFor(REMOTE_CONTROL_SESSION_ROUTE, switchId));
    if (response.ok) return "active";
    // A relay answering for an offline machine sends no failure body of ours.
    const json: unknown = await response.json().catch(() => null);
    return Option.isSome(decodeFailure(json)) ? "ended" : "unreachable";
  } catch {
    return "unreachable";
  }
}

const PAIRING_POLL_MS = 2_000;

type Stage =
  | { readonly kind: "checking" }
  | { readonly kind: "join" }
  | {
      readonly kind: "waiting";
      readonly progress: RemoteControlPairingProgress;
    }
  | { readonly kind: "code"; readonly progress: RemoteControlPairingProgress }
  | { readonly kind: "session"; readonly switchId: string }
  | { readonly kind: "refused"; readonly message: string };

export function RemotePage() {
  const [{ credential, switchId }] = useState(takeRemoteEntry);
  const [stage, setStage] = useState<Stage>(
    switchId === null
      ? { kind: "refused", message: "This link is not valid." }
      : { kind: "checking" },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server what this browser already holds for the switch, and ignores the answer after cleanup
  useEffect(() => {
    if (switchId === null) return;
    let live = true;
    const decide = async (): Promise<Stage> => {
      const session = await checkSession(switchId);
      if (session === "active") return { kind: "session", switchId };
      if (credential !== null) return { kind: "join" };
      // A reload while pairing: the pairing cookie still knows where it got to.
      const progress = await postPairing(routeFor(REMOTE_CONTROL_PAIR_STATUS_ROUTE, switchId));
      if (isFailure(progress)) {
        return {
          kind: "refused",
          message:
            session === "unreachable"
              ? UNREACHABLE.message
              : "This link has ended or is not valid. Ask the owner for a new one.",
        };
      }
      if (progress.status === "paired") return { kind: "session", switchId };
      return { kind: progress.mode === "code" ? "code" : "waiting", progress };
    };
    void decide().then((next) => {
      if (live) setStage(next);
    });
    return () => {
      live = false;
    };
  }, [credential, switchId]);
  // Pasting another link into this tab changes only the hash, which does not reload the page.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hashchange listener reloads the page so a pasted link is read instead of the one already captured
  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash !== "") window.location.reload();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {stage.kind === "checking" ? (
        <SharedNotice title="Connecting..." />
      ) : stage.kind === "join" && credential !== null ? (
        <JoinForm
          credential={credential}
          onStarted={(progress) => {
            // The link is spent; a remount must not offer it again.
            capturedEntry = { credential: null, switchId: progress.switchId };
            setStage({ kind: progress.mode === "code" ? "code" : "waiting", progress });
          }}
        />
      ) : stage.kind === "waiting" ? (
        <WaitingForOwner
          progress={stage.progress}
          onPaired={() => setStage({ kind: "session", switchId: stage.progress.switchId })}
          onRefused={(message) => setStage({ kind: "refused", message })}
        />
      ) : stage.kind === "code" ? (
        <CodeForm
          progress={stage.progress}
          onPaired={() => setStage({ kind: "session", switchId: stage.progress.switchId })}
          onRefused={(message) => setStage({ kind: "refused", message })}
        />
      ) : stage.kind === "session" ? (
        <RemoteSession switchId={stage.switchId} />
      ) : (
        <SharedNotice
          title="This link cannot be used"
          detail={stage.kind === "refused" ? stage.message : "Ask the owner for a new link."}
        />
      )}
    </div>
  );
}

function JoinForm({
  credential,
  onStarted,
}: {
  readonly credential: string;
  readonly onStarted: (progress: RemoteControlPairingProgress) => void;
}) {
  const [label, setLabel] = useState(() => suggestedDeviceLabel(navigator.userAgent));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const deviceLabel = label.trim();
    if (deviceLabel === "" || submitting) return;
    setSubmitting(true);
    const result = await postPairing(REMOTE_CONTROL_PAIR_START_ROUTE, { credential, deviceLabel });
    setSubmitting(false);
    if (isFailure(result)) setError(result.message);
    else onStarted(result);
  };
  return (
    <form className="m-auto flex w-full max-w-xs flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Join a conversation</h1>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="remote-device-label">
        Name this device
        <Input
          id="remote-device-label"
          autoFocus
          maxLength={GUEST_NAME_MAX_LENGTH}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || label.trim() === ""}>
        Continue
      </Button>
      <p className="text-xs text-muted-foreground">
        The owner sees this name and decides whether this device can join. This link works once.
      </p>
    </form>
  );
}

function WaitingForOwner({
  progress,
  onPaired,
  onRefused,
}: {
  readonly progress: RemoteControlPairingProgress;
  readonly onPaired: () => void;
  readonly onRefused: (message: string) => void;
}) {
  const { switchId, confirmationWord } = progress;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server for the owner's answer until it arrives
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const result = await postPairing(routeFor(REMOTE_CONTROL_PAIR_STATUS_ROUTE, switchId));
      if (!live) return;
      if (!isFailure(result) && result.status === "paired") onPaired();
      else if (isFailure(result) && result !== UNREACHABLE) onRefused(result.message);
      else timer = setTimeout(() => void poll(), PAIRING_POLL_MS);
    };
    timer = setTimeout(() => void poll(), PAIRING_POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [switchId, onPaired, onRefused]);
  return (
    <div className="m-auto flex w-full max-w-xs flex-col items-center gap-3 p-6 text-center">
      <h1 className="text-base font-medium">Waiting for the owner</h1>
      <p className="text-sm text-muted-foreground">Check that the owner sees this word:</p>
      <p className="text-2xl font-semibold tracking-wide" data-testid="confirmation-word">
        {confirmationWord}
      </p>
      <p className="text-xs text-muted-foreground">
        If the words do not match, they should refuse the request.
      </p>
    </div>
  );
}

function CodeForm({
  progress,
  onPaired,
  onRefused,
}: {
  readonly progress: RemoteControlPairingProgress;
  readonly onPaired: () => void;
  readonly onRefused: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() === "" || submitting) return;
    setSubmitting(true);
    const result = await postPairing(routeFor(REMOTE_CONTROL_PAIR_CODE_ROUTE, progress.switchId), {
      code,
    });
    setSubmitting(false);
    if (!isFailure(result)) return onPaired();
    if (result.reason === "wrong_code") {
      setCode("");
      setError(`That code is not right. ${result.attemptsLeft ?? 0} attempts left.`);
    } else if (result.reason === "rate_limited") {
      setError(result.message);
    } else if (result === UNREACHABLE) {
      setError(result.message);
    } else {
      onRefused(result.message);
    }
  };
  return (
    <form className="m-auto flex w-full max-w-xs flex-col gap-3 p-6" onSubmit={submit}>
      <h1 className="text-base font-medium">Enter the code</h1>
      <label className="flex flex-col gap-1.5 text-sm" htmlFor="remote-code">
        The code on the owner&apos;s screen
        <Input
          id="remote-code"
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={16}
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={submitting || code.trim() === ""}>
        Join
      </Button>
    </form>
  );
}

type Connection = "connecting" | "live" | "reconnecting" | "offline";

function RemoteSession({ switchId }: { readonly switchId: string }) {
  const [state, dispatch] = useReducer(applyRemoteStreamEvent, initialRemoteStreamState);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [rejected, setRejected] = useState(false);
  const [routes] = useState(() => remoteThreadRoutes(switchId));
  const historyControls = useSharedThreadHistory({
    historyCursor: state.thread.historyCursor,
    routes,
    onPage: (cursor, page) => dispatch({ type: "history-page", cursor, page }),
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sets document.title to the conversation's title
  useEffect(() => {
    if (state.thread.view) document.title = state.thread.view.title;
  }, [state.thread.view]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the EventSource: reconnects with the last sequence, and tells a dead session from an unreachable machine
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let attempts = 0;
    let lastSequence = 0;
    let knownExpiry: string | null | undefined;
    const connect = () => {
      clearTimeout(timer);
      timer = undefined;
      source?.close();
      const current = new EventSource(remoteStreamUrl(switchId, lastSequence));
      source = current;
      current.addEventListener("message", (message) => {
        const event = parseRemoteStreamEvent(message.data);
        if (event === null) return;
        attempts = 0;
        setConnection("live");
        lastSequence = streamEventSequence(event) ?? lastSequence;
        dispatch(event);
        // Asking renews the cookie, so a limit the owner extended outlasts the old one.
        if (event.type === "view" && event.view.expiresAt !== knownExpiry) {
          knownExpiry = event.view.expiresAt;
          void checkSession(switchId);
        }
        if (event.type === "ended") {
          finished = true;
          current.close();
        }
      });
      current.addEventListener("error", () => {
        current.close();
        if (finished || source !== current) return;
        source = null;
        attempts += 1;
        setConnection(attempts >= OWNER_OFFLINE_AFTER_ATTEMPTS ? "offline" : "reconnecting");
        void checkSession(switchId).then((check) => {
          if (finished) return;
          if (check === "ended") {
            finished = true;
            setRejected(true);
            return;
          }
          if (check === "active") {
            setConnection("reconnecting");
          }
          timer = setTimeout(connect, reconnectDelayMs(attempts));
        });
      });
    };
    connect();
    // A phone waking up should not wait out a long backoff.
    const onVisible = () => {
      if (document.visibilityState === "visible" && source === null && !finished) connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      finished = true;
      clearTimeout(timer);
      source?.close();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [switchId]);

  if (rejected) {
    return (
      <SharedNotice
        title="This session has ended"
        detail="Ask the owner for a new link to join again."
      />
    );
  }
  if (state.thread.ended) {
    return (
      <SharedNotice
        title="This session has ended"
        detail={
          state.endReason === null
            ? "Ask the owner for a new link to join again."
            : END_REASON_MESSAGES[state.endReason]
        }
      />
    );
  }
  const { view, projection } = state.thread;
  if (view === null || projection === null) {
    return (
      <SharedNotice
        title={connection === "offline" ? "The owner's machine is offline" : "Connecting..."}
        {...(connection === "offline"
          ? { detail: "This page reconnects on its own when the machine is back." }
          : {})}
      />
    );
  }
  return (
    <RemoteConversation
      view={view}
      projection={projection}
      connection={connection}
      awaitingRowIds={state.thread.awaitingRowIds}
      historyControls={historyControls}
      routes={routes}
    />
  );
}

function sessionTimeLabel(view: RemoteControlView, now: number) {
  return view.expiresAt === null ? "No time limit" : `${formatRemaining(view.expiresAt, now)} left`;
}

/** Shows the conversation's real mode. With the permission, it switches like the app's tabs do. */
function RemoteModeTabs({
  mode,
  canSwitch,
  onSwitch,
}: {
  readonly mode: ThreadCapabilityMode;
  readonly canSwitch: boolean;
  readonly onSwitch: (mode: ThreadCapabilityMode) => void;
}) {
  const tabs = canSwitch
    ? WORKSPACE_MODE_TABS
    : WORKSPACE_MODE_TABS.filter((tab) => tab.mode === mode);
  return (
    <div
      role="tablist"
      aria-label="Conversation mode"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-sidebar-control-surface p-0.5"
    >
      {tabs.map(({ mode: tabMode, label, icon: Icon }) => (
        <Tooltip key={tabMode}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="tab"
                aria-selected={mode === tabMode}
                aria-label={label}
                className={cn(
                  "flex size-7 items-center justify-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  mode === tabMode
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "cursor-pointer text-sidebar-muted-foreground hover:text-sidebar-foreground",
                )}
                onClick={() => {
                  if (canSwitch && mode !== tabMode) onSwitch(tabMode);
                }}
              />
            }
          >
            <Icon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

function RemoteTitle({
  title,
  canRename,
  onRename,
}: {
  readonly title: string;
  readonly canRename: boolean;
  readonly onRename: (title: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim() !== "" && draft.trim() !== title) onRename(draft.trim());
          setDraft(null);
        }}
      >
        <Input
          autoFocus
          aria-label="Conversation title"
          maxLength={200}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setDraft(null)}
        />
      </form>
    );
  }
  return canRename ? (
    <button
      type="button"
      aria-label={`Rename ${title}`}
      className="min-w-0 flex-1 cursor-pointer truncate text-left text-sm font-medium"
      onClick={() => setDraft(title)}
    >
      {title}
    </button>
  ) : (
    <h1 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h1>
  );
}

/** Remote Control's own icon from the app. What this device can do lives behind it. */
function RemoteSessionMenu({
  view,
  onLeave,
}: {
  readonly view: RemoteControlView;
  readonly onLeave: () => void;
}) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}Z`);
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label="Remote control session" />}
      >
        <MousePointer2Icon />
      </MenuTrigger>
      <MenuPopup align="end">
        <p className="px-2 py-1.5 text-xs">
          <span className="block font-medium">
            {REMOTE_CONTROL_LEVEL_INFO[view.level].label} access
          </span>
          <span className="block text-muted-foreground">{view.deviceLabel}</span>
          <span className="block text-muted-foreground tabular-nums">
            {sessionTimeLabel(view, now)}
          </span>
        </p>
        <MenuItem onClick={onLeave}>
          <LogOutIcon />
          Leave
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function ConnectionBanner({ connection }: { readonly connection: Connection }) {
  if (connection === "live" || connection === "connecting") return null;
  return (
    <p role="status" className="shrink-0 bg-muted px-4 py-1.5 text-center text-xs">
      {connection === "offline"
        ? "The owner's machine is offline. This conversation is paused, and the page reconnects on its own."
        : "Reconnecting..."}
    </p>
  );
}

function RemoteConversation({
  view,
  projection,
  connection,
  awaitingRowIds,
  historyControls,
  routes,
}: {
  readonly view: RemoteControlView;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly connection: Connection;
  readonly awaitingRowIds: ReadonlySet<GuestMessageId>;
  readonly historyControls: MessagesTimelineHistoryControls | undefined;
  readonly routes: ReturnType<typeof remoteThreadRoutes>;
}) {
  const switchId = view.shareId;
  const [actionError, setActionError] = useState<string | null>(null);
  const offline = connection === "offline";
  const runtime = deriveThreadStructureRuntime(projection);
  const running = derivePhase(runtime) === "running";
  const canSend = remoteControlLevelAllows(view.level, "chat") && !offline;
  const canApprove = remoteControlLevelAllows(view.level, "approve");
  const can = (permission: RemoteControlPermission) =>
    view.permissions.includes(permission) && !offline;
  const canStopComputer = remoteControlLevelAllows(view.level, "full");
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const heldBack =
    view.level !== view.grantedLevel || view.permissions.length !== view.grantedPermissions.length;
  const send = async (text: string, files: ReadonlyArray<File>) => {
    const form = new FormData();
    form.append("shareId", switchId);
    form.append("text", text);
    for (const file of files) form.append("file", file, file.name);
    const failure = await postRemote(routeFor(REMOTE_CONTROL_MESSAGES_ROUTE, switchId), form);
    return failure?.message ?? null;
  };
  const act = async (url: string, body?: unknown) => {
    const failure = await postRemote(url, body);
    setActionError(failure?.message ?? null);
  };
  const others = view.otherDevices.filter((device) => device.connected);
  if (orchestratorOpen && can("orchestrator")) {
    return (
      <RemoteOrchestrator
        routeFor={(route) => routeFor(route, switchId)}
        onBack={() => setOrchestratorOpen(false)}
      />
    );
  }
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <RemoteModeTabs
          mode={view.capabilityMode}
          canSwitch={can("threadMode")}
          onSwitch={(capabilityMode) => {
            if (running) setActionError("Stop the run before changing mode.");
            else void act(routeFor(REMOTE_CONTROL_MODE_ROUTE, switchId), { capabilityMode });
          }}
        />
        <RemoteTitle
          key={view.title}
          title={view.title}
          canRename={can("rename")}
          onRename={(title) => void act(routeFor(REMOTE_CONTROL_RENAME_ROUTE, switchId), { title })}
        />
        {can("orchestrator") ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Orchestrator"
            onClick={() => setOrchestratorOpen(true)}
          >
            <OrchestratorGlyph size={18} motion="still" />
          </Button>
        ) : null}
        <RemoteSessionMenu
          view={view}
          onLeave={() => {
            void postRemote(routeFor(REMOTE_CONTROL_SIGN_OUT_ROUTE, switchId)).then(() =>
              window.location.reload(),
            );
          }}
        />
      </header>
      <ConnectionBanner connection={connection} />
      {others.length > 0 ? (
        <p className="shrink-0 px-4 py-1 text-center text-xs text-muted-foreground">
          Also here: {others.map((device) => device.label).join(", ")}
        </p>
      ) : null}
      <SharedThreadTimeline
        threadKey={`remote-${switchId}`}
        projection={projection}
        routes={routes}
        messages={view.messages}
        awaitingRowIds={awaitingRowIds}
        historyControls={historyControls}
      />
      <div className={cn(SHARED_THREAD_LANE, "flex shrink-0 flex-col gap-2 pb-4")}>
        {actionError !== null ? (
          <p role="alert" className="text-xs text-destructive">
            {actionError}
          </p>
        ) : null}
        <RemoteComputerUse
          routeFor={(route) => routeFor(route, switchId)}
          canApprove={canApprove && !offline}
          canStop={canStopComputer && !offline}
          onAct={(url, body) => void act(url, body)}
        />
        {canApprove && !offline ? (
          <PendingRequests
            projection={projection}
            onRespond={(body) => act(routeFor(REMOTE_CONTROL_RESPOND_ROUTE, switchId), body)}
          />
        ) : null}
        {heldBack ? (
          <p className="text-xs text-muted-foreground">
            This connection is not encrypted, so these controls need the private relay, Tailscale,
            or T3 Connect.
          </p>
        ) : null}
        {canSend ? (
          <SharedThreadComposer
            model={view.model}
            hint={
              view.ownerReview ? "The owner approves each message" : "Sent as " + view.deviceLabel
            }
            {...(can("model") || can("mode")
              ? {
                  controls: (
                    <RemoteComposerControls
                      view={view}
                      projection={projection}
                      providersUrl={remoteProvidersUrl((route) => routeFor(route, switchId))}
                      onModel={(modelSelection) =>
                        void act(routeFor(REMOTE_CONTROL_MODEL_ROUTE, switchId), { modelSelection })
                      }
                      onMode={(body) =>
                        void act(routeFor(REMOTE_CONTROL_MODE_ROUTE, switchId), body)
                      }
                    />
                  ),
                }
              : {})}
            onStop={
              can("stop") && running
                ? () => void act(routeFor(REMOTE_CONTROL_STOP_ROUTE, switchId))
                : undefined
            }
            onSend={send}
          />
        ) : offline ? null : (
          <p className="text-center text-xs text-muted-foreground">
            You can watch this conversation.
          </p>
        )}
      </div>
    </>
  );
}

function PendingRequests({
  projection,
  onRespond,
}: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly onRespond: (body: {
    readonly requestId: RuntimeRequestId;
    readonly decision?: "accept" | "decline";
    readonly answers?: unknown;
  }) => Promise<void>;
}) {
  const { approvals, userInputs } = derivePendingThreadRequests(projection);
  if (approvals.length === 0 && userInputs.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Waiting for an answer">
      {approvals.map((approval) => (
        <li key={approval.requestId}>
          <ApprovalCard approval={approval} onRespond={onRespond} />
        </li>
      ))}
      {userInputs.map((input) => (
        <li key={input.requestId}>
          <QuestionCard input={input} onRespond={onRespond} />
        </li>
      ))}
    </ul>
  );
}

const CARD = "flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 text-sm";

function ApprovalCard({
  approval,
  onRespond,
}: {
  readonly approval: ThreadPendingApproval;
  readonly onRespond: (body: {
    readonly requestId: RuntimeRequestId;
    readonly decision: "accept" | "decline";
  }) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const respond = async (decision: "accept" | "decline") => {
    setBusy(true);
    await onRespond({ requestId: approval.requestId, decision });
    setBusy(false);
  };
  return (
    <div className={CARD}>
      <p className="font-medium">The agent asks for approval</p>
      {approval.detail ? (
        <p className="max-h-40 overflow-auto font-mono text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
          {approval.detail}
        </p>
      ) : null}
      {approval.reason ? <p className="text-xs text-muted-foreground">{approval.reason}</p> : null}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || approval.responseCapability !== "live"}
          onClick={() => void respond("decline")}
        >
          Deny
        </Button>
        <Button
          size="sm"
          disabled={busy || approval.responseCapability !== "live"}
          onClick={() => void respond("accept")}
        >
          Approve
        </Button>
      </div>
    </div>
  );
}

function QuestionCard({
  input,
  onRespond,
}: {
  readonly input: ThreadPendingUserInput;
  readonly onRespond: (body: {
    readonly requestId: RuntimeRequestId;
    readonly answers: unknown;
  }) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [busy, setBusy] = useState(false);
  const answers = buildPendingUserInputAnswers(input.questions, drafts);
  return (
    <form
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault();
        if (answers === null || busy) return;
        setBusy(true);
        void onRespond({ requestId: input.requestId, answers }).finally(() => setBusy(false));
      }}
    >
      {input.questions.map((question) => {
        const draft = drafts[question.id];
        return (
          <fieldset key={question.id} className="flex flex-col gap-1.5">
            <legend className="font-medium">{question.question}</legend>
            <div className="flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const value = option.value ?? option.label;
                const selected = draft?.selectedOptionValues?.includes(value) === true;
                return (
                  <Button
                    key={value}
                    size="xs"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    onClick={() =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: togglePendingUserInputOptionSelection(
                          question,
                          current[question.id],
                          value,
                        ),
                      }))
                    }
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
            {question.allowCustomAnswer === false ? null : (
              <Input
                aria-label={`Answer: ${question.question}`}
                value={draft?.customAnswer ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [question.id]: setPendingUserInputCustomAnswer(
                      question,
                      current[question.id],
                      event.target.value,
                    ),
                  }))
                }
              />
            )}
          </fieldset>
        );
      })}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || answers === null}>
          Answer
        </Button>
      </div>
    </form>
  );
}
