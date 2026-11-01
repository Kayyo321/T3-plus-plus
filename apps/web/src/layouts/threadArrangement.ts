import type { RightPanelSurface } from "../rightPanelStore";
import {
  CONVERSATION_PANEL,
  findGroup,
  isConversationGroup,
  type LayoutDocument,
  type LayoutDropZone,
  type LayoutGroupNode,
  type LayoutNode,
  type LayoutPanes,
  type LayoutSettings,
  LAYOUT_DOCUMENT_VERSION,
  listGroups,
  mapGroups,
  nextGroupId,
  pruneGroups,
  splitBeside,
} from "./layoutDocument";

/** Kinds a layout can open by itself. Files, browser pages, and pull requests name content. */
const RECREATABLE_KINDS: ReadonlySet<string> = new Set([
  "diff",
  "files",
  "git-graph",
  "pull-requests",
  "preview",
  "terminal",
]);

/**
 * One conversation's live arrangement, stored with the surfaces it places. Absent means the plain
 * right panel. `placements` holds tabs dragged away from the group their kind routes to.
 */
export interface ThreadArrangement {
  readonly layoutId: string | null;
  readonly root: LayoutNode;
  readonly placements: Readonly<Record<string, string>>;
  readonly activeByGroup: Readonly<Record<string, string>>;
  /** The group whose add button was pressed; the next new surface lands there. */
  readonly targetGroupId?: string;
  /** Terminal and browser tabs need ChatView's actions, so it opens these after apply. */
  readonly pendingOpens?: ReadonlyArray<string>;
  /** Bumps when a layout is applied, which is what animates. */
  readonly revision: number;
}

export function panelGroups(root: LayoutNode): LayoutGroupNode[] {
  return listGroups(root).filter((group) => !isConversationGroup(group));
}

export function arrangementFromDocument(
  document: LayoutDocument,
  revision: number,
): ThreadArrangement | null {
  if (panelGroups(document.root).length === 0) return null;
  return {
    layoutId: document.id,
    root: document.root,
    placements: {},
    activeByGroup: {},
    revision,
  };
}

export function surfaceGroupId(arrangement: ThreadArrangement, surface: RightPanelSurface): string {
  const groups = panelGroups(arrangement.root);
  const placed = arrangement.placements[surface.id];
  if (placed !== undefined && groups.some((group) => group.id === placed)) return placed;
  const routed = groups.find((group) => group.kinds.includes(surface.kind)) ?? groups.at(-1);
  return routed?.id ?? CONVERSATION_PANEL;
}

export function surfacesInGroup(
  arrangement: ThreadArrangement,
  surfaces: ReadonlyArray<RightPanelSurface>,
  groupId: string,
): RightPanelSurface[] {
  return surfaces.filter((surface) => surfaceGroupId(arrangement, surface) === groupId);
}

export function activeSurfaceOfGroup(
  arrangement: ThreadArrangement,
  group: LayoutGroupNode,
  surfaces: ReadonlyArray<RightPanelSurface>,
): RightPanelSurface | null {
  const members = surfacesInGroup(arrangement, surfaces, group.id);
  const activeId = arrangement.activeByGroup[group.id];
  return (
    members.find((surface) => surface.id === activeId) ??
    members.find((surface) => surface.kind === group.opens[0]) ??
    members[0] ??
    null
  );
}

/** Keeps per-group state true after any store action changed the surfaces or the active one. */
export function reconcileArrangement(
  arrangement: ThreadArrangement,
  previousSurfaces: ReadonlyArray<RightPanelSurface>,
  surfaces: ReadonlyArray<RightPanelSurface>,
  activeSurfaceId: string | null,
): ThreadArrangement {
  let next = arrangement;
  if (next.targetGroupId !== undefined) {
    const added = surfaces.find(
      (surface) => !previousSurfaces.some((entry) => entry.id === surface.id),
    );
    if (added) {
      const { targetGroupId, ...rest } = next;
      next = { ...rest, placements: { ...rest.placements, [added.id]: targetGroupId } };
    }
  }
  if (surfaces !== previousSurfaces) {
    const placements = Object.fromEntries(
      Object.entries(next.placements).filter(([surfaceId]) =>
        surfaces.some((surface) => surface.id === surfaceId),
      ),
    );
    if (Object.keys(placements).length !== Object.keys(next.placements).length) {
      next = { ...next, placements };
    }
  }
  const active = surfaces.find((surface) => surface.id === activeSurfaceId);
  if (active) {
    const groupId = surfaceGroupId(next, active);
    if (next.activeByGroup[groupId] !== active.id) {
      next = { ...next, activeByGroup: { ...next.activeByGroup, [groupId]: active.id } };
    }
  }
  return next;
}

function moveKind(
  root: LayoutNode,
  kind: string,
  sourceId: string,
  targetId: string,
  sourceKeepsKind: boolean,
): LayoutNode {
  return mapGroups(root, (group) => {
    if (group.id === sourceId && !sourceKeepsKind) {
      return {
        ...group,
        kinds: group.kinds.filter((entry) => entry !== kind),
        opens: group.opens.filter((entry) => entry !== kind),
      };
    }
    if (group.id === targetId && !group.kinds.includes(kind)) {
      return { ...group, kinds: [...group.kinds, kind] };
    }
    return group;
  });
}

