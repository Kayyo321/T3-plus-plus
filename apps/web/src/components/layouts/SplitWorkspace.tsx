import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { Link2Icon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  closeSplitPane,
  collapseSplitPane,
  focusSplitPane,
  setSplitLinked,
  showThreadInPane,
} from "../../layouts/layoutActions";
import { useLayoutDragStore } from "../../layouts/layoutDrag";
import { dropZoneRect, layoutRectStyle, type LayoutRect } from "../../layouts/layoutDocument";
import {
  COLLAPSED_PANE_WIDTH_PX,
  paneTargetKey,
  resizePanes,
  resolveExpandedPaneIds,
  syncRoute,
  type SplitPane,
} from "../../layouts/splitView.logic";
import { updateSplitView, useSplitViewStore } from "../../layouts/splitViewStore";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { useQuietThreadShell, useThreadShells } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { LinkedTimelineContext, linkedTimelineFor } from "../chat/linkedTimeline";
import { Button } from "../ui/button";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadPaneView } from "./ThreadPaneView";

const PICKER_THREAD_LIMIT = 8;
const FULL_PANE_RECT: LayoutRect = {
  left: { pct: 0, px: 0 },
  top: { pct: 0, px: 0 },
  width: { pct: 100, px: 0 },
  height: { pct: 100, px: 0 },
};
const paneRef = (pane: SplitPane) =>
  pane.target?.kind === "server" ? pane.target.threadRef : null;

/**
 * One or more conversations side by side. The ordinary case is one pane following the route, in
 * the same element it holds when split, so opening a second pane does not remount the first.
 * A pane that does not fit, or was collapsed, is a rail: its ChatView unmounts, so it stops
 * subscribing to the thread's stream and costs one shell read.
 */
export function SplitWorkspace(props: { routeTarget: ThreadRouteTarget; background: boolean }) {
  const { routeTarget, background } = props;
  const panes = useSplitViewStore((state) => state.panes);
  const focusedPaneId = useSplitViewStore((state) => state.focusedPaneId);
  const soloPaneId = useSplitViewStore((state) => state.soloPaneId);
  const sizes = useSplitViewStore((state) => state.sizes);
  const linked = useSplitViewStore((state) => state.linked);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  const [dragSizes, setDragSizes] = useState<ReadonlyArray<number> | null>(null);
  const routeKey = paneTargetKey(routeTarget);
  const syncedRouteKey = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the URL is external to the pane store, and must settle before paint so a pane never shows the previous conversation
  useLayoutEffect(() => {
    // Only a navigation syncs. A focused pane waits for its own navigation to commit, and syncing
    // the old route in the meantime would hand focus straight back.
    if (syncedRouteKey.current === routeKey) return;
    syncedRouteKey.current = routeKey;
    updateSplitView((state) => syncRoute(state, routeTarget));
  }, [routeKey, routeTarget]);
  const split = panes.length > 0;
  const shown: ReadonlyArray<SplitPane> = split ? panes : [{ id: soloPaneId, target: routeTarget }];
  const expanded = split ? resolveExpandedPaneIds({ panes, focusedPaneId }, width) : null;
  const shownSizes = dragSizes ?? sizes;
  const attachContainer = (element: HTMLDivElement) =>
    observeResize(element, () => setWidth(element.getBoundingClientRect().width));

  return (
    <div ref={attachContainer} className="flex h-full min-h-0 min-w-0 flex-1" data-split-workspace>
      {shown.flatMap((pane, index) => {
        const isExpanded = expanded === null || expanded.has(pane.id);
        const nextPane = shown[index + 1];
        const frame = (
          <SplitPaneFrame
            key={pane.id}
            pane={pane}
            split={split}
            expanded={isExpanded}
            focused={!split || pane.id === focusedPaneId}
            size={shownSizes[index] ?? 1}
            atWindowEdge={nextPane === undefined}
            background={background}
            linked={linked}
          />
        );
        if (!split || nextPane === undefined) return [frame];
        return [
          frame,
          <SplitPaneHandle
            key={`handle:${pane.id}`}
            sizes={sizes}
            index={index}
            label={`Resize between panes ${index + 1} and ${index + 2}`}
            containerWidth={width}
            onPreview={setDragSizes}
          />,
        ];
      })}
    </div>
  );
}

