import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../rightPanelStore";
import { BUILT_IN_LAYOUTS, findGroup, listGroups, type LayoutDocument } from "./layoutDocument";
import {
  activeSurfaceOfGroup,
  arrangementFromDocument,
  captureLayoutDocument,
  closeGroup,
  moveConversation,
  moveSurface,
  panelGroups,
  reconcileArrangement,
  surfaceGroupId,
  surfacesInGroup,
} from "./threadArrangement";

const layout = (id: string): LayoutDocument => BUILT_IN_LAYOUTS.find((entry) => entry.id === id)!;
const ide = () => arrangementFromDocument(layout("ide"), 1)!;

const diff: RightPanelSurface = { id: "diff", kind: "diff" };
const files: RightPanelSurface = { id: "files", kind: "files" };
const fileSurface = (relativePath: string): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine: null,
  revealRequestId: 0,
});
const a = fileSurface("src/a.ts");
const b = fileSurface("src/b.ts");

describe("arrangementFromDocument", () => {
  it("returns none for a layout that is only the conversation", () => {
    expect(arrangementFromDocument(layout("focus"), 1)).toBeNull();
    expect(arrangementFromDocument(layout("pair"), 1)).toBeNull();
  });
});

describe("routing", () => {
  it("sends a surface to the group for its kind", () => {
    const arrangement = ide();
    expect(surfaceGroupId(arrangement, a)).toBe("editor");
    expect(surfaceGroupId(arrangement, files)).toBe("explorer");
    expect(surfaceGroupId(arrangement, diff)).toBe("tools");
  });

  it("falls to the last panel group for a kind nothing claims", () => {
    expect(surfaceGroupId(ide(), { id: "device", kind: "device" })).toBe("tools");
  });

  it("uses a group's opened kind as its active tab until one is chosen", () => {
    const arrangement = ide();
    const tools = findGroup(arrangement.root, "tools")!;
    const terminal: RightPanelSurface = {
      id: "terminal:1",
      kind: "terminal",
      resourceId: "1",
      terminalIds: ["1"],
      activeTerminalId: "1",
    };
    expect(activeSurfaceOfGroup(arrangement, tools, [diff, terminal])?.id).toBe("terminal:1");
  });
});

describe("reconcileArrangement", () => {
  it("places the next new surface in the group whose add button was pressed", () => {
    const pressed = { ...ide(), targetGroupId: "tools" };
    const next = reconcileArrangement(pressed, [], [a], a.id);
    expect(surfaceGroupId(next, a)).toBe("tools");
    expect(next.targetGroupId).toBeUndefined();
  });

  it("follows the active surface per group and forgets closed placements", () => {
    const placed = { ...ide(), placements: { [a.id]: "tools" } };
    const next = reconcileArrangement(placed, [a, b], [b], b.id);
    expect(next.placements).toEqual({});
    expect(next.activeByGroup).toEqual({ editor: b.id });
  });
});

describe("moveSurface", () => {
  it("stacks a tab into another group and moves its kind when none stay behind", () => {
    const next = moveSurface(ide(), [diff, files], diff.id, "explorer", "center");
    expect(surfaceGroupId(next, diff)).toBe("explorer");
    expect(findGroup(next.root, "explorer")?.kinds).toContain("diff");
    expect(findGroup(next.root, "tools")?.kinds).not.toContain("diff");
  });

  it("splits one file out and leaves the kind routing to its group", () => {
    const next = moveSurface(ide(), [a, b], a.id, "editor", "right");
    const destination = next.placements[a.id]!;
    expect(destination).not.toBe("editor");
    expect(surfacesInGroup(next, [a, b], "editor")).toEqual([b]);
    expect(findGroup(next.root, "editor")?.kinds).toContain("file");
    expect(next.activeByGroup[destination]).toBe(a.id);
  });

  it("removes a group left with no tabs and no kinds", () => {
    const next = moveSurface(ide(), [files], files.id, "editor", "center");
    expect(findGroup(next.root, "explorer")).toBeNull();
  });

  it("never stacks a tab onto the conversation", () => {
    const arrangement = ide();
    expect(moveSurface(arrangement, [a], a.id, "conversation", "center")).toBe(arrangement);
  });
});

describe("moveConversation", () => {
  it("docks the conversation beside a group", () => {
    const next = moveConversation(ide(), "tools", "left");
    const ids = listGroups(next.root).map((group) => group.id);
    expect(ids.indexOf("conversation")).toBe(ids.indexOf("tools") - 1);
  });
});

describe("closeGroup", () => {
  it("drops to the plain panel when the last panel group closes", () => {
    const review = arrangementFromDocument(layout("review"), 1)!;
    expect(closeGroup(review, panelGroups(review.root)[0]!.id)).toBeNull();
  });
});

describe("captureLayoutDocument", () => {
  const capture = (surfaces: RightPanelSurface[]) =>
    captureLayoutDocument({
      id: "saved",
      name: "Mine",
      arrangement: ide(),
      surfaces,
      panelOpen: true,
      panes: null,
      settings: { threadDetails: true, terminalDrawer: false },
    });

  it("keeps kinds and geometry, never what a panel shows", () => {
    const captured = capture([diff, a, b]);
    expect(JSON.stringify(captured)).not.toContain("src/a.ts");
    expect(findGroup(captured.root, "editor")?.opens).toEqual([]);
    expect(findGroup(captured.root, "tools")?.opens).toEqual(["diff"]);
  });

  it("describes an open plain panel as a conversation and one group", () => {
    const captured = captureLayoutDocument({
      id: "saved",
      name: "Mine",
      arrangement: undefined,
      surfaces: [diff],
      panelOpen: true,
      panes: null,
      settings: { threadDetails: true, terminalDrawer: false },
    });
    expect(panelGroups(captured.root).map((group) => group.opens)).toEqual([["diff"]]);
  });
});
