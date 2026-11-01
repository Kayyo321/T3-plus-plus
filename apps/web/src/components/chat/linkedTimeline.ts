import { createContext } from "react";

/**
 * Lets panes compare turns: the focused pane reports the turn it has reached, and linked panes
 * scroll to their turn of the same ordinal. Turn crossings already drive the minimap, so this adds
 * no per-frame work.
 */
export interface LinkedTimeline {
  /** Only the focused pane leads, so a follower's scroll cannot echo back. */
  readonly leads: boolean;
  readonly publish: (turnOrdinal: number) => void;
  readonly subscribe: (listener: (turnOrdinal: number) => void) => () => void;
}

export const LinkedTimelineContext = createContext<LinkedTimeline | null>(null);

const listeners = new Set<(turnOrdinal: number) => void>();

/** The channel shared by every linked pane. */
export function linkedTimelineFor(leads: boolean): LinkedTimeline {
  return leads ? LEADING_TIMELINE : FOLLOWING_TIMELINE;
}

const subscribe = (listener: (turnOrdinal: number) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const LEADING_TIMELINE: LinkedTimeline = {
  leads: true,
  publish: (turnOrdinal) => {
    for (const listener of listeners) listener(turnOrdinal);
  },
  subscribe: () => () => undefined,
};

const FOLLOWING_TIMELINE: LinkedTimeline = {
  leads: false,
  publish: () => undefined,
  subscribe,
};
