import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { GitBranchIcon, RotateCcwIcon } from "lucide-react";
import * as Cause from "effect/Cause";
import { type CSSProperties, useEffect, useEffectEvent, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { resolveShortcutCommand } from "../keybindings";
import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useOrchestratorDock } from "../state/orchestratorAgent";
import { primaryServerKeybindingsAtom } from "../state/server";
import { readPreparedConnection, useEnvironmentScope } from "../state/session";
import { ideOpen, ideSetTheme } from "../state/ide";
import { useAtomCommand } from "../state/use-atom-command";
import { IdePresenceRail } from "./IdePresenceRail";
import { IdeSwitchButton } from "./IdeSwitchButton";
import { useIdeSurface } from "./ideSurfaceStore";
import { buildIdeTheme } from "./vscodeTheme";

export interface IdeTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

type EditorState =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly src: string }
  | { readonly status: "failed"; readonly message: string };

const THEME_ATTRIBUTES = ["class", "style", "data-theme-id"];
const MACOS_TRAFFIC_LIGHTS_INSET = "var(--desktop-window-controls-inset, 90px)";

function useThemeSync(environmentId: EnvironmentId, active: boolean) {
  const setTheme = useAtomCommand(ideSetTheme, "apply the theme to the IDE");
  const push = useEffectEvent(async (target: EnvironmentId) => {
    const root = document.documentElement;
    const input = await buildIdeTheme(root, root.classList.contains("dark") ? "dark" : "light");
    await setTheme({ environmentId: target, input });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the document's live theme into the editor process
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void push(environmentId), 120);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { attributeFilter: THEME_ATTRIBUTES });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [active, environmentId]);
}

function EditorFrame(props: { readonly target: IdeTarget; readonly visible: boolean }) {
  const { target } = props;
  const open = useAtomCommand(ideOpen, "open the IDE");
  const [state, setState] = useState<EditorState>({ status: "starting" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const load = useEffectEvent(async (input: IdeTarget) => {
    const result = await open({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, projectId: input.projectId },
    });
    const connection = readPreparedConnection(input.environmentId);
    if (result._tag !== "Success" || connection === null) {
      const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
      setState({
        status: "failed",
        message:
          cause instanceof Error ? cause.message : "The environment is not connected right now.",
      });
      return;
    }
    setState({
      status: "ready",
      src: new URL(result.value.path, connection.httpBaseUrl).toString(),
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the editor process on the environment for this folder
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the URL arrives once the editor process on the environment answers
    void load({
      environmentId: target.environmentId,
      threadId: target.threadId,
      projectId: target.projectId,
    });
  }, [target.environmentId, target.threadId, target.projectId]);

  useThemeSync(target.environmentId, state.status === "ready");

  const ready = state.status === "ready";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keyboard focus follows the surface the window shows
  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null || !ready) return;
    if (props.visible) frame.focus();
    else if (document.activeElement === frame) frame.blur();
  }, [props.visible, ready]);

  // Keys pressed inside the editor never reach the app, so the frame forwards the two that leave it.
  const forwardShortcuts = () => {
    const frameWindow = frameRef.current?.contentWindow;
    if (!frameWindow) return;
    try {
      frameWindow.addEventListener(
        "keydown",
        (event) => {
          const command = resolveShortcutCommand(event, keybindings);
          if (command === "ide.toggle") useIdeSurface.getState().toggle();
          else if (command === "orchestrator.toggle") useOrchestratorDock.getState().toggle();
          else return;
          event.preventDefault();
          event.stopPropagation();
        },
        { capture: true },
      );
    } catch {
      // A cross-origin editor keeps its keys; the header buttons still work.
    }
  };

  if (state.status === "failed") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-sm text-foreground">The editor could not start.</p>
        <p className="max-w-sm text-xs text-muted-foreground">{state.message}</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setState({ status: "starting" });
            void load(target);
          }}
        >
          <RotateCcwIcon />
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div className="relative flex min-w-0 flex-1">
      {state.status === "starting" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
          <Spinner size="md" tone="muted" />
          <p className="text-xs text-muted-foreground">Starting the editor</p>
          <p className="max-w-xs text-2xs text-muted-foreground/80">
            The first start downloads it to this environment once, about 110 MB.
          </p>
        </div>
      ) : (
        // oxlint-disable-next-line react/iframe-missing-sandbox -- the editor is a whole application from this environment: scripts, storage, popups, and downloads
        <iframe
          ref={frameRef}
          title="Editor"
          src={state.src}
          onLoad={forwardShortcuts}
          allow="clipboard-read; clipboard-write"
          className="ide-frame-enter size-full border-0 bg-background"
          tabIndex={props.visible ? 0 : -1}
        />
      )}
    </div>
  );
}

