import { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import {
  EnvironmentId,
  REMOTE_CONTROL_ORCHESTRATOR_REACT_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_SEND_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_STOP_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_STREAM_ROUTE,
  RemoteControlOrchestratorEvent,
  type RemoteControlOrchestratorState,
  type RemoteControlView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useReducer, useState } from "react";

import { applyGuestStreamEvent, initialSharedStreamState } from "../guest/guestStream.logic";
import { OrchestratorConversation } from "../orchestrator/OrchestratorConversation";
import { OrchestratorGlyph } from "../orchestrator/OrchestratorGlyph";
import { OrchestratorComposer } from "../orchestrator/OrchestratorPanel";
import { orchestratorFeed } from "../orchestrator/orchestratorChat.logic";
import { Button } from "../ui/button";

const VISIBLE_ITEM_LIMIT = 200;
// The conversation's own rows only use this to look up text a remote page does not stream.
const NO_ENVIRONMENT = EnvironmentId.make("remote-device");

const decodeEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(RemoteControlOrchestratorEvent)),
);

type ThreadState = ReturnType<typeof initialSharedStreamState<RemoteControlView>>;

function useOrchestratorStream(url: string) {
  const [state, setState] = useState<RemoteControlOrchestratorState | null>(null);
  const [thread, applyThread] = useReducer(
    (current: ThreadState, event: Parameters<typeof applyGuestStreamEvent>[1]) =>
      applyGuestStreamEvent<RemoteControlView>(
        current,
        event as Parameters<typeof applyGuestStreamEvent<RemoteControlView>>[1],
      ),
    initialSharedStreamState<RemoteControlView>(),
  );
  // A new address reopens the stream once the orchestrator has a thread to follow.
  const streamUrl = state?.threadId == null ? url : `${url}&thread=${state.threadId}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the EventSource
  useEffect(() => {
    const source = new EventSource(streamUrl);
    source.addEventListener("message", (message) => {
      const event = Option.getOrNull(decodeEvent(message.data));
      if (event === null) return;
      if (event.type === "state") setState(event.state);
      else applyThread(event);
    });
    return () => source.close();
  }, [streamUrl]);
  return { state, projection: thread.projection };
}

/** The orchestrator's messenger, as in the app. Approvals stay on the owner's own screen. */
export function RemoteOrchestrator({
  routeFor,
  onBack,
}: {
  readonly routeFor: (route: string) => string;
  readonly onBack: () => void;
}) {
  const { state, projection } = useOrchestratorStream(
    routeFor(REMOTE_CONTROL_ORCHESTRATOR_STREAM_ROUTE),
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (route: string, body?: unknown) => {
    const response = await fetch(routeFor(route), {
      method: "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }).catch(() => null);
    return response?.ok === true;
  };
  const send = async () => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    const sent = await post(REMOTE_CONTROL_ORCHESTRATOR_SEND_ROUTE, { text });
    setSending(false);
    setError(sent ? null : "The orchestrator did not take that message.");
    if (sent) setDraft("");
  };
  const activeRunId =
    projection === null ? null : (deriveThreadStructureRuntime(projection)?.activeRunId ?? null);
  const feed =
    projection === null
      ? null
      : orchestratorFeed(projection.visibleTurnItems.slice(-VISIBLE_ITEM_LIMIT), activeRunId);
  const blocked = state?.availability.status === "blocked" ? state.availability.message : null;
  const canSend = state?.hasBrain === true && blocked === null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-foreground/10 bg-background/55 px-3 py-1.5 backdrop-blur-xl">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to the conversation"
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="flex size-8 items-center justify-center rounded-full border border-primary/40 bg-card/80">
          <OrchestratorGlyph size={22} motion={activeRunId === null ? "idle" : "working"} />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">Orchestrator</span>
        {activeRunId === null ? null : (
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => void post(REMOTE_CONTROL_ORCHESTRATOR_STOP_ROUTE)}
          >
            Stop
          </Button>
        )}
      </header>
      {state !== null && state.pendingApprovals > 0 ? (
        <p role="status" className="flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs">
          <ShieldCheckIcon className="size-3.5" aria-hidden />
          Waiting for you to approve on your computer.
        </p>
      ) : null}
      {state === null ? null : !state.hasBrain ? (
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">
          Choose the orchestrator&apos;s model on your computer first.
        </p>
      ) : feed === null || state.threadId === null ? (
        <p className="m-auto p-6 text-center text-sm text-muted-foreground">
          Hand it the whole job: it starts threads, watches runs, and calls you when it matters.
        </p>
      ) : (
        <OrchestratorConversation
          environmentId={NO_ENVIRONMENT}
          threadId={state.threadId}
          feed={feed}
          reactions={state.reactions}
          timestampFormat="locale"
          onReact={(messageId, emoji, excerpt) =>
            void post(REMOTE_CONTROL_ORCHESTRATOR_REACT_ROUTE, { messageId, emoji, excerpt })
          }
        />
      )}
      {blocked !== null || error !== null ? (
        <p role="alert" className="px-4 text-xs text-destructive">
          {error ?? blocked}
        </p>
      ) : null}
      <OrchestratorComposer
        draft={draft}
        disabled={!canSend || sending}
        placeholder="Message the orchestrator"
        canSend={canSend && !sending && draft.trim() !== ""}
        onDraft={setDraft}
        onSubmit={() => void send()}
      />
    </div>
  );
}
