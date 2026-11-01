import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRouteTarget } from "../threadRoutes";
import {
  applyPaneSpec,
  assignPane,
  closePane,
  COLLAPSED_PANE_WIDTH_PX,
  focusPane,
  INITIAL_SPLIT_VIEW,
  MIN_PANE_WIDTH_PX,
  openPane,
  resizePanes,
  resolveExpandedPaneIds,
  setPaneCollapsed,
  syncRoute,
  type SplitViewState,
} from "./splitView.logic";

const target = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id)),
});

const split = (): SplitViewState =>
  openPane(INITIAL_SPLIT_VIEW, {
    paneId: "second",
    routeTarget: target("x"),
    target: target("y"),
    side: "right",
  });

const threadIds = (state: SplitViewState) =>
  state.panes.map((pane) =>
    pane.target?.kind === "server" ? pane.target.threadRef.threadId : null,
  );

describe("openPane", () => {
  it("keeps the route's conversation in the solo pane and focuses the new one", () => {
    const state = split();
    expect(state.panes.map((pane) => pane.id)).toEqual(["primary", "second"]);
    expect(threadIds(state)).toEqual(["x", "y"]);
    expect(state.focusedPaneId).toBe("second");
    expect(state.sizes).toEqual([0.5, 0.5]);
  });

  it("opens on the side it was dropped", () => {
    const state = openPane(INITIAL_SPLIT_VIEW, {
      paneId: "second",
      routeTarget: target("x"),
      target: target("y"),
      side: "left",
    });
    expect(threadIds(state)).toEqual(["y", "x"]);
  });

  it("focuses a conversation already showing instead of doubling it", () => {
    const state = openPane(focusPane(split(), "primary"), {
      paneId: "third",
      routeTarget: target("x"),
      target: target("y"),
      side: "right",
    });
    expect(state.panes).toHaveLength(2);
    expect(state.focusedPaneId).toBe("second");
  });

  it("does not split a conversation against itself", () => {
    const state = openPane(INITIAL_SPLIT_VIEW, {
      paneId: "second",
      routeTarget: target("x"),
      target: target("x"),
      side: "right",
    });
    expect(state).toBe(INITIAL_SPLIT_VIEW);
  });

  it("stops at the pane limit", () => {
    let state = split();
    for (const id of ["c", "d", "e"]) {
      state = openPane(state, {
        paneId: id,
        routeTarget: target("x"),
        target: target(id),
        side: "right",
      });
    }
    expect(state.panes).toHaveLength(4);
  });
});

describe("keyboard focus follows the route", () => {
  it("leaves a single conversation alone", () => {
    expect(syncRoute(INITIAL_SPLIT_VIEW, target("z"))).toBe(INITIAL_SPLIT_VIEW);
  });

  it("moves focus to the pane that shows the route's conversation", () => {
    expect(syncRoute(split(), target("x")).focusedPaneId).toBe("primary");
  });

  it("fills the focused pane with a conversation not on screen", () => {
    const state = syncRoute(focusPane(split(), "primary"), target("z"));
    expect(threadIds(state)).toEqual(["z", "y"]);
    expect(state.focusedPaneId).toBe("primary");
  });

  it("ignores a route with no conversation", () => {
    const state = split();
    expect(syncRoute(state, null)).toBe(state);
  });

  it("gives an empty pane the next conversation opened while it is focused", () => {
    const empty = openPane(split(), {
      paneId: "third",
      routeTarget: target("y"),
      target: null,
      side: "right",
    });
    expect(threadIds(syncRoute(empty, target("z")))).toEqual(["x", "y", "z"]);
  });

  it("expands a collapsed pane when it takes focus", () => {
    const collapsed = setPaneCollapsed(split(), "primary", true);
    expect(focusPane(collapsed, "primary").panes[0]?.collapsed).toBeUndefined();
  });
});

describe("closing", () => {
  it("hands focus to the neighbor", () => {
    const three = openPane(split(), {
      paneId: "third",
      routeTarget: target("y"),
      target: target("z"),
      side: "right",
    });
    const closed = closePane(three, "third");
    expect(closed.focusedPaneId).toBe("second");
    expect(closed.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });

  it("returns to a single conversation and keeps the survivor's pane id", () => {
    const closed = closePane(split(), "primary");
    expect(closed.panes).toEqual([]);
    expect(closed.soloPaneId).toBe("second");
  });
});

describe("setPaneCollapsed", () => {
  it("moves focus off a pane as it collapses", () => {
    expect(setPaneCollapsed(split(), "second", true).focusedPaneId).toBe("primary");
  });

  it("keeps the last visible pane open", () => {
    const one = setPaneCollapsed(split(), "primary", true);
    expect(setPaneCollapsed(one, "second", true)).toBe(one);
  });
});

describe("resolveExpandedPaneIds", () => {
  it("renders everything that fits", () => {
    const expanded = resolveExpandedPaneIds(split(), MIN_PANE_WIDTH_PX * 2);
    expect([...expanded].toSorted()).toEqual(["primary", "second"]);
  });

  it("always keeps the focused pane when width runs out", () => {
    const state = split();
    expect([...resolveExpandedPaneIds(state, MIN_PANE_WIDTH_PX)]).toEqual(["second"]);
    expect([...resolveExpandedPaneIds(focusPane(state, "primary"), 100)]).toEqual(["primary"]);
  });

  it("leaves a collapsed pane out and counts its rail", () => {
    const state = setPaneCollapsed(split(), "primary", true);
    expect([...resolveExpandedPaneIds(state, MIN_PANE_WIDTH_PX + COLLAPSED_PANE_WIDTH_PX)]).toEqual(
      ["second"],
    );
  });
});

describe("resizePanes", () => {
  it("moves one boundary and holds the minimum", () => {
    expect(resizePanes([0.5, 0.5], 0, 0.1)[0]).toBeCloseTo(0.6);
    expect(resizePanes([0.5, 0.5], 0, 0.9)[1]).toBeCloseTo(0.1);
  });
});

describe("applyPaneSpec", () => {
  const ids = () => {
    let next = 0;
    return () => `new-${(next += 1)}`;
  };

  it("adds pickers for a layout with more panes", () => {
    const state = applyPaneSpec(INITIAL_SPLIT_VIEW, {
      count: 2,
      sizes: [0.7, 0.3],
      linked: true,
      routeTarget: target("x"),
      nextPaneId: ids(),
    });
    expect(threadIds(state)).toEqual(["x", null]);
    expect(state.focusedPaneId).toBe("primary");
    expect(state.sizes).toEqual([0.7, 0.3]);
    expect(state.linked).toBe(true);
  });

  it("drops to the focused pane for a single-pane layout", () => {
    const state = applyPaneSpec(split(), {
      count: 1,
      sizes: [1],
      linked: false,
      routeTarget: target("y"),
      nextPaneId: ids(),
    });
    expect(state.panes).toEqual([]);
    expect(state.soloPaneId).toBe("second");
  });

  it("keeps the focused pane when trimming", () => {
    const three = assignPane(
      openPane(focusPane(split(), "primary"), {
        paneId: "third",
        routeTarget: target("x"),
        target: target("z"),
        side: "right",
      }),
      "primary",
      target("x"),
    );
    const state = applyPaneSpec(three, {
      count: 2,
      sizes: [0.5, 0.5],
      linked: false,
      routeTarget: target("x"),
      nextPaneId: ids(),
    });
    expect(state.panes.map((pane) => pane.id)).toContain("primary");
    expect(state.panes).toHaveLength(2);
  });
});
