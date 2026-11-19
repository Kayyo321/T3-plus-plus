import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { type ScopedThreadRef, threadInitial, threadLane } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { MessageCircleIcon } from "lucide-react";
import { useState } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { EnvironmentSubagentAvatar } from "../components/chat/V2LifecycleRow";
import { OrchestratorGlyph } from "../components/orchestrator/OrchestratorGlyph";
import { useOrchestratorStatus } from "../components/orchestrator/useOrchestratorStatus";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { useThreadShellsForProjectRefs } from "../state/entities";
import { useOrchestratorDock } from "../state/orchestratorAgent";
import { environmentThreadDetails } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { useIdeSurface } from "./ideSurfaceStore";
import { presenceLabel, presenceThreads } from "./presence.logic";

type ThreadStatus = ReturnType<typeof resolveSidebarThreadStatus>;

const STATUS_DOT: Record<ThreadStatus, string> = {
  working: "bg-primary",
  waiting: "bg-muted-foreground",
  approval: "bg-warning",
  input: "bg-warning",
  request: "bg-warning",
  ready: "bg-success",
  failed: "bg-destructive",
  limited: "bg-destructive",
};

const needsYou = (status: ThreadStatus) =>
  status === "approval" || status === "input" || status === "request";

function SubagentStack(props: { readonly threadRef: ScopedThreadRef }) {
  const subagents = useAtomValue(
    environmentThreadDetails.threadAtom(props.threadRef),
    (thread) => thread?.projection.subagents,
  );
  const live = (subagents ?? []).filter((agent) =>
    ["pending", "running", "waiting"].includes(agent.status),
  );
  if (live.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-1" data-ide-subagents>
      <span aria-hidden className="font-mono text-2xs leading-none text-muted-foreground/60">
        │
      </span>
      {live.slice(0, 4).map((agent) => (
        <Tooltip key={agent.id}>
          <TooltipTrigger
            render={<span className="ide-rail-enter flex size-6 items-center justify-center" />}
          >
            <EnvironmentSubagentAvatar
              environmentId={props.threadRef.environmentId}
              providerInstanceId={agent.providerInstanceId}
              driver={agent.driver}
              remote={agent.remoteChild}
              status={agent.status === "waiting" ? "running" : agent.status}
            />
          </TooltipTrigger>
          <TooltipPopup side="left">{agent.title ?? agent.prompt.slice(0, 60)}</TooltipPopup>
        </Tooltip>
      ))}
      {live.length > 4 ? (
        <span className="text-2xs text-muted-foreground">+{live.length - 4}</span>
      ) : null}
    </div>
  );
}

function ThreadAvatar(props: {
  readonly thread: EnvironmentThreadShell;
  readonly current: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const setSurface = useIdeSurface((state) => state.setSurface);
  const status = resolveSidebarThreadStatus(props.thread);
  const threadRef = scopeThreadRef(props.thread.environmentId, props.thread.id);
  const openInChat = () => {
    props.onOpenChange(false);
    setSurface("chat");
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  return (
    <div className="flex flex-col items-center gap-1">
      <Popover open={props.open} onOpenChange={props.onOpenChange}>
        <PopoverTrigger
          openOnHover
          delay={150}
          render={
            <button
              type="button"
              aria-label={`${props.thread.title}: ${presenceLabel(status)}`}
              data-current={props.current}
              data-needs-you={needsYou(status)}
              style={{ color: `var(--git-lane-${threadLane(props.thread.id)})` }}
              className="ide-rail-enter relative flex size-8 items-center justify-center rounded-lg bg-accent text-xs font-semibold outline-none transition-[background-color,box-shadow] duration-150 hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[current=true]:ring-1 data-[current=true]:ring-border data-[needs-you=true]:ring-1 data-[needs-you=true]:ring-warning"
            />
          }
        >
          {threadInitial(props.thread.title)}
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-background",
              STATUS_DOT[status],
            )}
          />
        </PopoverTrigger>
        <PopoverPopup side="left" align="start" sideOffset={10} className="w-72">
          <div className="flex flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])} />
              <span className="min-w-0 truncate text-sm font-medium">{props.thread.title}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {presenceLabel(status)}
              {props.thread.branch ? ` on ${props.thread.branch}` : ""}
            </p>
            <div className="flex justify-end">
              <Button
                size="xs"
                variant={needsYou(status) ? "default" : "secondary"}
                onClick={openInChat}
              >
                <MessageCircleIcon />
                {needsYou(status) ? "Answer in chat" : "Open in chat"}
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
      {props.current ? <SubagentStack threadRef={threadRef} /> : null}
    </div>
  );
}

/** The Margin rail: who is working in this project, and a way to each of them. */
export function IdePresenceRail(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: EnvironmentThreadShell["projectId"];
}) {
  const shells = useThreadShellsForProjectRefs([
    scopeProjectRef(props.threadRef.environmentId, props.projectId),
  ]);
  const threads = presenceThreads(shells, props.threadRef.threadId, resolveSidebarThreadStatus);
  const orchestratorOpen = useOrchestratorDock((state) => state.open);
  const toggleOrchestrator = useOrchestratorDock((state) => state.toggle);
  const orchestratorStatus = useOrchestratorStatus(props.threadRef.environmentId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  // A thread that starts waiting on the user raises its window once per request.
  const raiseKey = (thread: EnvironmentThreadShell) =>
    `${thread.id}@${thread.latestRun?.runId ?? ""}:${resolveSidebarThreadStatus(thread)}`;
  const raised = threads.find(
    (thread) => needsYou(resolveSidebarThreadStatus(thread)) && !dismissed.has(raiseKey(thread)),
  );
  const shownId = orchestratorOpen ? null : (openId ?? raised?.id ?? null);

  return (
    <nav
      aria-label="Agents in this project"
      className="flex w-12 shrink-0 flex-col items-center gap-2 overflow-y-auto scrollbar-gutter-both border-l border-border bg-background py-2"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Orchestrator"
              aria-pressed={orchestratorOpen}
              data-pressed={orchestratorOpen ? "" : undefined}
              onClick={toggleOrchestrator}
            />
          }
        >
          <OrchestratorGlyph
            size={18}
            motion={orchestratorStatus.motion === "working" ? "working" : "still"}
          />
        </TooltipTrigger>
        <TooltipPopup side="left">Orchestrator</TooltipPopup>
      </Tooltip>
      <span aria-hidden className="h-px w-5 bg-border" />
      {threads.map((thread) => (
        <ThreadAvatar
          key={thread.id}
          thread={thread}
          current={thread.id === props.threadRef.threadId}
          open={shownId === thread.id}
          onOpenChange={(open) => {
            setOpenId(open ? thread.id : null);
            if (!open) setDismissed((previous) => new Set(previous).add(raiseKey(thread)));
          }}
        />
      ))}
    </nav>
  );
}
