import { describe, expect, it } from "vite-plus/test";

import {
  BUILT_IN_LAYOUTS,
  COLLAPSED_GROUP_PX,
  decodeLayoutDocument,
  flattenLayout,
  isConversationGroup,
  isFutureLayoutDocument,
  LAYOUT_DOCUMENT_VERSION,
  type LayoutDocument,
  type LayoutGroupNode,
  type LayoutNode,
  listGroups,
  pruneGroups,
  resizeSplit,
  resolveDropZone,
  splitBeside,
} from "./layoutDocument";

const panel = (id: string, collapsed = false): LayoutGroupNode => ({
  type: "group",
  id,
  kinds: [id],
  opens: [],
  ...(collapsed ? { collapsed: true as const } : {}),
});

const conversation: LayoutNode = {
  type: "group",
  id: "conversation",
  kinds: ["conversation"],
  opens: [],
};

const document = (root: unknown, extra: Record<string, unknown> = {}): unknown => ({
  version: LAYOUT_DOCUMENT_VERSION,
  id: "saved",
  name: "Saved",
  root,
  ...extra,
});

describe("decodeLayoutDocument", () => {
  it("round-trips every built-in", () => {
    for (const layout of BUILT_IN_LAYOUTS) {
      expect(decodeLayoutDocument(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
    }
  });

  it("refuses a newer version and reports it as future", () => {
    const newer = { ...(document(conversation) as object), version: LAYOUT_DOCUMENT_VERSION + 1 };
    expect(decodeLayoutDocument(newer)).toBeNull();
    expect(isFutureLayoutDocument(newer)).toBe(true);
    expect(isFutureLayoutDocument(document(conversation))).toBe(false);
  });

  it.each([
    ["no root", document(undefined)],
    ["a blank name", document(conversation, { name: "  " })],
    [
      "a repeated group id",
      document({ type: "split", direction: "row", children: [panel("a"), panel("a")] }),
    ],
    [
      "two conversations",
      document({
        type: "split",
        direction: "row",
        children: [conversation, { ...conversation, id: "other" }],
      }),
    ],
    ["an unknown node", document({ type: "tabs" })],
    ["a non-object", "layout"],
  ])("drops a document with %s", (_label, value) => {
    expect(decodeLayoutDocument(value)).toBeNull();
  });

  it("repairs what it can use", () => {
    const decoded = decodeLayoutDocument(
      document(
        {
          type: "split",
          direction: "row",
          sizes: [3, 1],
          children: [conversation, { ...panel("diff"), opens: ["diff", "terminal"] }],
        },
        { settings: { terminalDrawer: true }, panes: { count: 99, sizes: [1], linked: true } },
      ),
    );
    expect(decoded?.root).toMatchObject({ sizes: [0.75, 0.25] });
    // `opens` may only name kinds the group routes, and the pane count stays bounded.
    expect(listGroups(decoded!.root)[1]).toMatchObject({ opens: ["diff"] });
    expect(decoded?.panes).toEqual({ count: 4, sizes: [0.25, 0.25, 0.25, 0.25], linked: true });
    expect(decoded?.settings).toEqual({ threadDetails: true, terminalDrawer: true });
  });

  it("puts the conversation back into a document that lost it", () => {
    const decoded = decodeLayoutDocument(document(panel("diff"))) as LayoutDocument;
    expect(listGroups(decoded.root).filter(isConversationGroup)).toHaveLength(1);
  });

  it("collapses a split with one child into that child", () => {
    const decoded = decodeLayoutDocument(
      document({ type: "split", direction: "row", children: [conversation] }),
    );
    expect(decoded?.root).toEqual(conversation);
  });
});

describe("flattenLayout", () => {
  const nested: LayoutNode = {
    type: "split",
    direction: "column",
    sizes: [0.75, 0.25],
    children: [
      { type: "split", direction: "row", sizes: [0.5, 0.5], children: [panel("a"), panel("b")] },
      panel("c"),
    ],
  };

  it("places groups by fraction of their parent", () => {
    const { groups } = flattenLayout(nested);
    const b = groups.find((group) => group.node.id === "b")!;
    expect(b.rect.left.pct).toBeCloseTo(50);
    expect(b.rect.width.pct).toBeCloseTo(50);
    expect(b.rect.height.pct).toBeCloseTo(75);
    expect(b).toMatchObject({ touchesTop: true, touchesRight: true });
    const c = groups.find((group) => group.node.id === "c")!;
    expect(c.rect.top.pct).toBeCloseTo(75);
    expect(c).toMatchObject({ touchesTop: false, touchesRight: true });
  });

  it("gives a collapsed group fixed pixels and the rest its share", () => {
    const { groups, handles } = flattenLayout({
      type: "split",
      direction: "row",
      sizes: [0.25, 0.25, 0.5],
      children: [panel("a", true), panel("b"), panel("c")],
    });
    const [a, b, c] = groups;
    expect(a?.rect.width).toEqual({ pct: 0, px: COLLAPSED_GROUP_PX });
    expect(b?.rect.width.pct).toBeCloseTo(100 / 3);
    expect(b?.rect.width.px).toBeCloseTo(-COLLAPSED_GROUP_PX / 3);
    expect(c?.rect.left.px).toBeCloseTo(COLLAPSED_GROUP_PX - COLLAPSED_GROUP_PX / 3);
    // Only the boundary between two expanded groups resizes.
    expect(handles.map((handle) => handle.index)).toEqual([1]);
  });
});

describe("tree edits", () => {
  const row: LayoutNode = {
    type: "split",
    direction: "row",
    sizes: [0.5, 0.5],
    children: [conversation, panel("a")],
  };

  it("keeps both sides of a resize above the minimum", () => {
    const resized = resizeSplit(row, [], 0, 0.9);
    expect(resized).toMatchObject({ sizes: [expect.closeTo(0.92), expect.closeTo(0.08)] });
  });

  it("splits within a matching row, and nests across directions", () => {
    const beside = splitBeside(row, "a", "right", panel("b"));
    expect(beside).toMatchObject({ sizes: [0.5, 0.25, 0.25] });
    const below = splitBeside(row, "a", "bottom", panel("b"));
    expect(listGroups(below).map((group) => group.id)).toEqual(["conversation", "a", "b"]);
    expect(below).toMatchObject({ children: [{}, { type: "split", direction: "column" }] });
  });

  it("folds a split left with one child when pruning", () => {
    expect(pruneGroups(row, (group) => group.id === "a")).toEqual(conversation);
  });
});

describe("resolveDropZone", () => {
  const bounds = { left: 0, top: 0, width: 100, height: 100 };

  it("reads the outer quarters as edges and the middle as stacking", () => {
    expect(resolveDropZone(bounds, { x: 10, y: 50 }, true)).toBe("left");
    expect(resolveDropZone(bounds, { x: 50, y: 95 }, true)).toBe("bottom");
    expect(resolveDropZone(bounds, { x: 50, y: 50 }, true)).toBe("center");
  });

  it("falls to the nearest edge where stacking is not allowed", () => {
    expect(resolveDropZone(bounds, { x: 40, y: 50 }, false)).toBe("left");
  });
});
