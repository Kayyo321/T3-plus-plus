import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthAccessWriteScope,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestratorApproval,
  type OrchestratorBrainAvailability,
  type OrchestratorFocus,
  orchestratorBrainAvailability,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useEffectEvent, useState } from "react";

import { useOrchestratorDock, orchestratorEnvironment } from "../../state/orchestratorAgent";
import { useThreadVisibleTurnItems } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import OrchestratorActivity from "./OrchestratorActivity";
import OrchestratorGrantsEditor from "./OrchestratorGrantsEditor";

const VISIBLE_ITEM_LIMIT = 200;

const selectionKey = (selection: ModelSelection) => `${selection.instanceId} ${selection.model}`;

function ProviderOption(props: {
  readonly provider: ServerProvider;
  readonly onChoose: (selection: ModelSelection) => void;
}) {
  const { provider } = props;
  const usable = provider.models.filter(
    (model) =>
      !model.isLegacy &&
      orchestratorBrainAvailability({ instanceId: provider.instanceId, model: model.slug }, [
        provider,
      ]).status === "available",
  );
  if (usable.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 font-mono text-2xs tracking-wide text-muted-foreground uppercase">
        {provider.displayName ?? provider.instanceId}
      </h3>
      {usable.map((model) => (
        <button
          key={model.slug}
          type="button"
          className="rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
          onClick={() => props.onChoose({ instanceId: provider.instanceId, model: model.slug })}
        >
          {model.name}
        </button>
      ))}
    </section>
  );
}

