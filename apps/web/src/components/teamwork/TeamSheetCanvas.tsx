import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
} from "@dnd-kit/core";
import type { TeamNodeId, TeamNodePosition, TeamSheet, TeamSheetNode } from "@t3tools/contracts";
import { useRef } from "react";

import { cn } from "~/lib/utils";

const CARD_WIDTH = 200;
const CARD_HEIGHT = 72;
const CANVAS_MARGIN = 96;
const RETURN_BOW_MAX = 88;

const KIND_LABEL: Record<TeamSheetNode["kind"], string> = {
  lead: "Lead",
  build: "Build",
  review: "Review",
  validate: "Validate",
};

/** Lines leave and enter a card's edge. One going back up runs down its right side, past the cards. */
function teamEdgePath(from: TeamNodePosition, to: TeamNodePosition) {
  const fromX = from.x + CARD_WIDTH / 2;
  const toX = to.x + CARD_WIDTH / 2;
  const fromY = from.y + CARD_HEIGHT / 2;
  const toY = to.y + CARD_HEIGHT / 2;
  if (Math.abs(to.y - from.y) < CARD_HEIGHT) {
    const forward = to.x >= from.x;
    const startX = from.x + (forward ? CARD_WIDTH : 0);
    const endX = to.x + (forward ? 0 : CARD_WIDTH);
    return `M ${startX} ${fromY} C ${(startX + endX) / 2} ${fromY} ${(startX + endX) / 2} ${toY} ${endX} ${toY}`;
  }
  if (to.y > from.y) {
    const startY = from.y + CARD_HEIGHT;
    const middle = (startY + to.y) / 2;
    return `M ${fromX} ${startY} C ${fromX} ${middle} ${toX} ${middle} ${toX} ${to.y}`;
  }
  const startX = from.x + CARD_WIDTH;
  const endX = to.x + CARD_WIDTH;
  const bow = Math.max(startX, endX) + Math.min(RETURN_BOW_MAX, 24 + (fromY - toY) / 5);
  return `M ${startX} ${fromY} C ${bow} ${fromY} ${bow} ${toY} ${endX} ${toY}`;
}

const dropPosition = (start: TeamNodePosition, delta: { x: number; y: number }) => ({
  x: Math.max(0, Math.round(start.x + delta.x)),
  y: Math.max(0, Math.round(start.y + delta.y)),
});

function TeamNodeCard(props: {
  readonly node: TeamSheetNode;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly onSelect: (nodeId: TeamNodeId) => void;
}) {
  const { node } = props;
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: node.id,
    disabled: props.readOnly,
  });
  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(node.id)}
      style={{
        left: node.position.x,
        top: node.position.y,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}
      className={cn(
        "absolute flex touch-none flex-col justify-center gap-0.5 rounded-md border bg-card px-3 text-start text-card-foreground shadow-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected ? "border-primary" : "border-border",
        props.readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <span className="truncate text-sm font-medium">{node.name}</span>
      <span className="truncate text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</span>
    </button>
  );
}

export function TeamSheetCanvas(props: {
  readonly sheet: Pick<TeamSheet, "nodes" | "edges">;
  readonly selectedNodeId: TeamNodeId | null;
  readonly readOnly: boolean;
  readonly onSelect: (nodeId: TeamNodeId) => void;
  readonly onMove: (nodeId: TeamNodeId, position: TeamNodePosition) => void;
}) {
  const { nodes, edges } = props.sheet;
  const lines = useRef<SVGSVGElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const positionOf = (id: string) => nodes.find((node) => node.id === id)?.position;
  const width = Math.max(...nodes.map((node) => node.position.x)) + CARD_WIDTH + CANVAS_MARGIN;
  const height = Math.max(...nodes.map((node) => node.position.y)) + CARD_HEIGHT + CANVAS_MARGIN;

  // Lines follow the card through the DOM, so a drag re-renders no line.
  const drawLines = (id: string, moved: TeamNodePosition) => {
    for (const path of lines.current?.querySelectorAll("path[data-from]") ?? []) {
      const { from, to } = (path as SVGPathElement).dataset;
      if (from !== id && to !== id) continue;
      const fromPosition = from === id ? moved : positionOf(from ?? "");
      const toPosition = to === id ? moved : positionOf(to ?? "");
      if (fromPosition && toPosition) {
        path.setAttribute("d", teamEdgePath(fromPosition, toPosition));
      }
    }
  };
  const onDragMove = (event: DragMoveEvent) => {
    const id = String(event.active.id);
    const start = positionOf(id);
    if (start !== undefined) drawLines(id, dropPosition(start, event.delta));
  };
  const onDragCancel = (event: DragCancelEvent) => {
    const id = String(event.active.id);
    const start = positionOf(id);
    if (start !== undefined) drawLines(id, start);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const start = positionOf(String(event.active.id));
    if (start === undefined) return;
    if (event.delta.x === 0 && event.delta.y === 0) return;
    props.onMove(event.active.id as TeamNodeId, dropPosition(start, event.delta));
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-muted/30" data-testid="team-sheet-canvas">
      <DndContext
        sensors={sensors}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="relative" style={{ width, height }}>
          <svg
            ref={lines}
            className="pointer-events-none absolute inset-0 text-muted-foreground"
            width={width}
            height={height}
            aria-hidden="true"
          >
            <defs>
              <marker
                id="team-sheet-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <polyline points="0,0 8,4 0,8" fill="none" stroke="currentColor" />
              </marker>
            </defs>
            {edges.map((edge) => {
              const from = positionOf(edge.from);
              const to = positionOf(edge.to);
              if (from === undefined || to === undefined) return null;
              return (
                <path
                  key={`${edge.from}:${edge.to}:${edge.kind}`}
                  data-from={edge.from}
                  data-to={edge.to}
                  data-kind={edge.kind}
                  d={teamEdgePath(from, to)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.25}
                  strokeDasharray={edge.kind === "return" ? "5 4" : undefined}
                  markerEnd="url(#team-sheet-arrow)"
                />
              );
            })}
          </svg>
          {nodes.map((node) => (
            <TeamNodeCard
              key={node.id}
              node={node}
              selected={node.id === props.selectedNodeId}
              readOnly={props.readOnly}
              onSelect={props.onSelect}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
