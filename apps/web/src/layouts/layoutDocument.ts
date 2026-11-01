/**
 * A saved layout: where panels sit, never what they show. Groups name surface kinds instead of
 * surfaces, so one document applies to any conversation and holds no paths, ids, or transcript.
 */
export const LAYOUT_DOCUMENT_VERSION = 1;

export const CONVERSATION_PANEL = "conversation";
/** Thickness of a collapsed group along its split's axis. */
export const COLLAPSED_GROUP_PX = 32;
export const MAX_SPLIT_PANES = 4;
const MIN_SPLIT_FRACTION = 0.08;
const MAX_TREE_DEPTH = 8;
const MAX_GROUPS = 16;

export type LayoutDropZone = "center" | "left" | "right" | "top" | "bottom";

export interface LayoutGroupNode {
  readonly type: "group";
  readonly id: string;
  /** Surface kinds routed here. `conversation` is always alone in its group. */
  readonly kinds: ReadonlyArray<string>;
  /** Kinds opened when the layout is applied; the first is the group's active tab. */
  readonly opens: ReadonlyArray<string>;
  readonly collapsed?: true;
}

export interface LayoutSplitNode {
  readonly type: "split";
  readonly direction: "row" | "column";
  /** Fractions that sum to 1, one per child. */
  readonly sizes: ReadonlyArray<number>;
  readonly children: ReadonlyArray<LayoutNode>;
}

export type LayoutNode = LayoutGroupNode | LayoutSplitNode;

export interface LayoutPanes {
  readonly count: number;
  readonly sizes: ReadonlyArray<number>;
  readonly linked: boolean;
}

export interface LayoutSettings {
  readonly threadDetails: boolean;
  readonly terminalDrawer: boolean;
}

export interface LayoutDocument {
  readonly version: typeof LAYOUT_DOCUMENT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly root: LayoutNode;
  /** Null leaves any open split alone, so a panel layout applies to one conversation in it. */
  readonly panes: LayoutPanes | null;
  readonly settings: LayoutSettings;
}

const conversationGroup: LayoutGroupNode = {
  type: "group",
  id: CONVERSATION_PANEL,
  kinds: [CONVERSATION_PANEL],
  opens: [],
};

const group = (
  id: string,
  kinds: ReadonlyArray<string>,
  opens: ReadonlyArray<string> = [],
): LayoutGroupNode => ({ type: "group", id, kinds, opens });

const split = (
  direction: "row" | "column",
  sizes: ReadonlyArray<number>,
  children: ReadonlyArray<LayoutNode>,
): LayoutSplitNode => ({ type: "split", direction, sizes, children });

const DEFAULT_SETTINGS: LayoutSettings = { threadDetails: true, terminalDrawer: false };

const builtIn = (
  id: string,
  name: string,
  root: LayoutNode,
  options: { panes?: LayoutPanes; settings?: LayoutSettings } = {},
): LayoutDocument => ({
  version: LAYOUT_DOCUMENT_VERSION,
  id,
  name,
  root,
  panes: options.panes ?? null,
  settings: options.settings ?? DEFAULT_SETTINGS,
});

export const BUILT_IN_LAYOUTS: ReadonlyArray<LayoutDocument> = [
  builtIn("focus", "Focus", conversationGroup, { panes: { count: 1, sizes: [1], linked: false } }),
  builtIn(
    "review",
    "Review",
    split(
      "row",
      [0.45, 0.55],
      [
        conversationGroup,
        group("review", ["diff", "git-graph", "pull-request", "pull-requests", "file"], ["diff"]),
      ],
    ),
  ),
  builtIn(
    "debug",
    "Debug",
    split(
      "row",
      [0.5, 0.5],
      [
        split(
          "column",
          [0.62, 0.38],
          [conversationGroup, group("terminal", ["terminal"], ["terminal"])],
        ),
        group("inspect", ["preview", "device", "file", "diff"], ["preview"]),
      ],
    ),
  ),
  builtIn("pair", "Pair", conversationGroup, {
    panes: { count: 2, sizes: [0.5, 0.5], linked: false },
  }),
  builtIn(
    "ide",
    "IDE",
    split(
      "column",
      [0.72, 0.28],
      [
        split(
          "row",
          [0.18, 0.54, 0.28],
          [group("explorer", ["files"], ["files"]), group("editor", ["file"]), conversationGroup],
        ),
        group("tools", ["terminal", "diff", "git-graph"], ["terminal", "diff", "git-graph"]),
      ],
    ),
    { settings: { threadDetails: false, terminalDrawer: false } },
  ),
];

