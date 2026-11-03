import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../composerDraftStore";
import { randomUUID } from "../lib/utils";
import {
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import type { ThreadRouteTarget } from "../threadRoutes";
import { resolveDefaultLayout, selectLayouts, useLayoutStore } from "./layoutStore";
import {
  DEFAULT_BUILT_IN_LAYOUT_ID,
  type LayoutDocument,
  type LayoutDropZone,
} from "./layoutDocument";
import {
  applyPaneSpec,
  assignPane,
  closePane as closePaneState,
  focusPane as focusPaneState,
  isOnlyShownTarget,
  openPane,
  setPaneCollapsed,
  type SplitPane,
} from "./splitView.logic";
import { updateSplitView, useSplitViewStore } from "./splitViewStore";
import { arrangementFromDocument, captureLayoutDocument, panelGroups } from "./threadArrangement";

let router: AnyRouter | null = null;

/** Gives pane focus a way to move the route. Called once at app start. */
export function bindLayoutRouter(next: AnyRouter): void {
  router = next;
}

function readRouteTarget(): ThreadRouteTarget | null {
  return resolveThreadRouteTarget(router?.state.matches.at(-1)?.params ?? {});
}

/** The conversation layout commands act on: the focused pane's, which the route follows. */
export function readFocusedThreadRef(): ScopedThreadRef | null {
  const target = readRouteTarget();
  if (target === null) return null;
  if (target.kind === "server") return target.threadRef;
  const draft = useComposerDraftStore.getState().getDraftSession(target.draftId);
  return draft ? scopeThreadRef(draft.environmentId, draft.threadId) : null;
}

function navigateToTarget(target: ThreadRouteTarget | null): void {
  if (router === null || target === null) return;
  if (target.kind === "server") {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.threadRef),
    });
  } else {
    void router.navigate({ to: "/draft/$draftId", params: { draftId: target.draftId } });
  }
}

const focusedPane = (): SplitPane | undefined => {
  const { panes, focusedPaneId } = useSplitViewStore.getState();
  return panes.find((pane) => pane.id === focusedPaneId);
};

const SINGLE_PANE = { count: 1, sizes: [1], linked: false } as const;

/**
 * Applies a layout to a conversation. Nothing it already shows is reloaded. A layout without panes
 * is a single pane, so switching to it closes any split, unless `keepSplit` asks to leave it be.
 */
export function applyLayout(
  threadRef: ScopedThreadRef,
  layout: LayoutDocument,
  { keepSplit = false }: { readonly keepSplit?: boolean } = {},
): void {
  const panels = useRightPanelStore.getState();
  const revision =
    (selectThreadRightPanelState(panels.byThreadKey, threadRef).arrangement?.revision ?? 0) + 1;
  const arrangement = arrangementFromDocument(layout, revision);
  panels.applyArrangement(
    threadRef,
    arrangement,
    panelGroups(layout.root).flatMap((group) => group.opens),
  );
  panels.setThreadPanelOpen(threadRef, "inline", layout.settings.threadDetails);
  useTerminalUiStateStore.getState().setTerminalOpen(threadRef, layout.settings.terminalDrawer);
  const panes = layout.panes ?? (keepSplit ? null : SINGLE_PANE);
  if (panes !== null) {
    updateSplitView((state) =>
      applyPaneSpec(state, { ...panes, routeTarget: readRouteTarget(), nextPaneId: randomUUID }),
    );
  }
}

/** New conversations open in the resolved default; Focus is what they would do anyway. */
export function applyDefaultLayout(threadRef: ScopedThreadRef, projectId: ProjectId | null): void {
  const layout = resolveDefaultLayout(useLayoutStore.getState(), projectId);
  if (layout.id === DEFAULT_BUILT_IN_LAYOUT_ID) return;
  // A new conversation may open in a split; a one-pane default must not close it.
  const panes = (layout.panes?.count ?? 1) > 1 ? layout.panes : null;
  applyLayout(threadRef, { ...layout, panes }, { keepSplit: true });
}

export function resetLayout(threadRef: ScopedThreadRef, projectId: ProjectId | null): void {
  applyLayout(threadRef, resolveDefaultLayout(useLayoutStore.getState(), projectId));
}

/** The document for what the conversation shows now, for saving. */
function captureCurrentLayout(
  threadRef: ScopedThreadRef,
  name: string,
): Omit<LayoutDocument, "id"> {
  const panels = useRightPanelStore.getState();
  const panel = selectThreadRightPanelState(panels.byThreadKey, threadRef);
  const split = useSplitViewStore.getState();
  const { id: _id, ...document } = captureLayoutDocument({
    id: "",
    name,
    arrangement: panel.arrangement,
    surfaces: panel.surfaces,
    panelOpen: panel.isOpen,
    panes:
      split.panes.length > 1
        ? { count: split.panes.length, sizes: split.sizes, linked: split.linked }
        : null,
    settings: {
      threadDetails: selectThreadPanelOpen(
        panels.threadPanelVisibilityByThreadKey,
        threadRef,
        "inline",
      ),
      terminalDrawer: selectThreadTerminalUiState(
        useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
        threadRef,
      ).terminalOpen,
    },
  });
  return document;
}

