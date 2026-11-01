import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { GripHorizontalIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useState,
} from "react";

import { beginLayoutDrag, useLayoutDragStore } from "../../layouts/layoutDrag";
import {
  type FlatLayoutGroup,
  type FlatLayoutHandle,
  flattenLayout,
  dropZoneRect,
  isConversationGroup,
  layoutLengthCss,
  layoutRectStyle,
  type LayoutDropZone,
  type LayoutLength,
  type LayoutNode,
  pruneGroups,
  resizeSplit,
} from "../../layouts/layoutDocument";
import {
  activeSurfaceOfGroup,
  closeGroup,
  moveConversation,
  moveSurface,
  setGroupCollapsed,
  surfacesInGroup,
  type ThreadArrangement,
} from "../../layouts/threadArrangement";
import { cn } from "../../lib/utils";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import { RightPanelSurfaceContent } from "../chat/RightPanelSurfaceContent";
import { RightPanelTabs, type RightPanelTabsProps } from "../RightPanelTabs";
import { Button } from "../ui/button";

const LAYOUT_SWITCH_ATTRIBUTE = "data-layout-switching";
const RESIZE_KEY_STEP = 0.02;

/** Animates a slot's geometry only while a layout is being applied, never during a resize drag. */
export const WORKBENCH_SLOT_CLASS =
  "absolute [[data-panel-animations=true]_[data-layout-switching]_&]:motion-safe:transition-[left,top,width,height,opacity] [[data-panel-animations=true]_[data-layout-switching]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_[data-layout-switching]_&]:motion-safe:ease-out [[data-panel-animations=true]_[data-layout-switching]_&]:motion-safe:starting:opacity-0";

/**
 * The chat column reads its place from variables on the shared parent, so a resize drag moves it
 * without rendering ChatView.
 */
export const WORKBENCH_CONVERSATION_STYLE = {
  left: "var(--workbench-chat-left)",
  top: "var(--workbench-chat-top)",
  width: "var(--workbench-chat-width)",
  height: "var(--workbench-chat-height)",
};

type WorkbenchTabsProps = Omit<
  RightPanelTabsProps,
  | "mode"
  | "maximized"
  | "open"
  | "surfaces"
  | "activeSurfaceId"
  | "children"
  | "layoutControls"
  | "inlineSize"
  | "widthStorageKey"
  | "defaultWidth"
  | "reserveTitlebarControls"
  | "shortcutsEnabled"
  | "onTabPointerDown"
>;

type WorkbenchContentProps = Omit<
  ComponentProps<typeof RightPanelSurfaceContent>,
  "surface" | "activeSurfaceId" | "visible"
>;

const contentTop = (top: LayoutLength) =>
  `calc(${layoutLengthCss(top)} + var(--workspace-topbar-height))`;
const contentHeight = (height: LayoutLength) =>
  `calc(${layoutLengthCss(height)} - var(--workspace-topbar-height))`;

const resolveFlatLayout = (root: LayoutNode, maximized: boolean) =>
  flattenLayout((maximized ? pruneGroups(root, isConversationGroup) : null) ?? root);

/**
 * Panels from a saved layout, as flat siblings of the chat column positioned from the arrangement.
 * Group chrome and surface content are separate layers keyed by group and by surface, so a surface
 * shown before and after a layout change keeps its instance and only moves.
 */
