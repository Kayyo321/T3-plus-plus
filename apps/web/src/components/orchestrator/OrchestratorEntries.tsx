import { ArrowRightIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useOrchestratorDock } from "../../state/orchestratorAgent";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Kbd } from "../ui/kbd";
import { OrchestratorGlyph } from "./OrchestratorGlyph";
import { useOrchestratorStatus } from "./useOrchestratorStatus";

function useOrchestratorShortcut() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return shortcutLabelForCommand(keybindings, "orchestrator.toggle");
}

/** The sidebar's way in. Idle stays still here because the sidebar is always on screen. */
function SidebarRow(props: {
  readonly environmentId: Parameters<typeof useOrchestratorStatus>[0];
}) {
  const status = useOrchestratorStatus(props.environmentId);
  const open = useOrchestratorDock((state) => state.open);
  const toggle = useOrchestratorDock((state) => state.toggle);
  const shortcut = useOrchestratorShortcut();
  return (
    <button
      type="button"
      data-active={open}
      aria-pressed={open}
      className="group/orchestrator flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-sidebar-foreground transition-colors duration-150 hover:bg-sidebar-row-hover data-[active=true]:bg-sidebar-row-active"
      onClick={toggle}
    >
      <OrchestratorGlyph size={16} motion={status.motion === "working" ? "working" : "still"} />
      <span className="min-w-0 flex-1 truncate">Orchestrator</span>
      {status.needsYou ? (
        <span className="truncate text-xs text-warning-foreground">{status.label}</span>
      ) : status.unread && !open ? (
        <span
          role="img"
          aria-label="New message"
          className="orchestrator-reaction-pop size-2 shrink-0 rounded-full bg-primary"
        />
      ) : shortcut ? (
        <span className="opacity-0 transition-opacity group-hover/orchestrator:opacity-100">
          <Kbd>{shortcut}</Kbd>
        </span>
      ) : null}
    </button>
  );
}

export function OrchestratorSidebarRow() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <SidebarRow environmentId={environmentId} />;
}

function Launcher(props: { readonly environmentId: Parameters<typeof useOrchestratorStatus>[0] }) {
  const status = useOrchestratorStatus(props.environmentId);
  const setOpen = useOrchestratorDock((state) => state.setOpen);
  const shortcut = useOrchestratorShortcut();
  return (
    <button
      type="button"
      data-orchestrator-launcher
      className="group/launcher flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2 text-left transition-[border-color,background-color] duration-200 hover:border-primary/50 hover:bg-accent"
      onClick={() => setOpen(true)}
    >
      <OrchestratorGlyph size={52} motion={status.motion === "still" ? "idle" : status.motion} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          Orchestrator
          <span
            className={cn(
              "font-mono text-2xs tracking-wide uppercase",
              status.needsYou ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {status.label}
          </span>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          Hand it the whole job: it starts threads, watches runs, and calls you when it matters.
        </span>
      </span>
      {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover/launcher:translate-x-0.5 group-hover/launcher:text-foreground" />
    </button>
  );
}

/** Sits under the new thread composer so the orchestrator is the other obvious way to start. */
export function OrchestratorLauncher() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId === null ? null : <Launcher environmentId={environmentId} />;
}