export function saveCurrentLayout(threadRef: ScopedThreadRef, name: string): LayoutDocument {
  return useLayoutStore.getState().save(captureCurrentLayout(threadRef, name));
}

function activeLayoutId(threadRef: ScopedThreadRef): string {
  const { arrangement } = selectThreadRightPanelState(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  return arrangement?.layoutId ?? DEFAULT_BUILT_IN_LAYOUT_ID;
}

export function cycleLayout(threadRef: ScopedThreadRef): LayoutDocument | null {
  const layouts = selectLayouts(useLayoutStore.getState());
  const index = layouts.findIndex((layout) => layout.id === activeLayoutId(threadRef));
  const next = layouts[(index + 1) % layouts.length] ?? null;
  if (next) applyLayout(threadRef, next);
  return next;
}

/** Opens a conversation beside the focused pane, and gives it the keyboard. */
export function openThreadInSplit(
  threadRef: ScopedThreadRef,
  options: { readonly side?: "left" | "right"; readonly anchorPaneId?: string | null } = {},
): void {
  const target: ThreadRouteTarget = { kind: "server", threadRef };
  updateSplitView((state) =>
    openPane(state, {
      paneId: randomUUID(),
      routeTarget: readRouteTarget(),
      target,
      side: options.side ?? "right",
      anchorPaneId: options.anchorPaneId ?? null,
    }),
  );
  navigateToTarget(focusedPane()?.target ?? null);
}

/** Opens the picker in a new pane, for choosing what to compare against. */
export function openEmptySplit(): void {
  updateSplitView((state) =>
    openPane(state, {
      paneId: randomUUID(),
      routeTarget: readRouteTarget(),
      target: null,
      side: "right",
    }),
  );
}

/** The thread menu's split. For the conversation already filling the view, it offers the picker. */
export function openThreadMenuSplit(threadRef: ScopedThreadRef): void {
  const target: ThreadRouteTarget = { kind: "server", threadRef };
  if (isOnlyShownTarget(useSplitViewStore.getState(), readRouteTarget(), target)) openEmptySplit();
  else openThreadInSplit(threadRef);
}

export function showThreadInPane(paneId: string, threadRef: ScopedThreadRef): void {
  updateSplitView((state) => assignPane(state, paneId, { kind: "server", threadRef }));
  navigateToTarget(focusedPane()?.target ?? null);
}

export function focusSplitPane(paneId: string): void {
  updateSplitView((state) => focusPaneState(state, paneId));
  navigateToTarget(focusedPane()?.target ?? null);
}

export function focusAdjacentPane(direction: 1 | -1): SplitPane | null {
  const { panes, focusedPaneId } = useSplitViewStore.getState();
  if (panes.length === 0) return null;
  const index = panes.findIndex((pane) => pane.id === focusedPaneId);
  const next = panes[(index + direction + panes.length) % panes.length];
  if (next) focusSplitPane(next.id);
  return next ?? null;
}

export function closeSplitPane(paneId: string): void {
  const wasFocused = useSplitViewStore.getState().focusedPaneId === paneId;
  const remaining = useSplitViewStore.getState().panes.filter((pane) => pane.id !== paneId);
  const survivor = remaining.length === 1 ? remaining[0] : null;
  updateSplitView((state) => closePaneState(state, paneId));
  if (survivor) navigateToTarget(survivor.target);
  else if (wasFocused) navigateToTarget(focusedPane()?.target ?? null);
}

export function collapseSplitPane(paneId: string, collapsed: boolean): void {
  updateSplitView((state) => setPaneCollapsed(state, paneId, collapsed));
  navigateToTarget(focusedPane()?.target ?? null);
}

export function setSplitLinked(linked: boolean): void {
  useSplitViewStore.setState({ linked });
}

/** A conversation dropped on a pane: its middle shows it there, its edges split beside it. */
export function dropThreadOnPane(
  threadRef: ScopedThreadRef,
  paneId: string,
  zone: LayoutDropZone,
): void {
  if (zone === "left" || zone === "right") {
    openThreadInSplit(threadRef, { side: zone, anchorPaneId: paneId });
  } else if (useSplitViewStore.getState().panes.length > 0) {
    showThreadInPane(paneId, threadRef);
  } else {
    navigateToTarget({ kind: "server", threadRef });
  }
}
