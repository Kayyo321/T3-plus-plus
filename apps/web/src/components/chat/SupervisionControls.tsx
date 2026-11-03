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
import { useProject } from "~/state/entities";
import { orchestratorEnvironment } from "~/state/orchestratorAgent";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { OrchestratorGlyph } from "../orchestrator/OrchestratorGlyph";
import { Button } from "../ui/button";
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
  const save = async (next: SupervisionMode | null) => {
    setPending(next ?? settings.supervisionMode);
    await setThreadSupervision({ environmentId, input: { threadId, mode: next } });
    setPending(null);
  };

  return (
    <div className="flex flex-col gap-1 px-2.5 pb-2">
      <div className="flex h-8 min-w-0 items-center gap-2.5">
        <OrchestratorGlyph size={GLYPH_SIZE} motion={reviewing ? "working" : "still"} />
        <span className={labelClassName}>Supervision</span>
        {source === "thread" ? (
          <Button
            className="ml-auto"
            size="xs"
            variant="ghost-muted"
            disabled={!canSet}
            onClick={() => void save(null)}
          >
            Use default
          </Button>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <input
              type="range"
              min={0}
              max={SUPERVISION_MODES.length - 1}
              step={1}
              aria-label="Supervision"
              aria-valuetext={SUPERVISION_MODE_INFO[shown].label}
              disabled={!threadStarted || !canSet}
              value={SUPERVISION_MODES.indexOf(shown)}
              className="h-4 w-full cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50"
              onChange={(event) => {
                const next = SUPERVISION_MODES[event.currentTarget.valueAsNumber];
                if (next !== undefined) void save(next);
              }}
            />
          }
        />
        <TooltipPopup side="left">
          {threadStarted
            ? SUPERVISION_MODE_INFO[shown].description
            : "Send a message first. Supervision follows one conversation."}
        </TooltipPopup>
      </Tooltip>
      <div className="flex justify-between text-2xs text-muted-foreground">
        {SUPERVISION_MODES.map((candidate) => (
          <span key={candidate} className={candidate === shown ? "text-foreground" : undefined}>
            {SUPERVISION_MODE_INFO[candidate].label}
          </span>
        ))}
      </div>
      {snapshot.supervision.status === "paused" ? (
        <p className="text-2xs text-muted-foreground">Paused. {snapshot.supervision.reason}</p>
      ) : null}
    </div>
  );
}
