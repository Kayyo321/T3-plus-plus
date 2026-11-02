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
import type {
  TeamNodeId,
  TeamNodePosition,
  TeamSheet,
  TeamSheetEdge,
  TeamSheetNode,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LocateFixedIcon } from "lucide-react";
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";

import { useStableCallback } from "~/hooks/useStableCallback";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { registerCommands } from "~/shortcuts/dispatcher";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  LANE_GUTTER,
  teamEdgeKey,
  teamLineLayout,
} from "./teamSheetLines";
import { cardsInBox, movedCards, teamSelectionBox } from "./teamSheetSelection";

const CANVAS_MARGIN = 96;
const LANE_MARGIN = 24;
const LINE_HIT_WIDTH = 12;
const BOX_DRAG_DISTANCE = 4;

export interface TeamMenuPoint {
  readonly x: number;
  readonly y: number;
}

const KIND_LABEL: Record<TeamSheetNode["kind"], string> = {
  lead: "Lead",
  build: "Build",
  review: "Review",
  validate: "Validate",
};

/** On Linux, releasing the middle button pastes the primary selection into the focused composer. */
const refusePaste = (event: Event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
};

const dropPosition = (start: TeamNodePosition, delta: { x: number; y: number }) => ({
  x: Math.max(0, Math.round(start.x + delta.x)),
  y: Math.max(0, Math.round(start.y + delta.y)),
});

