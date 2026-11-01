import { scopedThreadKey } from "@t3tools/client-runtime/environment";

import type { ThreadRouteTarget } from "../threadRoutes";
import { MAX_SPLIT_PANES } from "./layoutDocument";

/** A pane's id outlives its conversation, so its ChatView stays mounted across navigation. */
export interface SplitPane {
  readonly id: string;
  /** Null shows the conversation picker. */
  readonly target: ThreadRouteTarget | null;
  readonly collapsed?: true;
}

/**
 * Empty `panes` is the ordinary single conversation, which follows the route directly. Once split,
 * panes render from here and the route follows the focused pane, so the URL and the sidebar always
 * name the conversation that takes keyboard input.
 */
export interface SplitViewState {
  readonly panes: ReadonlyArray<SplitPane>;
  readonly focusedPaneId: string | null;
  readonly sizes: ReadonlyArray<number>;
  readonly linked: boolean;
  /** The pane id used while not split, so leaving a split keeps the surviving pane mounted. */
  readonly soloPaneId: string;
}

export const INITIAL_SPLIT_VIEW: SplitViewState = {
  panes: [],
  focusedPaneId: null,
  sizes: [],
  linked: false,
  soloPaneId: "primary",
};

export const MIN_PANE_WIDTH_PX = 360;
export const COLLAPSED_PANE_WIDTH_PX = 32;
const MIN_PANE_FRACTION = 0.1;

export function paneTargetKey(target: ThreadRouteTarget | null): string | null {
  if (target === null) return null;
  return target.kind === "server" ? scopedThreadKey(target.threadRef) : target.draftId;
}

const evenSizes = (count: number): number[] => Array.from({ length: count }, () => 1 / count);

function findPaneWithTarget(
  state: SplitViewState,
  target: ThreadRouteTarget,
): SplitPane | undefined {
  const key = paneTargetKey(target);
  return state.panes.find((pane) => paneTargetKey(pane.target) === key);
}

/** Opens `target` in a new pane, or focuses the pane already showing it. */
export function openPane(
  state: SplitViewState,
  input: {
    readonly paneId: string;
    readonly routeTarget: ThreadRouteTarget | null;
    readonly target: ThreadRouteTarget | null;
    readonly side: "left" | "right";
    readonly anchorPaneId?: string | null;
  },
): SplitViewState {
  const current: ReadonlyArray<SplitPane> =
    state.panes.length > 0 ? state.panes : [{ id: state.soloPaneId, target: input.routeTarget }];
  const base: SplitViewState = {
    ...state,
    panes: current,
    focusedPaneId: state.focusedPaneId ?? current[0]!.id,
    sizes: state.panes.length > 0 ? state.sizes : [1],
  };
  if (input.target !== null) {
    const existing = findPaneWithTarget(base, input.target);
    if (existing) {
      return base.panes.length === 1 ? state : { ...base, focusedPaneId: existing.id };
    }
  }
  if (current.length >= MAX_SPLIT_PANES) return state;
  const anchorIndex = Math.max(
    0,
    current.findIndex((pane) => pane.id === (input.anchorPaneId ?? base.focusedPaneId)),
  );
  const at = input.side === "left" ? anchorIndex : anchorIndex + 1;
  const panes = [...current];
  panes.splice(at, 0, { id: input.paneId, target: input.target });
  return { ...base, panes, focusedPaneId: input.paneId, sizes: evenSizes(panes.length) };
}

/** Puts `target` in a pane, focusing it. A conversation shows in one pane at a time. */
export function assignPane(
  state: SplitViewState,
  paneId: string,
  target: ThreadRouteTarget,
): SplitViewState {
  const existing = findPaneWithTarget(state, target);
  if (existing) return { ...state, focusedPaneId: existing.id };
  return {
    ...state,
    focusedPaneId: paneId,
    panes: state.panes.map((pane) => {
      if (pane.id !== paneId) return pane;
      const { collapsed: _collapsed, ...rest } = pane;
      return { ...rest, target };
    }),
  };
}

export function focusPane(state: SplitViewState, paneId: string): SplitViewState {
  if (state.focusedPaneId === paneId) return state;
  if (!state.panes.some((pane) => pane.id === paneId)) return state;
  return {
    ...state,
    focusedPaneId: paneId,
    panes: state.panes.map((pane) => {
      if (pane.id !== paneId || pane.collapsed !== true) return pane;
      const { collapsed: _collapsed, ...rest } = pane;
      return rest;
    }),
  };
}

