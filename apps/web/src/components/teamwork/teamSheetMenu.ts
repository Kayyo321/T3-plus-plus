import type { ContextMenuItem, TeamNodeId, TeamSheet, TeamSheetChange } from "@t3tools/contracts";

const EDGE_KINDS = [
  { kind: "handoff", label: "Handoff" },
  { kind: "return", label: "Return" },
] as const;

export type TeamNodeMenuAction = { readonly type: "rename" } | TeamSheetChange;

export function teamNodeMenu(sheet: Pick<TeamSheet, "nodes" | "edges">, nodeId: TeamNodeId) {
  const actions = new Map<string, TeamNodeMenuAction>([["rename", { type: "rename" }]]);
  const node = sheet.nodes.find((candidate) => candidate.id === nodeId);
  const targets = sheet.nodes.filter((candidate) => candidate.id !== nodeId);
  const connectTo = targets.map((target): ContextMenuItem => ({
    id: `target:${target.id}`,
    label: target.name,
    children: EDGE_KINDS.map(({ kind, label }) => {
      const edge = { from: nodeId, to: target.id, kind };
      const connected = sheet.edges.some(
        (entry) => entry.from === edge.from && entry.to === edge.to && entry.kind === kind,
      );
      const id = `connect:${target.id}:${kind}`;
      actions.set(id, { type: connected ? "disconnect" : "connect", edge });
      return { id, label, checked: connected };
    }),
  }));
  const items: Array<ContextMenuItem> = [
    { id: "rename", label: "Rename" },
    ...(connectTo.length > 0 ? [{ id: "connect", label: "Connect to", children: connectTo }] : []),
  ];
  if (node !== undefined && node.kind !== "lead") {
    actions.set("delete", { type: "remove_node", nodeId });
    items.push({ id: "delete", label: "Delete team", destructive: true, separatorBefore: true });
  }
  return { items, actions };
}