function IdeBreadcrumb(props: { readonly target: IdeTarget }) {
  const project = useProject(scopeProjectRef(props.target.environmentId, props.target.projectId));
  const shell = useQuietThreadShell(
    scopeThreadRef(props.target.environmentId, props.target.threadId),
  );
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
      <span className="truncate">{project?.title ?? ""}</span>
      {shell?.branch ? (
        <>
          <span aria-hidden className="text-muted-foreground/50">
            /
          </span>
          <span className="flex min-w-0 items-center gap-1">
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{shell.branch}</span>
          </span>
        </>
      ) : null}
    </div>
  );
}

/** IDE mode: covers the window with the editor, an agent rail, and the orchestrator's window. */
export function IdeSurface(props: { readonly target: IdeTarget | null }) {
  const surface = useIdeSurface((state) => state.surface);
  const setOrchestratorSlot = useIdeSurface((state) => state.setOrchestratorSlot);
  const orchestratorOpen = useOrchestratorDock((state) => state.open);
  const visible = surface === "ide" && props.target !== null;
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const canOperate = useEnvironmentScope(
    props.target?.environmentId ?? null,
    AuthTerminalOperateScope,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the conversation underneath leaves the tab order and stops painting
  useEffect(() => {
    const root = document.getElementById("root");
    if (root === null) return;
    root.inert = visible;
    document.documentElement.dataset.windowSurface = visible ? "ide" : "chat";
    return () => {
      root.inert = false;
      delete document.documentElement.dataset.windowSurface;
    };
  }, [visible]);

  if (!mounted || props.target === null) return null;
  const threadRef = scopeThreadRef(props.target.environmentId, props.target.threadId);
  return createPortal(
    <div
      data-ide-surface
      aria-hidden={!visible}
      inert={!visible}
      style={
        isElectron && isMacPlatform(navigator.platform)
          ? ({ "--workspace-controls-left": MACOS_TRAFFIC_LIGHTS_INSET } as CSSProperties)
          : undefined
      }
      data-visible={visible}
      className="ide-surface fixed inset-0 z-40 flex flex-col bg-background text-foreground"
    >
      <header className="drag-region flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b border-border pr-(--workspace-controls-right) pl-(--workspace-controls-left)">
        <span className="text-sm font-semibold tracking-tight">
          T3<span className="text-muted-foreground">++</span>
        </span>
        <IdeBreadcrumb target={props.target} />
        <div className="ml-auto flex items-center gap-1 [-webkit-app-region:no-drag]">
          <IdeSwitchButton target="chat" />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {canOperate ? (
          <EditorFrame key={props.target.environmentId} target={props.target} visible={visible} />
        ) : (
          <p className="m-auto max-w-sm p-6 text-center text-sm text-muted-foreground">
            Opening the IDE needs permission to run terminals in this environment.
          </p>
        )}
        <div
          ref={setOrchestratorSlot}
          data-ide-orchestrator-window
          data-open={orchestratorOpen}
          className="ide-window absolute top-2 right-14 bottom-2 z-10 w-96 max-w-[calc(100%-4.5rem)] overflow-hidden rounded-2xl border border-border bg-background shadow-lg/10"
        />
        <IdePresenceRail threadRef={threadRef} projectId={props.target.projectId} />
      </div>
    </div>,
    document.body,
  );
}