/** The route moved: a shown conversation takes focus, anything else fills the focused pane. */
export function syncRoute(state: SplitViewState, target: ThreadRouteTarget | null): SplitViewState {
  if (state.panes.length === 0 || target === null) return state;
  const existing = findPaneWithTarget(state, target);
  if (existing) return focusPane(state, existing.id);
  const focused = state.focusedPaneId;
  return focused === null ? state : assignPane(state, focused, target);
}

export function closePane(state: SplitViewState, paneId: string): SplitViewState {
  const index = state.panes.findIndex((pane) => pane.id === paneId);
  if (index < 0) return state;
  const panes = state.panes.filter((pane) => pane.id !== paneId);
  const sizes = state.sizes.filter((_, position) => position !== index);
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  const neighbor = panes[Math.min(index, panes.length - 1)];
  const focusedPaneId =
    state.focusedPaneId === paneId ? (neighbor?.id ?? null) : state.focusedPaneId;
  if (panes.length <= 1) {
    return { ...INITIAL_SPLIT_VIEW, linked: state.linked, soloPaneId: panes[0]?.id ?? "primary" };
  }
  return { ...state, panes, focusedPaneId, sizes: sizes.map((size) => size / total) };
}

export function setPaneCollapsed(
  state: SplitViewState,
  paneId: string,
  collapsed: boolean,
): SplitViewState {
  const panes = state.panes.map((pane): SplitPane => {
    if (pane.id !== paneId) return pane;
    const { collapsed: _collapsed, ...rest } = pane;
    return collapsed ? { ...rest, collapsed: true } : rest;
  });
  if (!collapsed || state.focusedPaneId !== paneId) return { ...state, panes };
  // Keyboard input needs a visible pane, so focus leaves one that collapses.
  const next = panes.find((pane) => pane.id !== paneId && pane.collapsed !== true);
  if (!next) return state;
  return { ...state, panes, focusedPaneId: next.id };
}

/** The panes that render fully at this width. The focused pane always does; the rest cost a rail. */
export function resolveExpandedPaneIds(
  state: Pick<SplitViewState, "panes" | "focusedPaneId">,
  containerWidth: number,
): ReadonlySet<string> {
  const expandable = state.panes.filter((pane) => pane.collapsed !== true);
  const railWidth = (state.panes.length - expandable.length) * COLLAPSED_PANE_WIDTH_PX;
  const fit = Math.max(1, Math.floor((containerWidth - railWidth) / MIN_PANE_WIDTH_PX));
  const ordered = expandable.toSorted(
    (a, b) => Number(b.id === state.focusedPaneId) - Number(a.id === state.focusedPaneId),
  );
  return new Set(ordered.slice(0, fit).map((pane) => pane.id));
}

/** Moves the boundary after pane `index`, keeping both sides above the minimum. */
export function resizePanes(
  sizes: ReadonlyArray<number>,
  index: number,
  delta: number,
): ReadonlyArray<number> {
  const first = sizes[index];
  const second = sizes[index + 1];
  if (first === undefined || second === undefined) return sizes;
  const total = first + second;
  const next = Math.min(total - MIN_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, first + delta));
  const resized = [...sizes];
  resized[index] = next;
  resized[index + 1] = total - next;
  return resized;
}

/** Matches a layout's pane count: new panes open on the picker, extras leave the focused one. */
export function applyPaneSpec(
  state: SplitViewState,
  input: {
    readonly count: number;
    readonly sizes: ReadonlyArray<number>;
    readonly linked: boolean;
    readonly routeTarget: ThreadRouteTarget | null;
    readonly nextPaneId: () => string;
  },
): SplitViewState {
  if (input.count <= 1) {
    const survivor = state.panes.find((pane) => pane.id === state.focusedPaneId);
    return {
      ...INITIAL_SPLIT_VIEW,
      linked: input.linked,
      soloPaneId: survivor?.id ?? state.soloPaneId,
    };
  }
  let next = state;
  const openCount = () => (next.panes.length > 0 ? next.panes.length : 1);
  while (openCount() < input.count) {
    const added = openPane(next, {
      paneId: input.nextPaneId(),
      routeTarget: input.routeTarget,
      target: null,
      side: "right",
    });
    if (added === next) break;
    next = added;
  }
  const focusedPaneId = state.focusedPaneId ?? next.panes[0]?.id ?? null;
  const keep = next.panes
    .toSorted((a, b) => Number(b.id === focusedPaneId) - Number(a.id === focusedPaneId))
    .slice(0, input.count);
  const panes = next.panes.filter((pane) => keep.includes(pane));
  return {
    ...next,
    panes,
    focusedPaneId,
    linked: input.linked,
    sizes: input.sizes.length === panes.length ? input.sizes : evenSizes(panes.length),
  };
}
