import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestratorApproval,
  type OrchestratorBrainAvailability,
  type OrchestratorFocus,
  orchestratorBrainAvailability,
  type RunId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveT3McpToolPresentation } from "@t3tools/shared/t3McpToolPresentation";
import { useNavigate } from "@tanstack/react-router";
import { ActivityIcon, ArrowUpIcon, CheckIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { orchestratorEnvironment, useOrchestratorDock } from "../../state/orchestratorAgent";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import OrchestratorActivity from "./OrchestratorActivity";
import { OrchestratorBackdrop } from "./OrchestratorBackdrop";
import { OrchestratorConversation, useOrchestratorFeed } from "./OrchestratorConversation";
import { OrchestratorGlyph, type OrchestratorGlyphMotion } from "./OrchestratorGlyph";
import OrchestratorGrantsEditor from "./OrchestratorGrantsEditor";
import { useOrchestratorStatus } from "./useOrchestratorStatus";

type OrchestratorView = "conversation" | "activity" | "grants";

function ProviderOption(props: {
  readonly provider: ServerProvider;
  readonly current: ModelSelection | null;
  readonly onChoose: (selection: ModelSelection) => void;
}) {
  const { provider, current } = props;
  const usable = provider.models.filter(
    (model) =>
      !model.isLegacy &&
      orchestratorBrainAvailability({ instanceId: provider.instanceId, model: model.slug }, [
        provider,
      ]).status === "available",
  );
  if (usable.length === 0) return null;
  const name = provider.displayName ?? provider.instanceId;
  return (
    <section className="flex flex-col gap-1">
      <h3 className="px-1 font-mono text-2xs tracking-wide text-muted-foreground uppercase">
        {name}
      </h3>
      <div className="flex flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-card/60 backdrop-blur-xl">
        {usable.map((model) => {
          const selected =
            current?.instanceId === provider.instanceId && current.model === model.slug;
          return (
            <button
              key={model.slug}
              type="button"
              aria-pressed={selected}
              className="flex items-center gap-2 px-2.5 py-2 text-left text-sm transition-colors duration-150 hover:bg-accent aria-pressed:bg-primary/15"
              onClick={() => props.onChoose({ instanceId: provider.instanceId, model: model.slug })}
            >
              <ProviderInstanceIcon
                driverKind={provider.driver}
                displayName={name}
                size="compact"
                acpRegistryIconUrl={provider.iconUrl}
              />
              <span className="min-w-0 flex-1 truncate">{model.name}</span>
              {selected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>
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
    <div className="orchestrator-view-enter relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
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
            current={props.current}
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
    <div
      role="alert"
      className="orchestrator-bubble-enter mx-3 mb-2 flex flex-col gap-2 rounded-2xl border border-foreground/10 bg-card/70 p-3 backdrop-blur-xl"
    >
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
  const tool = resolveT3McpToolPresentation(props.approval.tool);
  return (
    <div className="orchestrator-bubble-enter mx-3 mb-2 flex flex-col gap-2 rounded-2xl rounded-bl-md border border-primary/40 bg-card/70 p-3 shadow-sm backdrop-blur-xl">
      <p className="text-sm font-medium">{tool?.displayName ?? props.approval.tool}?</p>
      <p className="max-h-24 overflow-y-auto font-mono text-2xs break-words text-muted-foreground">
        {props.approval.summary}
      </p>
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

function Header(props: {
  readonly provider: ServerProvider | undefined;
  readonly brain: ModelSelection | null;
  readonly glyph: OrchestratorGlyphMotion;
  readonly presence: "online" | "attention" | "off";
  readonly status: string;
  readonly view: OrchestratorView;
  readonly onChangeModel: () => void;
  readonly onView: (view: OrchestratorView) => void;
  readonly onClose: () => void;
}) {
  const { provider, brain } = props;
  const model = provider?.models.find((candidate) => candidate.slug === brain?.model);
  const providerName = provider?.displayName ?? brain?.instanceId;
  const modelName = model?.shortName ?? model?.name ?? brain?.model;
  return (
    <header className="relative z-10 flex shrink-0 items-center gap-2.5 border-b border-foreground/10 bg-background/55 px-3 pt-1.5 pb-1.5 backdrop-blur-xl wco:pt-0">
      <span className="relative shrink-0">
        <span className="flex size-9 items-center justify-center rounded-full border border-primary/40 bg-card/80 orchestrator-avatar-glow">
          <OrchestratorGlyph size={26} motion={props.glyph} />
        </span>
        <span
          aria-hidden
          data-presence={props.presence}
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-background bg-muted-foreground transition-colors duration-300 data-[presence=attention]:bg-warning data-[presence=online]:bg-success"
        />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center truncate text-sm leading-tight font-medium wco:h-(--workspace-topbar-height) wco:pr-(--workspace-native-controls-inset)">
          Orchestrator
        </span>
        <div className="flex min-w-0 items-center gap-1">
          <span className="flex min-w-0 flex-1 items-center gap-1 text-xs leading-tight text-muted-foreground">
            {provider && brain ? (
              <button
                type="button"
                className="flex max-w-[70%] min-w-0 shrink-0 items-center gap-1 rounded-sm transition-colors duration-150 hover:text-foreground"
                aria-label={`Model: ${providerName} ${modelName}. Change it.`}
                onClick={props.onChangeModel}
              >
                <ProviderInstanceIcon
                  driverKind={provider.driver}
                  displayName={providerName ?? provider.instanceId}
                  size="compact"
                  iconClassName="size-3"
                  acpRegistryIconUrl={provider.iconUrl}
                />
                <span className="truncate">{modelName}</span>
              </button>
            ) : null}
            <span key={props.status} className="orchestrator-fade-in truncate">
              {provider && brain ? "· " : ""}
              {props.status}
            </span>
          </span>
          {(
            [
              ["activity", "Activity", ActivityIcon],
              ["grants", "Grants", ShieldCheckIcon],
            ] as const
          ).map(([target, label, Icon]) => (
            <Button
              key={target}
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              title={label}
              aria-pressed={props.view === target}
              onClick={() => props.onView(props.view === target ? "conversation" : target)}
            >
              <Icon />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close the orchestrator panel"
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
      </div>
    </header>
  );
}

function Composer(props: {
  readonly draft: string;
  readonly disabled: boolean;
  readonly placeholder: string;
  readonly canSend: boolean;
  readonly onDraft: (draft: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <form
      className="relative z-10 flex shrink-0 items-end gap-1.5 p-3 pt-1"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <div className="flex min-w-0 flex-1 items-end rounded-3xl border border-foreground/10 bg-card/70 pr-1 shadow-sm backdrop-blur-xl transition-[border-color,box-shadow] duration-200 focus-within:border-primary/50 orchestrator-composer-focus">
        <textarea
          aria-label="Message the orchestrator"
          placeholder={props.placeholder}
          value={props.draft}
          disabled={props.disabled}
          rows={1}
          className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-3.5 py-2 text-sm [field-sizing:content] outline-none placeholder:text-muted-foreground disabled:opacity-60"
          onChange={(event) => props.onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              props.onSubmit();
            }
          }}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!props.canSend}
          data-ready={props.canSend}
          className="mb-1 flex size-7 shrink-0 scale-75 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-0 transition-[transform,opacity] duration-200 orchestrator-spring hover:brightness-110 data-[ready=true]:scale-100 data-[ready=true]:opacity-100"
        >
          <ArrowUpIcon className="size-4" />
        </button>
      </div>
    </form>
  );
}

/** Marks the conversation read while someone can actually see it. */
function useMarkRead(input: {
  readonly environmentId: EnvironmentId;
  readonly through: string | null;
  readonly ownerReadAt: string | null;
}) {
  const markRead = useAtomCommand(orchestratorEnvironment.markRead, { reportFailure: false });
  const { environmentId, through, ownerReadAt } = input;
  const send = useEffectEvent((at: string) => {
    if (document.visibilityState !== "visible") return;
    void markRead({ environmentId, input: { through: at } });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server the owner has seen a message, including when the window comes back
  useEffect(() => {
    if (through === null || (ownerReadAt !== null && ownerReadAt >= through)) return;
    const mark = () => send(through);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [through, ownerReadAt]);
}

function ConversationBody(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly activeRunId: RunId | null;
  readonly reactions: Parameters<typeof OrchestratorConversation>[0]["reactions"];
  readonly latestMessageAt: string | null;
  readonly ownerReadAt: string | null;
  readonly onStatus: (status: string | null) => void;
}) {
  const { environmentId, threadId, activeRunId, onStatus } = props;
  const { timestampFormat } = useEnvironmentSettings(environmentId);
  const react = useAtomCommand(orchestratorEnvironment.react);
  const feed = useOrchestratorFeed(environmentId, threadId, activeRunId);
  useMarkRead({
    environmentId,
    through: props.latestMessageAt,
    ownerReadAt: props.ownerReadAt,
  });
  const status = feed.currentTool?.label ?? (feed.typing ? "typing…" : null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the header sits outside this subtree and shows what the feed derives
  useEffect(() => onStatus(status), [onStatus, status]);
  return (
    <OrchestratorConversation
      environmentId={environmentId}
      threadId={threadId}
      feed={feed}
      reactions={props.reactions}
      timestampFormat={timestampFormat}
      onReact={(messageId, emoji, excerpt) =>
        void react({ environmentId, input: { messageId, emoji, excerpt } })
      }
    />
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
  const status = useOrchestratorStatus(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const canAnswer = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const setBrain = useAtomCommand(orchestratorEnvironment.setBrain);
  const send = useAtomCommand(orchestratorEnvironment.send);
  const answerApproval = useAtomCommand(orchestratorEnvironment.answerApproval);
  const checkAvailability = useAtomCommand(orchestratorEnvironment.checkAvailability, {
    reportFailure: false,
  });
  const threadId = snapshot?.threadId ?? null;
  const shell = useQuietThreadShell(
    threadId === null ? null : scopeThreadRef(environmentId, threadId),
  );
  const activeRunId = shell?.runtime?.activeRunId ?? null;
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<OrchestratorView>("conversation");
  const [feedStatus, setFeedStatus] = useState<string | null>(null);

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
  const provider = providers.find(
    (candidate) => candidate.instanceId === snapshot?.brain?.instanceId,
  );

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

  const conversationShown = !showPicker && view === "conversation";

  return (
    <aside
      aria-label="Orchestrator"
      data-orchestrator-dock
      className="orchestrator-panel-enter relative isolate flex h-dvh w-96 max-w-[50vw] shrink-0 flex-col overflow-hidden border-l border-border bg-background"
    >
      <OrchestratorBackdrop />
      <Header
        provider={provider}
        brain={snapshot?.brain ?? null}
        glyph={activeRunId !== null ? "working" : "idle"}
        presence={status.needsYou ? "attention" : blocked ? "off" : "online"}
        status={conversationShown ? (feedStatus ?? status.label) : status.label}
        view={view}
        onChangeModel={() => setPicking(true)}
        onView={setView}
        onClose={() => setOpen(false)}
      />
      {showPicker ? (
        <BrainPicker
          providers={providers}
          current={snapshot?.brain ?? null}
          runActive={activeRunId !== null}
          onChoose={(selection, interruptRun) => void choose(selection, interruptRun)}
          onCancel={snapshot?.brain ? () => setPicking(false) : undefined}
        />
      ) : view === "activity" ? (
        <div className="orchestrator-view-enter relative flex min-h-0 flex-1 flex-col bg-background/70 backdrop-blur-xl">
          <OrchestratorActivity environmentId={environmentId} />
        </div>
      ) : view === "grants" && snapshot !== null ? (
        <div className="orchestrator-view-enter relative flex min-h-0 flex-1 flex-col bg-background/70 backdrop-blur-xl">
          <OrchestratorGrantsEditor environmentId={environmentId} grants={snapshot.grants} />
        </div>
      ) : threadId !== null ? (
        <ConversationBody
          environmentId={environmentId}
          threadId={threadId}
          activeRunId={activeRunId}
          reactions={snapshot?.reactions ?? {}}
          latestMessageAt={snapshot?.latestMessageAt ?? null}
          ownerReadAt={snapshot?.ownerReadAt ?? null}
          onStatus={setFeedStatus}
        />
      ) : (
        <div className="orchestrator-view-enter relative flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <OrchestratorGlyph size={72} motion="idle" />
          <p className="max-w-60 text-xs text-muted-foreground">
            Ask for anything you would do by hand: start threads, tidy the sidebar, open a diff.
          </p>
        </div>
      )}
      {snapshot?.supervision.status === "paused" && snapshot.brain !== null ? (
        <p className="relative z-10 mb-2 self-center rounded-full bg-background/60 px-2.5 py-0.5 text-2xs text-muted-foreground backdrop-blur-md">
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
        <p role="alert" className="relative z-10 mx-3 mb-2 text-xs">
          {sendError}
        </p>
      )}
      {conversationShown ? (
        <Composer
          draft={draft}
          disabled={availability.status !== "available"}
          placeholder={blocked ? "Unavailable" : "Message the orchestrator"}
          canSend={canSend}
          onDraft={setDraft}
          onSubmit={() => void submit()}
        />
      ) : null}
    </aside>
  );
}
