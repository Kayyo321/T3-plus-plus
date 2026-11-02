import { describe, expect, it } from "vite-plus/test";

import { CARD_WIDTH, teamEdgeKey, teamLineLayout } from "./teamSheetLines";

const cards = [
  { id: "lead", position: { x: 36, y: 24 } },
  { id: "luna", position: { x: 36, y: 140 } },
  { id: "haiku", position: { x: 236, y: 140 } },
  { id: "review", position: { x: 36, y: 264 } },
  { id: "validate", position: { x: 36, y: 384 } },
];

const edges = [
  { from: "lead", to: "luna", kind: "handoff" },
  { from: "lead", to: "haiku", kind: "handoff" },
  { from: "luna", to: "review", kind: "handoff" },
  { from: "haiku", to: "review", kind: "handoff" },
  { from: "review", to: "validate", kind: "handoff" },
  { from: "validate", to: "lead", kind: "handoff" },
  { from: "review", to: "luna", kind: "return" },
  { from: "review", to: "haiku", kind: "return" },
  { from: "validate", to: "luna", kind: "return" },
  { from: "validate", to: "haiku", kind: "return" },
];

const laneX = (path: string) => Number(/ V /.test(path) ? /Q (-?[\d.]+) /.exec(path)?.[1] : NaN);
const endPoints = (path: string) => {
  const [startX, startY] = path.slice(2).split(" ").map(Number);
  const end = path.split(" ").slice(-2).map(Number);
  return { start: `${startX},${startY}`, end: end.join(",") };
};

describe("teamLineLayout", () => {
  const { paths } = teamLineLayout(cards, edges);
  const path = (from: string, to: string, kind: string) =>
    paths.get(teamEdgeKey({ from, to, kind })) ?? "";

  it("sends each line back up on a side that no card blocks", () => {
    const cardsRight = Math.max(...cards.map((card) => card.position.x + CARD_WIDTH));
    const cardsLeft = Math.min(...cards.map((card) => card.position.x));
    expect(laneX(path("review", "haiku", "return"))).toBeGreaterThan(cardsRight);
    expect(laneX(path("validate", "haiku", "return"))).toBeGreaterThan(cardsRight);
    expect(laneX(path("validate", "lead", "handoff"))).toBeGreaterThan(cardsRight);
    expect(laneX(path("review", "luna", "return"))).toBeLessThan(cardsLeft);
    expect(laneX(path("validate", "luna", "return"))).toBeLessThan(cardsLeft);
  });

  it("gives every line its own lane and its own point on a card", () => {
    const all = [...paths.values()];
    const lanes = all.filter((value) => value.includes(" V ")).map(laneX);
    expect(new Set(lanes).size).toBe(lanes.length);
    const points = all.flatMap((value) => Object.values(endPoints(value)));
    expect(new Set(points).size).toBe(points.length);
  });

  it("keeps a wider span outside a narrower one that shares its card", () => {
    expect(laneX(path("validate", "haiku", "return"))).toBeGreaterThan(
      laneX(path("review", "haiku", "return")),
    );
  });

  it("routes around a card sitting between two rows", () => {
    const skip = [{ from: "lead", to: "review", kind: "handoff" }];
    const value = teamLineLayout(cards, skip).paths.get(teamEdgeKey(skip[0]!)) ?? "";
    expect(value).toContain(" V ");
  });
});