export const DEFAULT_BUILT_IN_LAYOUT_ID = "focus";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : [];

function normalizeSizes(sizes: unknown, count: number): number[] {
  const raw = Array.isArray(sizes) ? sizes : [];
  const valid =
    raw.length === count && raw.every((size) => typeof size === "number" && size > 0)
      ? (raw as number[])
      : Array.from({ length: count }, () => 1);
  const total = valid.reduce((sum, size) => sum + size, 0);
  return valid.map((size) => (Number.isFinite(total) ? size / total : 1 / count));
}

function decodeNode(value: unknown, depth: number, seen: Set<string>): LayoutNode | null {
  if (!isRecord(value) || depth > MAX_TREE_DEPTH) return null;
  if (value.type === "group") {
    if (typeof value.id !== "string" || value.id.length === 0) return null;
    const kinds = stringList(value.kinds);
    const id = kinds.includes(CONVERSATION_PANEL) ? CONVERSATION_PANEL : value.id;
    if (seen.has(id) || seen.size >= MAX_GROUPS) return null;
    seen.add(id);
    if (id === CONVERSATION_PANEL) return conversationGroup;
    return {
      type: "group",
      id,
      kinds,
      opens: stringList(value.opens).filter((kind) => kinds.includes(kind)),
      ...(value.collapsed === true ? { collapsed: true } : {}),
    };
  }
  if (value.type !== "split" || (value.direction !== "row" && value.direction !== "column")) {
    return null;
  }
  if (!Array.isArray(value.children)) return null;
  const children: LayoutNode[] = [];
  for (const child of value.children) {
    const decoded = decodeNode(child, depth + 1, seen);
    if (decoded === null) return null;
    children.push(decoded);
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return {
    type: "split",
    direction: value.direction,
    sizes: normalizeSizes(value.sizes, children.length),
    children,
  };
}

/** A document without the conversation would strand the chat column, so it gets one back. */
function withConversation(root: LayoutNode): LayoutNode {
  if (listGroups(root).some(isConversationGroup)) return root;
  return split("row", [0.5, 0.5], [conversationGroup, root]);
}

function decodePanes(value: unknown): LayoutPanes | null {
  if (!isRecord(value)) return null;
  const count =
    typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 1
      ? Math.min(value.count, MAX_SPLIT_PANES)
      : 1;
  return { count, sizes: normalizeSizes(value.sizes, count), linked: value.linked === true };
}

/** Decodes a stored document, or returns null when it is damaged or from a newer build. */
export function decodeLayoutDocument(value: unknown): LayoutDocument | null {
  if (!isRecord(value) || value.version !== LAYOUT_DOCUMENT_VERSION) return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return null;
  const root = decodeNode(value.root, 0, new Set());
  if (root === null) return null;
  const settings = isRecord(value.settings) ? value.settings : {};
  return {
    version: LAYOUT_DOCUMENT_VERSION,
    id: value.id,
    name: value.name.trim(),
    root: withConversation(root),
    panes: decodePanes(value.panes),
    settings: {
      threadDetails: settings.threadDetails !== false,
      terminalDrawer: settings.terminalDrawer === true,
    },
  };
}

/** True for a document newer than this build, which is kept but never applied. */
export function isFutureLayoutDocument(value: unknown): boolean {
  return (
    isRecord(value) && typeof value.version === "number" && value.version > LAYOUT_DOCUMENT_VERSION
  );
}

export const isConversationGroup = (node: LayoutGroupNode): boolean =>
  node.kinds.includes(CONVERSATION_PANEL);

export function listGroups(root: LayoutNode): LayoutGroupNode[] {
  return root.type === "group" ? [root] : root.children.flatMap(listGroups);
}

export function findGroup(root: LayoutNode, id: string): LayoutGroupNode | null {
  return listGroups(root).find((entry) => entry.id === id) ?? null;
}

export function mapGroups(
  node: LayoutNode,
  update: (entry: LayoutGroupNode) => LayoutGroupNode,
): LayoutNode {
  if (node.type === "group") return update(node);
  return { ...node, children: node.children.map((child) => mapGroups(child, update)) };
}

/** Removes matching groups, folding any split left with one child into that child. */
export function pruneGroups(
  node: LayoutNode,
  remove: (entry: LayoutGroupNode) => boolean,
): LayoutNode | null {
  if (node.type === "group") return remove(node) ? null : node;
  const kept: { child: LayoutNode; size: number }[] = [];
  node.children.forEach((child, index) => {
    const next = pruneGroups(child, remove);
    if (next !== null) kept.push({ child: next, size: node.sizes[index] ?? 0 });
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.child;
  return {
    ...node,
    children: kept.map((entry) => entry.child),
    sizes: normalizeSizes(
      kept.map((entry) => entry.size),
      kept.length,
    ),
  };
}

const zoneDirection = (zone: Exclude<LayoutDropZone, "center">): "row" | "column" =>
  zone === "left" || zone === "right" ? "row" : "column";

/** Places `added` beside the group `targetId`, halving the space that group held. */
export function splitBeside(
  node: LayoutNode,
  targetId: string,
  zone: Exclude<LayoutDropZone, "center">,
  added: LayoutGroupNode,
): LayoutNode {
  const direction = zoneDirection(zone);
  const before = zone === "left" || zone === "top";
  if (node.type === "group") {
    if (node.id !== targetId) return node;
    return split(direction, [0.5, 0.5], before ? [added, node] : [node, added]);
  }
  const index = node.children.findIndex((child) => child.type === "group" && child.id === targetId);
  if (index >= 0 && node.direction === direction) {
    const half = (node.sizes[index] ?? 0) / 2;
    const at = before ? index : index + 1;
    const sizes = [...node.sizes];
    sizes[index] = half;
    sizes.splice(at, 0, half);
    const children = [...node.children];
    children.splice(at, 0, added);
    return { ...node, sizes, children };
  }
  return {
    ...node,
    children: node.children.map((child) => splitBeside(child, targetId, zone, added)),
  };
}

export function nextGroupId(root: LayoutNode): string {
  const taken = new Set(listGroups(root).map((entry) => entry.id));
  let index = taken.size + 1;
  while (taken.has(`group-${index}`)) index += 1;
  return `group-${index}`;
}

/** The path of child indices to each split, for addressing one from a resize handle. */
export type LayoutSplitPath = ReadonlyArray<number>;

function resizeAt(
  node: LayoutNode,
  path: LayoutSplitPath,
  index: number,
  delta: number,
): LayoutNode {
  if (node.type !== "split") return node;
  if (path.length > 0) {
    const [head, ...rest] = path;
    return {
      ...node,
      children: node.children.map((child, position) =>
        position === head ? resizeAt(child, rest, index, delta) : child,
      ),
    };
  }
  const first = node.sizes[index];
  const second = node.sizes[index + 1];
  if (first === undefined || second === undefined) return node;
  const total = first + second;
  const nextFirst = Math.min(
    total - MIN_SPLIT_FRACTION,
    Math.max(MIN_SPLIT_FRACTION, first + delta),
  );
  const sizes = [...node.sizes];
  sizes[index] = nextFirst;
  sizes[index + 1] = total - nextFirst;
  return { ...node, sizes };
}

/** Moves the boundary after child `index` of the split at `path` by a fraction of that split. */
export function resizeSplit(
  root: LayoutNode,
  path: LayoutSplitPath,
  index: number,
  delta: number,
): LayoutNode {
  return resizeAt(root, path, index, delta);
}

/** A length that holds at any container size: `pct` percent of it, plus `px` pixels. */
export interface LayoutLength {
  readonly pct: number;
  readonly px: number;
}

export interface LayoutRect {
  readonly left: LayoutLength;
  readonly top: LayoutLength;
  readonly width: LayoutLength;
  readonly height: LayoutLength;
}

export interface FlatLayoutGroup {
  readonly node: LayoutGroupNode;
  readonly rect: LayoutRect;
  /** Which way a collapsed group runs: a rail in a row, a strip in a column. */
  readonly axis: "row" | "column";
  readonly touchesTop: boolean;
  readonly touchesRight: boolean;
}

export interface FlatLayoutHandle {
  readonly id: string;
  readonly path: LayoutSplitPath;
  readonly index: number;
  readonly direction: "row" | "column";
  readonly rect: LayoutRect;
  /** The split's size along its axis, which turns pointer pixels into a fraction. */
  readonly extent: LayoutLength;
}

export interface FlatLayout {
  readonly groups: ReadonlyArray<FlatLayoutGroup>;
  readonly handles: ReadonlyArray<FlatLayoutHandle>;
}

const FULL_RECT: LayoutRect = {
  left: { pct: 0, px: 0 },
  top: { pct: 0, px: 0 },
  width: { pct: 100, px: 0 },
  height: { pct: 100, px: 0 },
};

const add = (a: LayoutLength, b: LayoutLength): LayoutLength => ({
  pct: a.pct + b.pct,
  px: a.px + b.px,
});
const scale = (a: LayoutLength, factor: number): LayoutLength => ({
  pct: a.pct * factor,
  px: a.px * factor,
});
const atEnd = (start: LayoutLength, size: LayoutLength): boolean =>
  Math.abs(start.pct + size.pct - 100) < 0.001 && Math.abs(start.px + size.px) < 0.001;

function flattenInto(
  node: LayoutNode,
  rect: LayoutRect,
  axis: "row" | "column",
  path: LayoutSplitPath,
  out: { groups: FlatLayoutGroup[]; handles: FlatLayoutHandle[] },
): void {
  if (node.type === "group") {
    out.groups.push({
      node,
      rect,
      axis,
      touchesTop: Math.abs(rect.top.pct) < 0.001 && Math.abs(rect.top.px) < 0.001,
      touchesRight: atEnd(rect.left, rect.width),
    });
    return;
  }
  const isRow = node.direction === "row";
  const total = isRow ? rect.width : rect.height;
  const collapsedCount = node.children.filter(
    (child) => child.type === "group" && child.collapsed === true,
  ).length;
  const expandedTotal = node.sizes.reduce((sum, size, index) => {
    const child = node.children[index];
    return child?.type === "group" && child.collapsed === true ? sum : sum + size;
  }, 0);
  const shared = add(total, { pct: 0, px: -collapsedCount * COLLAPSED_GROUP_PX });
  let offset: LayoutLength = isRow ? rect.left : rect.top;
  node.children.forEach((child, index) => {
    const collapsed = child.type === "group" && child.collapsed === true;
    const size = collapsed
      ? { pct: 0, px: COLLAPSED_GROUP_PX }
      : scale(shared, (node.sizes[index] ?? 0) / (expandedTotal || 1));
    const childRect: LayoutRect = isRow
      ? { ...rect, left: offset, width: size }
      : { ...rect, top: offset, height: size };
    flattenInto(child, childRect, node.direction, [...path, index], out);
    offset = add(offset, size);
    const next = node.children[index + 1];
    const nextCollapsed = next?.type === "group" && next.collapsed === true;
    if (next !== undefined && !collapsed && !nextCollapsed) {
      out.handles.push({
        id: `${path.join(".")}:${index}`,
        path,
        index,
        direction: node.direction,
        extent: total,
        rect: isRow
          ? { ...rect, left: offset, width: { pct: 0, px: 0 } }
          : { ...rect, top: offset, height: { pct: 0, px: 0 } },
      });
    }
  });
}

/**
 * Turns the tree into positioned rectangles. Panels render as flat siblings, so applying a layout
 * only changes their styles: anything visible before and after keeps its mounted instance.
 */
export function flattenLayout(root: LayoutNode): FlatLayout {
  const out = { groups: [] as FlatLayoutGroup[], handles: [] as FlatLayoutHandle[] };
  flattenInto(root, FULL_RECT, "row", [], out);
  return out;
}

export function layoutLengthCss(length: LayoutLength): string {
  return `calc(${length.pct.toFixed(4)}% + ${length.px.toFixed(2)}px)`;
}

export function layoutRectStyle(rect: LayoutRect): {
  left: string;
  top: string;
  width: string;
  height: string;
} {
  return {
    left: layoutLengthCss(rect.left),
    top: layoutLengthCss(rect.top),
    width: layoutLengthCss(rect.width),
    height: layoutLengthCss(rect.height),
  };
}

/** The part of a group a drop would fill, for showing the drop before it happens. */
export function dropZoneRect(rect: LayoutRect, zone: LayoutDropZone): LayoutRect {
  const halfWidth = scale(rect.width, 0.5);
  const halfHeight = scale(rect.height, 0.5);
  switch (zone) {
    case "center":
      return rect;
    case "left":
      return { ...rect, width: halfWidth };
    case "right":
      return { ...rect, left: add(rect.left, halfWidth), width: halfWidth };
    case "top":
      return { ...rect, height: halfHeight };
    case "bottom":
      return { ...rect, top: add(rect.top, halfHeight), height: halfHeight };
  }
}

/** Where a pointer landed on a group: its outer quarters split it, its middle stacks a tab. */
export function resolveDropZone(
  bounds: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
  allowCenter: boolean,
): LayoutDropZone {
  const x = (point.x - bounds.left) / Math.max(bounds.width, 1);
  const y = (point.y - bounds.top) / Math.max(bounds.height, 1);
  const distances: ReadonlyArray<[Exclude<LayoutDropZone, "center">, number]> = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  const nearest = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best));
  return allowCenter && nearest[1] > 0.25 ? "center" : nearest[0];
}
