import type { TeamNodePosition } from "@t3tools/contracts";

export const CARD_WIDTH = 200;
export const CARD_HEIGHT = 72;
/** Room left of the cards for lines that can't leave on the right. */
export const LANE_GUTTER = 48;

const LANE_OFFSET = 16;
const LANE_STEP = 12;
const LANE_RADIUS = 10;
const PORT_STEP = { across: 28, along: 14 };

type Side = "top" | "bottom" | "left" | "right";

interface LineCard {
  readonly id: string;
  readonly position: TeamNodePosition;
}

interface LineEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: string;
}

interface Line {
  readonly key: string;
  readonly from: LineCard;
  readonly to: LineCard;
  readonly fromSide: Side;
  readonly toSide: Side;
  /** Absent for a line that goes straight to its target. */
  lane?: number;
}

export const teamEdgeKey = (edge: LineEdge) => `${edge.from}:${edge.to}:${edge.kind}`;

const sharesRow = (left: LineCard, right: LineCard) =>
  left.position.y < right.position.y + CARD_HEIGHT &&
  right.position.y < left.position.y + CARD_HEIGHT;

const centerX = (card: LineCard) => card.position.x + CARD_WIDTH / 2;

function directPathIsClear(cards: ReadonlyArray<LineCard>, from: LineCard, to: LineCard) {
  const left = Math.min(centerX(from), centerX(to));
  const right = Math.max(centerX(from), centerX(to));
  return !cards.some(
    (card) =>
      card !== from &&
      card !== to &&
      card.position.y < to.position.y &&
      card.position.y + CARD_HEIGHT > from.position.y + CARD_HEIGHT &&
      card.position.x < right &&
      card.position.x + CARD_WIDTH > left,
  );
}

function classifyLine(cards: ReadonlyArray<LineCard>, edge: LineEdge): Line | null {
  const from = cards.find((card) => card.id === edge.from);
  const to = cards.find((card) => card.id === edge.to);
  if (from === undefined || to === undefined) return null;
  const key = teamEdgeKey(edge);
  if (sharesRow(from, to)) {
    const forward = to.position.x >= from.position.x;
    return {
      key,
      from,
      to,
      fromSide: forward ? "right" : "left",
      toSide: forward ? "left" : "right",
    };
  }
  if (to.position.y > from.position.y && directPathIsClear(cards, from, to)) {
    return { key, from, to, fromSide: "bottom", toSide: "top" };
  }
  const sideIsClear = (card: LineCard, side: "left" | "right") =>
    !cards.some(
      (other) =>
        other !== card &&
        sharesRow(other, card) &&
        (side === "right"
          ? other.position.x > card.position.x
          : other.position.x < card.position.x),
    );
  const side =
    !sideIsClear(from, "right") || !sideIsClear(to, "right")
      ? sideIsClear(from, "left") && sideIsClear(to, "left")
        ? "left"
        : "right"
      : "right";
  return { key, from, to, fromSide: side, toSide: side, lane: 0 };
}

const span = (line: Line) => Math.abs(line.to.position.y - line.from.position.y);

/** Shorter spans sit nearest the cards, so a line wrapping another never crosses it. */
function assignLanes(lines: ReadonlyArray<Line>, side: "left" | "right") {
  const onSide = lines
    .filter((line) => line.lane !== undefined && line.fromSide === side)
    .toSorted((left, right) => span(left) - span(right));
  onSide.forEach((line, index) => {
    line.lane = index;
  });
  return onSide.length;
}

/** Keeps lines on one card edge from crossing as they spread out from it. */
function portOrder(line: Line, card: LineCard, other: LineCard, side: Side) {
  if (side === "top" || side === "bottom") return centerX(other);
  const lane = line.lane ?? 0;
  return other.position.y < card.position.y ? lane : 1_000 - lane;
}

