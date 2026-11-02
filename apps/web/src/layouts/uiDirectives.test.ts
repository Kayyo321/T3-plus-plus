import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadPanelOpen,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { useSplitViewStore } from "./splitViewStore";
import { INITIAL_SPLIT_VIEW } from "./splitView.logic";
import { applyUiDirective } from "./uiDirectives";

const environmentId = EnvironmentId.make("env");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const other = ThreadId.make("other");
const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);

beforeEach(() => {
  useSplitViewStore.setState(INITIAL_SPLIT_VIEW, true);
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
});

describe("applyUiDirective", () => {
  it("applies a layout by name and opens what it names", () => {
    expect(applyUiDirective({ type: "layout.apply", layout: "review", threadRef })).toEqual({
      ok: true,
    });
    expect(panel().arrangement?.layoutId).toBe("review");
    expect(panel().surfaces.map((surface) => surface.kind)).toEqual(["diff"]);
    expect(panel().isOpen).toBe(true);
  });

  it("applies a layout's panel settings", () => {
    applyUiDirective({ type: "layout.apply", layout: "ide", threadRef });
    expect(
      selectThreadPanelOpen(
        useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
        threadRef,
        "inline",
      ),
    ).toBe(false);
  });

  it("swaps Pair's second pane out when another layout is applied", () => {
    applyUiDirective({ type: "layout.apply", layout: "pair", threadRef });
    expect(useSplitViewStore.getState().panes).toHaveLength(2);
    applyUiDirective({ type: "layout.apply", layout: "debug", threadRef });
    expect(useSplitViewStore.getState().panes).toEqual([]);
  });

  it("asks ChatView for the tabs that need a session", () => {
    applyUiDirective({ type: "layout.apply", layout: "ide", threadRef });
    expect(panel().arrangement?.pendingOpens).toEqual(["terminal"]);
  });

  it("returns to the plain panel, keeping tabs, on Focus", () => {
    applyUiDirective({ type: "layout.apply", layout: "review", threadRef });
    applyUiDirective({ type: "layout.apply", layout: "focus", threadRef });
    expect(panel().arrangement).toBeUndefined();
    expect(panel().isOpen).toBe(false);
    expect(panel().surfaces).toHaveLength(1);
  });

  it("reports an unknown layout and an unknown panel instead of throwing", () => {
    expect(applyUiDirective({ type: "layout.apply", layout: "nope", threadRef }).ok).toBe(false);
    expect(applyUiDirective({ type: "panel.open", panel: "nope", threadRef }).ok).toBe(false);
  });

  it("needs a conversation to act on", () => {
    expect(applyUiDirective({ type: "layout.reset" }).ok).toBe(false);
  });

  it("opens, focuses, and closes a panel", () => {
    expect(applyUiDirective({ type: "panel.open", panel: "diff", threadRef }).ok).toBe(true);
    expect(applyUiDirective({ type: "panel.open", panel: "files", threadRef }).ok).toBe(true);
    expect(panel().activeSurfaceId).toBe("files");
    expect(applyUiDirective({ type: "panel.focus", panel: "diff", threadRef }).ok).toBe(true);
    expect(panel().activeSurfaceId).toBe("diff");
    expect(applyUiDirective({ type: "panel.close", panel: "diff", threadRef }).ok).toBe(true);
    expect(panel().surfaces.map((surface) => surface.kind)).toEqual(["files"]);
    expect(applyUiDirective({ type: "panel.close", panel: "diff", threadRef }).ok).toBe(false);
  });

  it("opens a file by path", () => {
    applyUiDirective({ type: "panel.open", panel: "file", path: "src/a.ts", line: 4, threadRef });
    expect(panel().activeSurfaceId).toBe("file:src/a.ts");
  });

  it("opens and closes a split pane by conversation", () => {
    applyUiDirective({ type: "split.open", environmentId, threadId: other });
    const { panes } = useSplitViewStore.getState();
    expect(panes.map((pane) => pane.target?.kind)).toEqual([undefined, "server"]);
    expect(
      scopedThreadKey(panes[1]?.target?.kind === "server" ? panes[1].target.threadRef : threadRef),
    ).toBe(scopedThreadKey(scopeThreadRef(environmentId, other)));
    expect(applyUiDirective({ type: "split.close", environmentId, threadId: other }).ok).toBe(true);
    expect(useSplitViewStore.getState().panes).toEqual([]);
  });

  it("reports a pane that is not open", () => {
    expect(applyUiDirective({ type: "split.focus", environmentId, threadId: other }).ok).toBe(
      false,
    );
  });
});
