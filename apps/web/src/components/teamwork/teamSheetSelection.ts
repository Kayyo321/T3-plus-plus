import type { TeamNodePosition } from "@t3tools/contracts";

import { CARD_HEIGHT, CARD_WIDTH } from "./teamSheetLines";

interface SelectableCard<Id extends string> {
  readonly id: Id;
  readonly position: TeamNodePosition;
}

export interface TeamSelectionBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const teamSelectionBox = (
  from: TeamNodePosition,
  to: TeamNodePosition,
): TeamSelectionBox => ({
  left: Math.min(from.x, to.x),
  top: Math.min(from.y, to.y),
  right: Math.max(from.x, to.x),
  bottom: Math.max(from.y, to.y),
});

export const cardsInBox = <Id extends string>(
  cards: ReadonlyArray<SelectableCard<Id>>,
  box: TeamSelectionBox,
) =>
  cards
    .filter(
      ({ position }) =>
        position.x < box.right &&
        position.x + CARD_WIDTH > box.left &&
        position.y < box.bottom &&
        position.y + CARD_HEIGHT > box.top,
    )
    .map((card) => card.id);

/** The whole group stops at the canvas edge, so its cards keep their spacing. */
export function movedCards<Id extends string>(
  cards: ReadonlyArray<SelectableCard<Id>>,
  delta: TeamNodePosition,
) {
  const x = Math.max(delta.x, -Math.min(...cards.map((card) => card.position.x)));
  const y = Math.max(delta.y, -Math.min(...cards.map((card) => card.position.y)));
  return new Map(
    cards.map((card) => [
      card.id,
      { x: Math.round(card.position.x + x), y: Math.round(card.position.y + y) },
    ]),
  );
}