export function ThreadWorkbench(props: {
  readonly threadRef: ScopedThreadRef;
  readonly arrangement: ThreadArrangement;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly activeSurfaceId: string | null;
  readonly maximized: boolean;
  readonly container: HTMLElement | null;
  readonly tabs: WorkbenchTabsProps;
  readonly content: WorkbenchContentProps;
}) {
  const { threadRef, arrangement, surfaces, activeSurfaceId, maximized, container, tabs, content } =
    props;
  const threadKey = scopedThreadKey(threadRef);
  const [previewRoot, setPreviewRoot] = useState<LayoutNode | null>(null);
  const root = previewRoot ?? arrangement.root;
  const layout = resolveFlatLayout(root, maximized);
  const conversationRect =
    layout.groups.find((group) => isConversationGroup(group.node))?.rect ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the chat column's rectangle to CSS variables on the DOM parent both layers share
  useLayoutEffect(() => {
    if (!container || conversationRect === null) return;
    const style = layoutRectStyle(conversationRect);
    container.style.setProperty("--workbench-chat-left", style.left);
    container.style.setProperty("--workbench-chat-top", style.top);
    container.style.setProperty("--workbench-chat-width", style.width);
    container.style.setProperty("--workbench-chat-height", style.height);
  }, [container, conversationRect]);

  const { revision } = arrangement;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the shared DOM parent before paint for one panel-animation duration after a layout is applied
  useLayoutEffect(() => {
    if (!container) return;
    container.setAttribute(LAYOUT_SWITCH_ATTRIBUTE, "true");
    const duration =
      Number.parseFloat(
        getComputedStyle(container).getPropertyValue("--panel-animation-duration"),
      ) || 0;
    const timer = window.setTimeout(
      () => container.removeAttribute(LAYOUT_SWITCH_ATTRIBUTE),
      duration + 50,
    );
    return () => {
      window.clearTimeout(timer);
      container.removeAttribute(LAYOUT_SWITCH_ATTRIBUTE);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each applied layout restarts the marked window, which is what the revision counts.
  }, [container, revision]);

  const update = (next: (current: ThreadArrangement) => ThreadArrangement | null) =>
    useRightPanelStore.getState().updateArrangement(threadRef, next);
  const commitRoot = (nextRoot: LayoutNode) => {
    setPreviewRoot(null);
    update((current) => ({ ...current, root: nextRoot }));
  };
  const panelGroupsShown = layout.groups.filter((group) => !isConversationGroup(group.node));
  const dragOver = useLayoutDragStore((state) =>
    state.payload?.kind !== "thread" &&
    state.payload?.threadKey === threadKey &&
    state.hover !== null
      ? state.hover
      : null,
  );
  const dragGroup = layout.groups.find((group) => group.node.id === dragOver?.targetId);

  return (
    <>
      {panelGroupsShown.map((group) => (
        <WorkbenchGroup
          key={group.node.id}
          group={group}
          threadKey={threadKey}
          arrangement={arrangement}
          surfaces={surfaces}
          globalActiveSurfaceId={activeSurfaceId}
          tabs={tabs}
          onUpdate={update}
        />
      ))}
      {panelGroupsShown.flatMap((group) => {
        if (group.node.collapsed) return [];
        const surface = activeSurfaceOfGroup(arrangement, group.node, surfaces);
        if (surface === null) return [];
        return [
          <div
            key={surface.id}
            data-workbench-surface={surface.kind}
            className={cn(
              WORKBENCH_SLOT_CLASS,
              "flex min-h-0 min-w-0 flex-col overflow-hidden bg-background",
            )}
            style={{
              left: layoutLengthCss(group.rect.left),
              width: layoutLengthCss(group.rect.width),
              top: contentTop(group.rect.top),
              height: contentHeight(group.rect.height),
            }}
          >
            <RightPanelSurfaceContent
              {...content}
              surface={surface}
              activeSurfaceId={surface.id}
              visible
            />
          </div>,
        ];
      })}
      {layout.handles.map((handle) => (
        <WorkbenchHandle
          key={handle.id}
          handle={handle}
          root={arrangement.root}
          container={container}
          onPreview={setPreviewRoot}
          onCommit={commitRoot}
        />
      ))}
      {dragGroup && dragOver ? (
        <WorkbenchDropHighlight group={dragGroup} zone={dragOver.zone} />
      ) : null}
    </>
  );
}

function WorkbenchDropHighlight(props: { group: FlatLayoutGroup; zone: LayoutDropZone }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-40 rounded-md bg-primary/15 ring-1 ring-primary/40 ring-inset"
      style={layoutRectStyle(dropZoneRect(props.group.rect, props.zone))}
    />
  );
}