function SplitPaneFrame(props: {
  pane: SplitPane;
  split: boolean;
  expanded: boolean;
  focused: boolean;
  size: number;
  atWindowEdge: boolean;
  background: boolean;
  linked: boolean;
}) {
  const { pane, split, expanded, focused, size, atWindowEdge, background, linked } = props;
  const paneId = pane.id;
  const takeFocus = () => {
    if (split && !focused) focusSplitPane(paneId);
  };
  if (split && !expanded) {
    return <SplitPaneRail pane={pane} focused={focused} atWindowEdge={atWindowEdge} />;
  }
  const style: CSSProperties = { flexGrow: size, flexBasis: 0 };
  const view =
    pane.target === null ? (
      <SplitPanePicker paneId={paneId} />
    ) : (
      <ThreadPaneView
        target={pane.target}
        background={background}
        inactive={!focused}
        onThreadMissing={() => closeSplitPane(paneId)}
      />
    );
  return (
    <div
      data-split-pane={paneId}
      data-split-drop-pane={paneId}
      data-split-pane-focused={focused ? "true" : "false"}
      style={style}
      className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
      onPointerDownCapture={takeFocus}
      onFocusCapture={takeFocus}
    >
      {split ? (
        <SplitPaneStrip pane={pane} focused={focused} linked={linked} atWindowEdge={atWindowEdge} />
      ) : null}
      {/* Layout containment makes this the containing block for ChatView's fixed titlebar
          controls, so each pane keeps its own instead of stacking them at the window corner. */}
      <div className={cn("relative flex min-h-0 min-w-0 flex-1", split && "[contain:layout]")}>
        <LinkedTimelineContext value={split && linked ? linkedTimelineFor(focused) : null}>
          {view}
        </LinkedTimelineContext>
      </div>
      <SplitDropHighlight paneId={paneId} />
    </div>
  );
}

function SplitDropHighlight(props: { paneId: string }) {
  const zone = useLayoutDragStore((state) =>
    state.payload?.kind === "thread" && state.hover?.targetId === props.paneId
      ? state.hover.zone
      : null,
  );
  if (zone === null) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-40 rounded-md bg-primary/15 ring-1 ring-primary/40 ring-inset"
      style={layoutRectStyle(dropZoneRect(FULL_PANE_RECT, zone))}
    />
  );
}

function SplitPaneStrip(props: {
  pane: SplitPane;
  focused: boolean;
  linked: boolean;
  atWindowEdge: boolean;
}) {
  const { pane, focused, linked, atWindowEdge } = props;
  const ref = paneRef(pane);
  const shell = useQuietThreadShell(ref);
  const title =
    shell?.title ?? (pane.target === null ? "Choose a conversation" : "New conversation");
  return (
    <div
      data-split-pane-strip
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 border-b border-border pr-1 pl-2 text-xs",
        focused ? "bg-accent text-foreground" : "text-muted-foreground",
        atWindowEdge && "wco:pr-(--workspace-native-controls-inset)",
      )}
    >
      <PaneRunDot shell={shell} />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label="Link panes by turn"
              pressed={linked}
              onPressedChange={setSplitLinked}
              size="xs"
              variant="ghost"
            >
              <Link2Icon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">Link panes by turn</TooltipPopup>
      </Tooltip>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Collapse ${title}`}
        onClick={() => collapseSplitPane(pane.id, true)}
      >
        <PanelLeftCloseIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${title}`}
        onClick={() => closeSplitPane(pane.id)}
      >
        <XIcon />
      </Button>
    </div>
  );
}

// Static: a pane can stay running for a whole turn, and a pulse would repaint for all of it.
function PaneRunDot(props: { shell: EnvironmentThreadShell | null }) {
  const { shell } = props;
  if (shell === null) return null;
  const needsYou = shell.hasPendingApprovals || shell.hasPendingUserInput;
  if (!needsYou && !threadRuntimeIsActive(shell.runtime)) return null;
  return (
    <span
      aria-label={needsYou ? "Needs you" : "Running"}
      role="img"
      className={cn("size-1.5 shrink-0 rounded-full", needsYou ? "bg-info" : "bg-muted-foreground")}
    />
  );
}