function TeamNodeCard(props: {
  readonly node: TeamSheetNode;
  readonly selected: boolean;
  readonly readOnly: boolean;
  readonly onSelect: (nodeId: TeamNodeId) => void;
  readonly onMenu: (nodeId: TeamNodeId, point: TeamMenuPoint) => void;
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
      data-team-card={node.id}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(node.id)}
      onContextMenu={(event) => {
        if (props.readOnly) return;
        event.preventDefault();
        event.stopPropagation();
        props.onSelect(node.id);
        props.onMenu(node.id, { x: event.clientX, y: event.clientY });
      }}
      style={{
        left: node.position.x + LANE_GUTTER,
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
  readonly selectedNodeIds: ReadonlyArray<TeamNodeId>;
  readonly readOnly: boolean;
  readonly onSelect: (nodeId: TeamNodeId) => void;
  readonly onSelectMany: (nodeIds: ReadonlyArray<TeamNodeId>) => void;
  readonly onMove: (moved: ReadonlyMap<TeamNodeId, TeamNodePosition>) => void;
  readonly onNodeMenu: (nodeId: TeamNodeId, point: TeamMenuPoint) => void;
  readonly onCanvasMenu: (position: TeamNodePosition, point: TeamMenuPoint) => void;
  readonly onEdgeMenu: (edge: TeamSheetEdge, point: TeamMenuPoint) => void;
}) {
  const { nodes, edges } = props.sheet;
  const lines = useRef<SVGSVGElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const pan = useRef({ x: 0, y: 0 });
  const panGrab = useRef<TeamNodePosition | null>(null);
  const selectionBox = useRef<HTMLDivElement>(null);
  const boxStart = useRef<TeamNodePosition | null>(null);
  const boxDragging = useRef(false);
  const boxHits = useRef("");
  const recenterShortcut = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "teamSheet.recenter",
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const layout = teamLineLayout(nodes, edges);
  const width =
    LANE_GUTTER +
    Math.max(
      Math.max(...nodes.map((node) => node.position.x)) + CARD_WIDTH + CANVAS_MARGIN,
      layout.right + LANE_MARGIN,
    );
  const height = Math.max(...nodes.map((node) => node.position.y)) + CARD_HEIGHT + CANVAS_MARGIN;

  // Lines follow the card through the DOM, so a drag re-renders no line.
  const drawLines = (moved: ReadonlyMap<string, TeamNodePosition>) => {
    const { paths } = teamLineLayout(
      nodes.map((node) => {
        const position = moved.get(node.id);
        return position === undefined ? node : { ...node, position };
      }),
      edges,
    );
    for (const path of lines.current?.querySelectorAll("path[data-edge]") ?? []) {
      const line = paths.get((path as SVGPathElement).dataset.edge ?? "");
      if (line !== undefined) path.setAttribute("d", line);
    }
  };
  // Like a dragged card, the chart moves through the DOM so a pan re-renders nothing.
  const panTo = (x: number, y: number) => {
    pan.current = { x, y };
    if (content.current !== null) content.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  const recenter = useStableCallback(() => {
    panTo(0, 0);
    scroller.current?.scrollTo(0, 0);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shortcut dispatcher lives outside React and acts on the chart while it is open
  useEffect(
    () =>
      registerCommands({
        "teamSheet.recenter": (event) => {
          event.preventDefault();
          event.stopPropagation();
          recenter();
        },
      }),
    [recenter],
  );

  const pointOnSheet = (event: ReactPointerEvent<HTMLDivElement>) => {
    const sheet = content.current?.getBoundingClientRect();
    return {
      x: event.clientX - (sheet?.left ?? 0) - LANE_GUTTER,
      y: event.clientY - (sheet?.top ?? 0),
    };
  };
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    window.addEventListener("paste", refusePaste, { capture: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.cursor = "grabbing";
    panGrab.current = { x: event.clientX - pan.current.x, y: event.clientY - pan.current.y };
  };
  const startBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    const area = event.currentTarget;
    const { left, top } = area.getBoundingClientRect();
    const onScrollbar =
      event.clientX - left >= area.clientWidth || event.clientY - top >= area.clientHeight;
    if (onScrollbar || (event.target as Element).closest("button") !== null) return;
    area.setPointerCapture(event.pointerId);
    boxStart.current = pointOnSheet(event);
    boxDragging.current = false;
    boxHits.current = "";
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1) startPan(event);
    else if (event.button === 0 && !props.readOnly) startBox(event);
  };
  const dragBox = (event: ReactPointerEvent<HTMLDivElement>, start: TeamNodePosition) => {
    const point = pointOnSheet(event);
    const distance = Math.hypot(point.x - start.x, point.y - start.y);
    if (!boxDragging.current && distance < BOX_DRAG_DISTANCE) return;
    boxDragging.current = true;
    const box = teamSelectionBox(start, point);
    if (selectionBox.current !== null) {
      selectionBox.current.style.display = "block";
      selectionBox.current.style.left = `${box.left + LANE_GUTTER}px`;
      selectionBox.current.style.top = `${box.top}px`;
      selectionBox.current.style.width = `${box.right - box.left}px`;
      selectionBox.current.style.height = `${box.bottom - box.top}px`;
    }
    const hits = cardsInBox(nodes, box);
    if (hits.join() !== boxHits.current) {
      boxHits.current = hits.join();
      props.onSelectMany(hits);
    }
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panGrab.current !== null) {
      panTo(event.clientX - panGrab.current.x, event.clientY - panGrab.current.y);
    } else if (boxStart.current !== null) {
      dragBox(event, boxStart.current);
    }
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panGrab.current !== null) {
      // The paste follows this event, so the guard outlives it by one task.
      setTimeout(() => window.removeEventListener("paste", refusePaste, { capture: true }));
    }
    panGrab.current = null;
    event.currentTarget.style.cursor = "";
    if (boxStart.current === null) return;
    if (!boxDragging.current && props.selectedNodeIds.length > 1) props.onSelectMany([]);
    boxStart.current = null;
    if (selectionBox.current !== null) selectionBox.current.style.display = "";
  };

  const draggedCards = (id: string) => {
    const group = props.selectedNodeIds.some((nodeId) => nodeId === id);
    return nodes.filter((node) =>
      group ? props.selectedNodeIds.includes(node.id) : node.id === id,
    );
  };
  // dnd-kit moves only the card under the pointer, so the rest of a group follows through the DOM.
  const offsetGroup = (id: string, moved: ReadonlyMap<string, TeamNodePosition>) => {
    for (const card of content.current?.querySelectorAll<HTMLElement>("[data-team-card]") ?? []) {
      const cardId = card.dataset.teamCard ?? "";
      const position = moved.get(cardId);
      const start = nodes.find((node) => node.id === cardId)?.position;
      if (cardId === id) continue;
      card.style.transform =
        position === undefined || start === undefined
          ? ""
          : `translate(${position.x - start.x}px, ${position.y - start.y}px)`;
    }
  };
  const onDragMove = (event: DragMoveEvent) => {
    const id = String(event.active.id);
    const moved = movedCards(draggedCards(id), event.delta);
    drawLines(moved);
    offsetGroup(id, moved);
  };
  const onDragCancel = (event: DragCancelEvent) => {
    drawLines(new Map());
    offsetGroup(String(event.active.id), new Map());
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (event.delta.x === 0 && event.delta.y === 0) return;
    const id = String(event.active.id);
    flushSync(() => props.onMove(movedCards(draggedCards(id), event.delta)));
    offsetGroup(id, new Map());
  };

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <div
        ref={scroller}
        className="absolute inset-0 overflow-auto bg-muted/30 select-none"
        data-testid="team-sheet-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        // Without this the browser starts its own autoscroll on a middle press.
        onMouseDown={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onMouseUp={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
      >
        <DndContext
          sensors={sensors}
          onDragMove={onDragMove}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          <div
            ref={content}
            className="relative"
            style={{ width, height }}
            onContextMenu={(event) => {
              if (props.readOnly) return;
              event.preventDefault();
              const canvas = event.currentTarget.getBoundingClientRect();
              props.onCanvasMenu(
                dropPosition(
                  { x: -LANE_GUTTER - CARD_WIDTH / 2, y: -CARD_HEIGHT / 2 },
                  { x: event.clientX - canvas.left, y: event.clientY - canvas.top },
                ),
                { x: event.clientX, y: event.clientY },
              );
            }}
          >
            <svg
              ref={lines}
              className="pointer-events-none absolute inset-0 overflow-visible text-muted-foreground"
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
              <g transform={`translate(${LANE_GUTTER} 0)`}>
                {edges.map((edge) => {
                  const key = teamEdgeKey(edge);
                  const line = layout.paths.get(key);
                  return (
                    <g key={key} className="hover:text-foreground">
                      <path
                        data-edge={key}
                        data-kind={edge.kind}
                        d={line}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={1.25}
                        strokeDasharray={edge.kind === "return" ? "5 4" : undefined}
                        markerEnd="url(#team-sheet-arrow)"
                      />
                      {props.readOnly ? null : (
                        <path
                          data-edge={key}
                          d={line}
                          fill="none"
                          stroke="transparent"
                          strokeWidth={LINE_HIT_WIDTH}
                          style={{ pointerEvents: "stroke" }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            props.onEdgeMenu(edge, { x: event.clientX, y: event.clientY });
                          }}
                        />
                      )}
                    </g>
                  );
                })}
              </g>
            </svg>
            {nodes.map((node) => (
              <TeamNodeCard
                key={node.id}
                node={node}
                selected={props.selectedNodeIds.includes(node.id)}
                readOnly={props.readOnly}
                onSelect={props.onSelect}
                onMenu={props.onNodeMenu}
              />
            ))}
            <div
              ref={selectionBox}
              className="pointer-events-none absolute hidden rounded-xs border border-primary bg-primary/10"
            />
          </div>
        </DndContext>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="outline"
              className="absolute right-2 bottom-2"
              aria-label="Recenter"
              onClick={recenter}
            />
          }
        >
          <LocateFixedIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="left">
          {recenterShortcut === null ? "Recenter" : `Recenter (${recenterShortcut})`}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