function assignPorts(lines: ReadonlyArray<Line>) {
  const groups = new Map<string, Array<{ end: string; order: number }>>();
  const add = (line: Line, end: "from" | "to") => {
    const card = line[end];
    const side = end === "from" ? line.fromSide : line.toSide;
    const other = end === "from" ? line.to : line.from;
    const group = `${card.id}:${side}`;
    const ports = groups.get(group) ?? [];
    ports.push({ end: `${line.key}:${end}`, order: portOrder(line, card, other, side) });
    groups.set(group, ports);
  };
  for (const line of lines) {
    add(line, "from");
    add(line, "to");
  }
  const offsets = new Map<string, number>();
  for (const [group, ports] of groups) {
    const across = group.endsWith(":top") || group.endsWith(":bottom");
    const step = across ? PORT_STEP.across : PORT_STEP.along;
    const room = (across ? CARD_WIDTH : CARD_HEIGHT) / (ports.length + 1);
    ports
      .toSorted((left, right) => left.order - right.order)
      .forEach((port, index) => {
        offsets.set(port.end, (index - (ports.length - 1) / 2) * Math.min(step, room));
      });
  }
  return offsets;
}

function portPoint(card: LineCard, side: Side, offset: number) {
  const { x, y } = card.position;
  switch (side) {
    case "top":
      return { x: x + CARD_WIDTH / 2 + offset, y };
    case "bottom":
      return { x: x + CARD_WIDTH / 2 + offset, y: y + CARD_HEIGHT };
    case "left":
      return { x, y: y + CARD_HEIGHT / 2 + offset };
    case "right":
      return { x: x + CARD_WIDTH, y: y + CARD_HEIGHT / 2 + offset };
  }
}

function lanePath(start: TeamNodePosition, end: TeamNodePosition, laneX: number) {
  const across = Math.sign(laneX - start.x);
  const along = Math.sign(end.y - start.y) || 1;
  const radius = Math.min(LANE_RADIUS, Math.abs(end.y - start.y) / 2);
  return [
    `M ${start.x} ${start.y}`,
    `H ${laneX - across * radius}`,
    `Q ${laneX} ${start.y} ${laneX} ${start.y + along * radius}`,
    `V ${end.y - along * radius}`,
    `Q ${laneX} ${end.y} ${laneX - across * radius} ${end.y}`,
    `L ${end.x} ${end.y}`,
  ].join(" ");
}

function directPath(line: Line, start: TeamNodePosition, end: TeamNodePosition) {
  if (line.fromSide === "bottom") {
    const middle = (start.y + end.y) / 2;
    return `M ${start.x} ${start.y} C ${start.x} ${middle} ${end.x} ${middle} ${end.x} ${end.y}`;
  }
  const middle = (start.x + end.x) / 2;
  return `M ${start.x} ${start.y} C ${middle} ${start.y} ${middle} ${end.y} ${end.x} ${end.y}`;
}

/**
 * Lines going down run straight to their target. Everything else takes its own lane beside the
 * cards, on whichever side both ends can reach without passing through another card.
 */
export function teamLineLayout(cards: ReadonlyArray<LineCard>, edges: ReadonlyArray<LineEdge>) {
  const lines = edges.flatMap((edge) => classifyLine(cards, edge) ?? []);
  const rightLanes = assignLanes(lines, "right");
  const leftLanes = assignLanes(lines, "left");
  const offsets = assignPorts(lines);
  const cardsLeft = Math.min(...cards.map((card) => card.position.x));
  const cardsRight = Math.max(...cards.map((card) => card.position.x + CARD_WIDTH));
  const leftStep = Math.min(LANE_STEP, (cardsLeft + LANE_GUTTER - LANE_OFFSET) / (leftLanes + 1));
  const laneX = (line: Line, lane: number) =>
    line.fromSide === "right"
      ? cardsRight + LANE_OFFSET + lane * LANE_STEP
      : cardsLeft - LANE_OFFSET - lane * leftStep;

  const paths = new Map<string, string>();
  for (const line of lines) {
    const start = portPoint(line.from, line.fromSide, offsets.get(`${line.key}:from`) ?? 0);
    const end = portPoint(line.to, line.toSide, offsets.get(`${line.key}:to`) ?? 0);
    paths.set(
      line.key,
      line.lane === undefined
        ? directPath(line, start, end)
        : lanePath(start, end, laneX(line, line.lane)),
    );
  }
  return { paths, right: cardsRight + LANE_OFFSET + rightLanes * LANE_STEP };
}
