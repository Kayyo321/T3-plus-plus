import type { PreviewMiniPlayerFrame } from "../preview/previewMiniPlayerLayout";
import { DETAILS_CARD_CLEARANCE } from "./chatCanvasLayout";

export const THREAD_DETAILS_CARD_GAP = 12;
export const THREAD_DETAILS_BRANCH_VIEW_MIN_HEIGHT = 112;
const THREAD_DETAILS_COLUMN_MIN_HEIGHT = 160;
// Keep in sync with --thread-details-panel-width.
const THREAD_DETAILS_CARD_WIDTH = 280;

export function resolveThreadDetailsCardDensity(
  height: number,
  content: { full: number; compact: number },
) {
  if (content.full === 0 || content.full <= height) return "full";
  if (content.compact === 0 || content.compact <= height) return "compact";
  return "essential";
}

export function resolveThreadDetailsCardLayout({
  container,
  lane,
  frame,
  overlapsDetailsCard = false,
  topInset = 0,
}: {
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  frame: PreviewMiniPlayerFrame | null;
  overlapsDetailsCard?: boolean;
  topInset?: number;
}) {
  const width = THREAD_DETAILS_CARD_WIDTH;
  const x = container.width - width;
  if (x - DETAILS_CARD_CLEARANCE - lane.padding < lane.minChatWidth) return null;
  const y = topInset;
  const height =
    overlapsDetailsCard && frame && frame.x + frame.width > x && frame.x < x + width
      ? Math.min(container.height - y, frame.y - y)
      : container.height - y;
  if (height < THREAD_DETAILS_COLUMN_MIN_HEIGHT) return null;
  return {
    x,
    right: 0,
    width,
    y,
    height,
  } as const;
}
