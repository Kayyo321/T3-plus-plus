import { describe, expect, it } from "vite-plus/test";

import { cardsInBox, movedCards, teamSelectionBox } from "./teamSheetSelection";

const cards = [
  { id: "lead", position: { x: 40, y: 24 } },
  { id: "build", position: { x: 40, y: 144 } },
  { id: "review", position: { x: 300, y: 144 } },
];

describe("team sheet selection", () => {
  it("takes every card a box touches, whichever way it was dragged", () => {
    const box = teamSelectionBox({ x: 260, y: 160 }, { x: 200, y: 50 });
    expect(cardsInBox(cards, box)).toEqual(["lead", "build"]);
    expect(cardsInBox(cards, teamSelectionBox({ x: 245, y: 0 }, { x: 295, y: 400 }))).toEqual([]);
  });

  it("stops the whole group at the edge so its spacing holds", () => {
    const moved = movedCards(cards, { x: -100, y: 10 });
    expect(moved.get("lead")).toEqual({ x: 0, y: 34 });
    expect(moved.get("review")).toEqual({ x: 260, y: 154 });
  });
});