function SplitPaneRail(props: { pane: SplitPane; focused: boolean; atWindowEdge: boolean }) {
  const { pane } = props;
  const shell = useQuietThreadShell(paneRef(pane));
  const title = shell?.title ?? "Conversation";
  return (
    <div
      data-split-pane={pane.id}
      data-split-drop-pane={pane.id}
      style={{ width: COLLAPSED_PANE_WIDTH_PX }}
      className={cn(
        "flex min-h-0 shrink-0 flex-col items-center gap-2 border-r border-border py-1",
        props.atWindowEdge && "wco:pt-(--workspace-topbar-height)",
      )}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Expand ${title}`}
        onClick={() => collapseSplitPane(pane.id, false)}
      >
        <PanelLeftOpenIcon />
      </Button>
      <PaneRunDot shell={shell} />
      <button
        type="button"
        className="min-h-0 flex-1 cursor-pointer truncate text-xs text-muted-foreground [writing-mode:vertical-rl] hover:text-foreground"
        onClick={() => focusSplitPane(pane.id)}
      >
        {title}
      </button>
    </div>
  );
}

function SplitPaneHandle(props: {
  sizes: ReadonlyArray<number>;
  index: number;
  label: string;
  containerWidth: number;
  onPreview: (sizes: ReadonlyArray<number> | null) => void;
}) {
  const { sizes, index, containerWidth, onPreview } = props;
  const [dragStartX, setDragStartX] = useState<number | null>(null);
  const resized = (deltaPx: number) =>
    resizePanes(sizes, index, deltaPx / Math.max(containerWidth, 1));
  const commit = (next: ReadonlyArray<number>) => {
    onPreview(null);
    updateSplitView((state) => ({ ...state, sizes: next }));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStartX(event.clientX);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartX !== null) onPreview(resized(event.clientX - dragStartX));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStartX === null) return;
    commit(resized(event.clientX - dragStartX));
    setDragStartX(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    commit(resized(event.key === "ArrowLeft" ? -24 : 24));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      tabIndex={0}
      className="group relative z-20 w-px shrink-0 cursor-col-resize bg-border outline-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDragStartX(null);
        onPreview(null);
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className="absolute inset-y-0 -left-1 w-2 transition-colors duration-150 group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}

/** What a new pane shows until it has a conversation: related threads first, then recent ones. */
function SplitPanePicker(props: { paneId: string }) {
  const threads = useThreadShells();
  const panes = useSplitViewStore((state) => state.panes);
  const shownKeys = panes.map((pane) => paneTargetKey(pane.target));
  const anchorPane = panes.find((pane) => pane.target?.kind === "server");
  const anchor = anchorPane ? paneRef(anchorPane) : null;
  const anchorThread = threads.find(
    (thread) => thread.environmentId === anchor?.environmentId && thread.id === anchor?.threadId,
  );
  const related = (thread: EnvironmentThreadShell) =>
    anchorThread !== undefined &&
    (thread.lineage.parentThreadId === anchorThread.id ||
      anchorThread.lineage.parentThreadId === thread.id);
  const candidates = threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        !shownKeys.includes(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    )
    .toSorted(
      (a, b) => Number(related(b)) - Number(related(a)) || b.updatedAt.localeCompare(a.updatedAt),
    )
    .slice(0, PICKER_THREAD_LIMIT);
  return (
    <div className="scrollbar-gutter-both flex min-h-0 w-full flex-col items-center justify-center gap-3 overflow-y-auto p-6">
      <p className="text-sm font-medium">Choose a conversation</p>
      <p className="text-center text-xs text-muted-foreground">
        Pick one here, or click any conversation in the sidebar.
      </p>
      <div className="flex w-full max-w-xs flex-col gap-0.5">
        {candidates.map((thread) => (
          <button
            key={`${thread.environmentId}:${thread.id}`}
            type="button"
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-2.5 text-left text-sm hover:bg-accent/60"
            onClick={() =>
              showThreadInPane(props.paneId, scopeThreadRef(thread.environmentId, thread.id))
            }
          >
            <span className="min-w-0 flex-1 truncate">{thread.title}</span>
            {related(thread) ? (
              <span className="shrink-0 text-xs text-muted-foreground">Related</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
