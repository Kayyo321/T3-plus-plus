import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProjectId,
  resolveThreadSupervisionMode,
  type ScopedThreadRef,
  SUPERVISION_MODE_INFO,
  SUPERVISION_MODES,
  type SupervisionMode,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { orchestratorEnvironment } from "~/state/orchestratorAgent";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { OrchestratorGlyph } from "../orchestrator/OrchestratorGlyph";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const GLYPH_SIZE = 16;

function ManagedByProjectButton({
  threadRef,
  projectId,
  labelClassName,
  reviewing,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly labelClassName: string;
  readonly reviewing: boolean;
}) {
  const navigate = useNavigate();
  const project = useProject(scopeProjectRef(threadRef.environmentId, projectId));
  const grouping = useClientSettings(selectProjectGroupingSettings);
  return (
    <button
      type="button"
      disabled={project === undefined || project === null}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:underline disabled:cursor-default"
      onClick={() => {
        if (!project) return;
        void navigate({
          to: "/settings/projects",
          search: {
            project: deriveLogicalProjectKeyFromSettings(project, grouping),
            machine: undefined,
          },
          hash: "supervision-mode",
        });
      }}
    >
      <OrchestratorGlyph size={GLYPH_SIZE} motion={reviewing ? "working" : "still"} />
      <span className={labelClassName}>Supervision</span>
      <span className="ml-auto shrink-0 text-muted-foreground text-xs">Managed by project</span>
    </button>
  );
}

/** Beneath Remote Control. The glyph moves only while a review of this thread is running. */
export function SupervisionDetailsRow({
  threadRef,
  projectId,
  threadStarted,
  labelClassName,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly threadStarted: boolean;
  readonly labelClassName: string;
}) {
  const { environmentId, threadId } = threadRef;
  const live = useAtomValue(orchestratorEnvironment.live({ environmentId, input: {} }));
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  const canSet = useAtomValue(
    orchestratorEnvironment.setThreadSupervision.permissionAtom(environmentId),
  );
  const setThreadSupervision = useAtomCommand(orchestratorEnvironment.setThreadSupervision, {
    label: "change supervision",
  });
  // The range shows the choice while the live snapshot catches up, as it can over a slow link.
  const [pending, setPending] = useState<SupervisionMode | null>(null);
  if (live._tag !== "Success") return null;
  const snapshot = live.value;
  const reviewing = snapshot.supervisionReviewing === threadId;
  const threadMode = snapshot.supervisionThreadModes?.[threadId];
  const { mode, source } = resolveThreadSupervisionMode(settings, projectId, threadMode);

  if (source === "project") {
    return (
      <ManagedByProjectButton
        threadRef={threadRef}
        projectId={projectId}
        labelClassName={labelClassName}
        reviewing={reviewing}
      />
    );
  }

  const shown = pending ?? mode;
  const index = SUPERVISION_MODES.indexOf(shown);
  const save = async (next: SupervisionMode | null) => {
    setPending(next ?? settings.supervisionMode);
    await setThreadSupervision({ environmentId, input: { threadId, mode: next } });
    setPending(null);
  };
  // A drag previews each stop and saves once, so passing through Modest records nothing.
  const commit = (input: HTMLInputElement) => {
    const next = SUPERVISION_MODES[input.valueAsNumber];
    if (next !== undefined && next !== mode) void save(next);
    else setPending(null);
  };

  return (
    <div className="flex h-8 min-w-0 items-center gap-2 rounded-lg px-2.5 transition-colors hover:bg-accent/50">
      <OrchestratorGlyph size={GLYPH_SIZE} motion={reviewing ? "working" : "still"} />
      <span className={cn(labelClassName, "mr-auto")}>Supervision</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="relative flex shrink-0 rounded-md bg-foreground/[0.06] p-0.5 has-focus-visible:ring-2 has-focus-visible:ring-inset has-focus-visible:ring-ring has-disabled:opacity-50" />
          }
        >
          <div
            className="absolute h-4 w-5 rounded-sm bg-foreground/15 transition-transform duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: `translateX(${index * 100}%)` }}
          />
          {SUPERVISION_MODES.map((candidate) => (
            <div key={candidate} className="flex h-4 w-5 items-center justify-center">
              <div
                className={cn(
                  "size-1 rounded-full bg-muted-foreground/70 transition-opacity duration-150 motion-reduce:transition-none",
                  candidate === shown && "opacity-0",
                )}
              />
            </div>
          ))}
          <input
            type="range"
            min={0}
            max={SUPERVISION_MODES.length - 1}
            step={1}
            aria-label="Supervision"
            aria-valuetext={SUPERVISION_MODE_INFO[shown].label}
            disabled={!threadStarted || !canSet}
            value={index}
            className="absolute inset-0 m-0 size-full cursor-pointer opacity-0 disabled:cursor-default"
            onChange={(event) => {
              const next = SUPERVISION_MODES[event.currentTarget.valueAsNumber];
              if (next !== undefined) setPending(next);
            }}
            onPointerDown={(event) => {
              const input = event.currentTarget;
              // A mouse released off the track never reaches the input.
              window.addEventListener("pointerup", () => commit(input), { once: true });
            }}
            onKeyUp={(event) => commit(event.currentTarget)}
          />
        </TooltipTrigger>
        <TooltipPopup side="left">
          {!threadStarted
            ? "Send a message first. Supervision follows one conversation."
            : snapshot.supervision.status === "paused"
              ? `Paused. ${snapshot.supervision.reason}`
              : SUPERVISION_MODE_INFO[shown].description}
        </TooltipPopup>
      </Tooltip>
      {source === "thread" ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                disabled={!canSet}
                aria-label={`${SUPERVISION_MODE_INFO[shown].label}. Use the default instead.`}
                className="w-16 shrink-0 cursor-pointer text-right text-foreground/80 text-xs outline-none hover:text-foreground hover:underline focus-visible:underline disabled:cursor-default"
                onClick={() => void save(null)}
              />
            }
          >
            {SUPERVISION_MODE_INFO[shown].label}
          </TooltipTrigger>
          <TooltipPopup side="left">Use the default</TooltipPopup>
        </Tooltip>
      ) : (
        <span className="w-16 shrink-0 text-right text-muted-foreground text-xs">
          {SUPERVISION_MODE_INFO[shown].label}
        </span>
      )}
    </div>
  );
}