function WorkbenchGroup(props: {
  group: FlatLayoutGroup;
  threadKey: string;
  arrangement: ThreadArrangement;
  surfaces: ReadonlyArray<RightPanelSurface>;
  globalActiveSurfaceId: string | null;
  tabs: WorkbenchTabsProps;
  onUpdate: (next: (current: ThreadArrangement) => ThreadArrangement | null) => void;
}) {
  const { group, threadKey, arrangement, surfaces, globalActiveSurfaceId, tabs, onUpdate } = props;
  const groupId = group.node.id;
  const members = surfacesInGroup(arrangement, surfaces, groupId);
  const active = activeSurfaceOfGroup(arrangement, group.node, surfaces);
  const collapse = (collapsed: boolean) =>
    onUpdate((current) => setGroupCollapsed(current, groupId, collapsed));

  if (group.node.collapsed) {
    return (
      <div
        data-layout-drop-group={groupId}
        data-layout-drop-thread={threadKey}
        data-layout-drop-center="true"
        className={cn(
          WORKBENCH_SLOT_CLASS,
          "flex items-start justify-center overflow-hidden border-l border-border bg-background py-1",
        )}
        style={layoutRectStyle(group.rect)}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Expand ${active ? active.kind : "panel"}`}
          onClick={() => collapse(false)}
        >
          <PanelLeftOpenIcon />
        </Button>
      </div>
    );
  }

  const inGroup = (add: () => void) => () => {
    onUpdate((current) => ({ ...current, targetGroupId: groupId }));
    add();
  };
  const onTabPointerDown = (event: ReactPointerEvent, surface: RightPanelSurface) => {
    const origin = event.currentTarget.closest("[data-right-panel-tabbar]");
    if (!origin) return;
    beginLayoutDrag({
      event: event.nativeEvent,
      origin,
      payload: { kind: "surface", threadKey, surfaceId: surface.id },
      onDrop: (hover) =>
        onUpdate((current) =>
          moveSurface(current, surfaces, surface.id, hover.targetId, hover.zone),
        ),
    });
  };

  return (
    <div
      data-workbench-group={groupId}
      data-layout-drop-group={groupId}
      data-layout-drop-thread={threadKey}
      data-layout-drop-center="true"
      className={cn(WORKBENCH_SLOT_CLASS, "overflow-hidden")}
      style={layoutRectStyle(group.rect)}
    >
      <RightPanelTabs
        {...tabs}
        mode="embedded"
        surfaces={members}
        activeSurfaceId={active?.id ?? null}
        reserveTitlebarControls={group.touchesTop && group.touchesRight}
        shortcutsEnabled={globalActiveSurfaceId === active?.id}
        onTabPointerDown={onTabPointerDown}
        onCloseOtherSurfaces={(surface) => {
          for (const member of members) {
            if (member.id !== surface.id) tabs.onCloseSurface(member);
          }
        }}
        onCloseSurfacesToRight={(surface) => {
          const index = members.findIndex((member) => member.id === surface.id);
          for (const member of members.slice(index + 1)) tabs.onCloseSurface(member);
        }}
        onCloseAllSurfaces={() => {
          for (const member of members) tabs.onCloseSurface(member);
        }}
        onMoveSurface={(surfaceId, toIndex) => {
          const target = members[toIndex];
          const index = surfaces.findIndex((surface) => surface.id === target?.id);
          if (index >= 0) tabs.onMoveSurface?.(surfaceId, index);
        }}
        onAddBrowser={inGroup(tabs.onAddBrowser)}
        onAddTerminal={inGroup(tabs.onAddTerminal)}
        onAddDiff={inGroup(tabs.onAddDiff)}
        onAddFiles={inGroup(tabs.onAddFiles)}
        onAddPullRequest={inGroup(tabs.onAddPullRequest)}
        onAddPullRequests={inGroup(tabs.onAddPullRequests)}
        onAddDevice={inGroup(tabs.onAddDevice)}
        layoutControls={
          <div className="flex shrink-0 items-center gap-0.5 [-webkit-app-region:no-drag]">
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Collapse group"
              onClick={() => collapse(true)}
            >
              <PanelLeftCloseIcon />
            </Button>
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Close group"
              onClick={() => onUpdate((current) => closeGroup(current, groupId))}
            >
              <XIcon />
            </Button>
          </div>
        }
      >
        {null}
      </RightPanelTabs>
    </div>
  );
}

function WorkbenchHandle(props: {
  handle: FlatLayoutHandle;
  root: LayoutNode;
  container: HTMLElement | null;
  onPreview: (root: LayoutNode | null) => void;
  onCommit: (root: LayoutNode) => void;
}) {
  const { handle, root, container, onPreview, onCommit } = props;
  const isRow = handle.direction === "row";
  const [dragStart, setDragStart] = useState<number | null>(null);
  const pointerPosition = (event: ReactPointerEvent) => (isRow ? event.clientX : event.clientY);
  const resized = (position: number) => {
    const bounds = container?.getBoundingClientRect();
    const size = (isRow ? bounds?.width : bounds?.height) ?? 1;
    const extent = (handle.extent.pct / 100) * size + handle.extent.px;
    const delta = (position - (dragStart ?? position)) / Math.max(extent, 1);
    return resizeSplit(root, handle.path, handle.index, delta);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = {
      ArrowLeft: isRow ? -RESIZE_KEY_STEP : 0,
      ArrowRight: isRow ? RESIZE_KEY_STEP : 0,
      ArrowUp: isRow ? 0 : -RESIZE_KEY_STEP,
      ArrowDown: isRow ? 0 : RESIZE_KEY_STEP,
    }[event.key];
    if (!step) return;
    event.preventDefault();
    onCommit(resizeSplit(root, handle.path, handle.index, step));
  };
  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label="Resize panels"
      tabIndex={0}
      data-workbench-handle
      className={cn(
        WORKBENCH_SLOT_CLASS,
        "group z-30 outline-none",
        isRow ? "-ml-1 w-2 cursor-col-resize" : "-mt-1 h-2 cursor-row-resize",
      )}
      style={{
        left: layoutLengthCss(handle.rect.left),
        top: layoutLengthCss(handle.rect.top),
        ...(isRow
          ? { height: layoutLengthCss(handle.rect.height) }
          : { width: layoutLengthCss(handle.rect.width) }),
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragStart(pointerPosition(event));
      }}
      onPointerMove={(event) => {
        if (dragStart !== null) onPreview(resized(pointerPosition(event)));
      }}
      onPointerUp={(event) => {
        if (dragStart === null) return;
        onCommit(resized(pointerPosition(event)));
        setDragStart(null);
      }}
      onPointerCancel={() => {
        setDragStart(null);
        onPreview(null);
      }}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute bg-border transition-colors duration-150 group-hover:bg-primary/40 group-focus-visible:bg-primary/60 group-active:bg-primary/60",
          isRow ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px",
        )}
      />
    </div>
  );
}

/** A handle on the docked conversation for dragging it beside a panel. */
export function WorkbenchConversationGrip(props: { readonly threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  return (
    <button
      type="button"
      aria-label="Move conversation"
      className="absolute top-0.5 left-1/2 z-20 flex h-3 w-8 -translate-x-1/2 cursor-grab items-center justify-center rounded-sm text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground [-webkit-app-region:no-drag]"
      onPointerDown={(event) => {
        beginLayoutDrag({
          event: event.nativeEvent,
          origin: event.currentTarget,
          payload: { kind: "conversation", threadKey: scopedThreadKey(threadRef) },
          onDrop: (hover) => {
            if (hover.zone === "center") return;
            const { zone, targetId } = hover;
            useRightPanelStore
              .getState()
              .updateArrangement(threadRef, (current) => moveConversation(current, targetId, zone));
          },
        });
      }}
    >
      <GripHorizontalIcon className="size-3" />
    </button>
  );
}