/** Stacks a tab into a group, or splits it out beside one. A group left empty goes away. */
export function moveSurface(
  arrangement: ThreadArrangement,
  surfaces: ReadonlyArray<RightPanelSurface>,
  surfaceId: string,
  targetGroupId: string,
  zone: LayoutDropZone,
): ThreadArrangement {
  const surface = surfaces.find((entry) => entry.id === surfaceId);
  if (!surface) return arrangement;
  const sourceId = surfaceGroupId(arrangement, surface);
  if (zone === "center" && sourceId === targetGroupId) return arrangement;
  const target = findGroup(arrangement.root, targetGroupId);
  if (!target || (zone === "center" && isConversationGroup(target))) return arrangement;
  const remaining = surfacesInGroup(arrangement, surfaces, sourceId).filter(
    (entry) => entry.id !== surfaceId,
  );
  const destinationId = zone === "center" ? targetGroupId : nextGroupId(arrangement.root);
  const withDestination =
    zone === "center"
      ? arrangement.root
      : splitBeside(arrangement.root, targetGroupId, zone, {
          type: "group",
          id: destinationId,
          kinds: [],
          opens: [],
        });
  const moved = moveKind(
    withDestination,
    surface.kind,
    sourceId,
    destinationId,
    remaining.some((entry) => entry.kind === surface.kind),
  );
  const pruned = pruneGroups(
    moved,
    (group) => group.id === sourceId && remaining.length === 0 && group.kinds.length === 0,
  );
  return {
    ...arrangement,
    root: pruned ?? moved,
    placements: { ...arrangement.placements, [surfaceId]: destinationId },
    activeByGroup: { ...arrangement.activeByGroup, [destinationId]: surfaceId },
  };
}

/** Docks the conversation beside a group. It never stacks: it is the chat column itself. */
export function moveConversation(
  arrangement: ThreadArrangement,
  targetGroupId: string,
  zone: Exclude<LayoutDropZone, "center">,
): ThreadArrangement {
  const conversation = listGroups(arrangement.root).find(isConversationGroup);
  if (!conversation || targetGroupId === CONVERSATION_PANEL) return arrangement;
  const without = pruneGroups(arrangement.root, isConversationGroup);
  if (without === null) return arrangement;
  return { ...arrangement, root: splitBeside(without, targetGroupId, zone, conversation) };
}

export function setGroupCollapsed(
  arrangement: ThreadArrangement,
  groupId: string,
  collapsed: boolean,
): ThreadArrangement {
  return {
    ...arrangement,
    root: mapGroups(arrangement.root, (group) => {
      if (group.id !== groupId) return group;
      const { collapsed: _collapsed, ...rest } = group;
      return collapsed ? { ...rest, collapsed: true } : rest;
    }),
  };
}

/** Removes a group. Its tabs stay open and fall to another group, or to the plain right panel. */
export function closeGroup(
  arrangement: ThreadArrangement,
  groupId: string,
): ThreadArrangement | null {
  const root = pruneGroups(arrangement.root, (group) => group.id === groupId);
  if (root === null || panelGroups(root).length === 0) return null;
  const { [groupId]: _active, ...activeByGroup } = arrangement.activeByGroup;
  const placements = Object.fromEntries(
    Object.entries(arrangement.placements).filter(([, placed]) => placed !== groupId),
  );
  return { ...arrangement, root, placements, activeByGroup };
}

function capturedGroup(
  group: LayoutGroupNode,
  arrangement: ThreadArrangement,
  surfaces: ReadonlyArray<RightPanelSurface>,
): LayoutGroupNode {
  if (isConversationGroup(group)) return group;
  const members = surfacesInGroup(arrangement, surfaces, group.id);
  const activeKind = activeSurfaceOfGroup(arrangement, group, surfaces)?.kind as string | undefined;
  const memberKinds = members.map((surface) => surface.kind as string);
  return {
    ...group,
    kinds: [...new Set([...group.kinds, ...memberKinds])],
    opens: [...new Set(memberKinds)]
      .filter((kind) => RECREATABLE_KINDS.has(kind))
      .toSorted((a, b) => Number(b === activeKind) - Number(a === activeKind)),
  };
}

/** The document for what a conversation shows now: kinds and geometry, nothing it displays. */
export function captureLayoutDocument(input: {
  readonly id: string;
  readonly name: string;
  readonly arrangement: ThreadArrangement | undefined;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly panelOpen: boolean;
  readonly panes: LayoutPanes | null;
  readonly settings: LayoutSettings;
}): LayoutDocument {
  const { arrangement, surfaces } = input;
  const conversation: LayoutGroupNode = {
    type: "group",
    id: CONVERSATION_PANEL,
    kinds: [CONVERSATION_PANEL],
    opens: [],
  };
  const kinds = [...new Set(surfaces.map((surface) => surface.kind as string))];
  const root: LayoutNode = arrangement
    ? mapGroups(arrangement.root, (group) => capturedGroup(group, arrangement, surfaces))
    : input.panelOpen && surfaces.length > 0
      ? {
          type: "split",
          direction: "row",
          sizes: [0.55, 0.45],
          children: [
            conversation,
            {
              type: "group",
              id: "panel",
              kinds,
              opens: kinds.filter((kind) => RECREATABLE_KINDS.has(kind)),
            },
          ],
        }
      : conversation;
  return {
    version: LAYOUT_DOCUMENT_VERSION,
    id: input.id,
    name: input.name,
    root,
    panes: input.panes,
    settings: input.settings,
  };
}