function BrainPicker(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly current: ModelSelection | null;
  readonly runActive: boolean;
  readonly onChoose: (selection: ModelSelection, interruptRun: boolean) => void;
  readonly onCancel: (() => void) | undefined;
}) {
  const [interruptRun, setInterruptRun] = useState(false);
  const anyUsable = props.providers.some((provider) =>
    provider.models.some(
      (model) =>
        orchestratorBrainAvailability({ instanceId: provider.instanceId, model: model.slug }, [
          provider,
        ]).status === "available",
    ),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Choose the orchestrator's model</h2>
        <p className="text-xs text-muted-foreground">
          It runs with no file or shell tools and acts through the app, within the grants you set. A
          fast, cheap model suits housekeeping; a stronger one suits planning. Nothing runs until
          you choose.
        </p>
      </div>
      {props.runActive ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={interruptRun}
            onChange={(event) => setInterruptRun(event.target.checked)}
          />
          The orchestrator is working. Interrupt it to switch now.
        </label>
      ) : null}
      {anyUsable ? (
        props.providers.map((provider) => (
          <ProviderOption
            key={provider.instanceId}
            provider={provider}
            onChoose={(selection) => props.onChoose(selection, interruptRun)}
          />
        ))
      ) : (
        <p className="text-xs text-muted-foreground">
          No connected provider can run the orchestrator. It needs one that can withhold file and
          shell tools: Claude, Codex, or OpenCode.
        </p>
      )}
      {props.onCancel ? (
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function BlockedNotice(props: {
  readonly availability: Extract<OrchestratorBrainAvailability, { readonly status: "blocked" }>;
  readonly onFix: () => void;
  readonly onChooseAnother: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col gap-2 border-t border-border p-3">
      <p className="text-xs">{props.availability.message}</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={props.onFix}>
          Fix it
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onChooseAnother}>
          Choose another
        </Button>
      </div>
    </div>
  );
}

function ApprovalCard(props: {
  readonly approval: OrchestratorApproval;
  readonly canAnswer: boolean;
  readonly onAnswer: (allow: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border p-3">
      <p className="font-mono text-2xs tracking-wide text-muted-foreground uppercase">
        Asks to act · {props.approval.domain}
      </p>
      <p className="text-xs break-words">{props.approval.summary}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={!props.canAnswer} onClick={() => props.onAnswer(true)}>
          Allow
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!props.canAnswer}
          onClick={() => props.onAnswer(false)}
        >
          Refuse
        </Button>
      </div>
    </div>
  );
}

function Transcript(props: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId }) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const items = useThreadVisibleTurnItems(threadRef).slice(-VISIBLE_ITEM_LIMIT);
  return (
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        {items.map(({ item }) => {
          switch (item.type) {
            case "user_message":
              return (
                <p key={item.id} className="self-end rounded-md bg-accent px-2 py-1 text-sm">
                  {item.text}
                </p>
              );
            case "assistant_message":
              return (
                <ChatMarkdown
                  key={item.id}
                  text={item.text}
                  cwd={undefined}
                  threadRef={threadRef}
                  environmentId={props.environmentId}
                  className="text-sm"
                />
              );
            case "dynamic_tool":
              return (
                <p key={item.id} className="font-mono text-2xs text-muted-foreground">
                  ∙ {item.toolName ?? "tool"}
                </p>
              );
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}

/** Everything but the transcript and composer is server state, so every client shows the same. */
export default function OrchestratorPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly focus: OrchestratorFocus | undefined;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const setOpen = useOrchestratorDock((state) => state.setOpen);
  const liveResult = useAtomValue(orchestratorEnvironment.live({ environmentId, input: {} }));
  const snapshot = liveResult._tag === "Success" ? liveResult.value : null;
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const canAnswer = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const setBrain = useAtomCommand(orchestratorEnvironment.setBrain);
  const send = useAtomCommand(orchestratorEnvironment.send);
  const interrupt = useAtomCommand(orchestratorEnvironment.interrupt);
  const answerApproval = useAtomCommand(orchestratorEnvironment.answerApproval);
  const checkAvailability = useAtomCommand(orchestratorEnvironment.checkAvailability, {
    reportFailure: false,
  });
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<"conversation" | "activity" | "grants">("conversation");

  const checkOnOpen = useEffectEvent((target: EnvironmentId) => {
    void checkAvailability({ environmentId: target, input: {} });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to re-probe the chosen provider when the panel opens
  useEffect(() => {
    checkOnOpen(environmentId);
  }, [environmentId]);

  const availability = snapshot?.availability ?? { status: "unconfigured" as const };
  const blocked = availability.status === "blocked" ? availability : null;
  const showPicker = picking || (snapshot !== null && snapshot.brain === null);
  const canSend = availability.status === "available" && draft.trim().length > 0;

  const choose = async (selection: ModelSelection, interruptRun: boolean) => {
    const result = await setBrain({
      environmentId,
      input: { brain: selection, interruptRun },
    });
    if (result._tag === "Success") setPicking(false);
  };

  const submit = async () => {
    if (!canSend) return;
    const text = draft.trim();
    setDraft("");
    setSendError(null);
    const result = await send({
      environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        text,
        ...(props.focus === undefined ? {} : { focus: props.focus }),
      },
    });
    if (result._tag === "Success") return;
    setDraft(text);
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setSendError(error instanceof Error ? error.message : "The message was not sent.");
    }
  };

  return (
    <aside
      aria-label="Orchestrator"
      data-orchestrator-dock
      className="flex h-dvh w-96 max-w-[50vw] shrink-0 flex-col border-l border-border bg-background"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 wco:pr-(--workspace-native-controls-inset)">
        <span className="font-mono text-2xs tracking-wide text-muted-foreground uppercase">
          Orchestrator
        </span>
        {snapshot?.brain ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-xs hover:underline"
            aria-label={`Model: ${selectionKey(snapshot.brain)}. Change it.`}
            onClick={() => setPicking(true)}
          >
            {selectionKey(snapshot.brain)}
          </button>
        ) : (
          <span className="flex-1" />
        )}
        {(["activity", "grants"] as const).map((target) => (
          <Button
            key={target}
            variant="ghost"
            size="xs"
            aria-pressed={view === target}
            onClick={() => setView(view === target ? "conversation" : target)}
          >
            {target === "activity" ? "Activity" : "Grants"}
          </Button>
        ))}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Stop the orchestrator"
          onClick={() => void interrupt({ environmentId, input: {} })}
        >
          <SquareIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close the orchestrator panel"
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </header>
      {showPicker ? (
        <BrainPicker
          providers={providers}
          current={snapshot?.brain ?? null}
          runActive={false}
          onChoose={(selection, interruptRun) => void choose(selection, interruptRun)}
          onCancel={snapshot?.brain ? () => setPicking(false) : undefined}
        />
      ) : view === "activity" ? (
        <OrchestratorActivity environmentId={environmentId} />
      ) : view === "grants" && snapshot !== null ? (
        <OrchestratorGrantsEditor environmentId={environmentId} grants={snapshot.grants} />
      ) : snapshot?.threadId != null ? (
        <Transcript environmentId={environmentId} threadId={snapshot.threadId} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
          Ask for anything you would do by hand: start threads, tidy the sidebar, open a diff.
        </div>
      )}
      {snapshot?.supervision.status === "paused" && snapshot.brain !== null ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          Supervision is paused.
        </p>
      ) : null}
      {snapshot?.pendingApprovals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          canAnswer={canAnswer}
          onAnswer={(allow) =>
            void answerApproval({ environmentId, input: { id: approval.id, allow } })
          }
        />
      ))}
      {blocked ? (
        <BlockedNotice
          availability={blocked}
          onFix={() => void navigate({ to: "/settings/providers" })}
          onChooseAnother={() => setPicking(true)}
        />
      ) : null}
      {sendError === null ? null : (
        <p role="alert" className="border-t border-border px-3 py-1.5 text-xs">
          {sendError}
        </p>
      )}
      {showPicker || view !== "conversation" ? null : (
        <form
          className="flex items-end gap-2 border-t border-border p-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Textarea
            aria-label="Message the orchestrator"
            placeholder={blocked ? "Unavailable" : "Ask the orchestrator"}
            value={draft}
            disabled={availability.status !== "available"}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <Button type="submit" size="icon-sm" aria-label="Send" disabled={!canSend}>
            <ArrowUpIcon />
          </Button>
        </form>
      )}
    </aside>
  );
}
