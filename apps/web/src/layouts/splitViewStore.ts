import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { INITIAL_SPLIT_VIEW, type SplitPane, type SplitViewState } from "./splitView.logic";

const SPLIT_VIEW_STORAGE_KEY = "t3pp:split-view:v1";
const SPLIT_VIEW_STORAGE_VERSION = 1;

/** Keeps server conversations only: a draft belongs to the session that opened it. */
function hydrateSplitView(persisted: unknown): SplitViewState {
  if (typeof persisted !== "object" || persisted === null) return INITIAL_SPLIT_VIEW;
  const raw = persisted as Partial<Record<keyof SplitViewState, unknown>>;
  if (!Array.isArray(raw.panes)) return INITIAL_SPLIT_VIEW;
  const panes = raw.panes.flatMap((entry: unknown): SplitPane[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const pane = entry as { id?: unknown; target?: unknown; collapsed?: unknown };
    if (typeof pane.id !== "string") return [];
    const target = pane.target as { kind?: unknown; threadRef?: Record<string, unknown> } | null;
    const ref = target?.kind === "server" ? target.threadRef : undefined;
    return [
      {
        id: pane.id,
        target:
          typeof ref?.environmentId === "string" && typeof ref.threadId === "string"
            ? {
                kind: "server",
                threadRef: scopeThreadRef(
                  EnvironmentId.make(ref.environmentId),
                  ThreadId.make(ref.threadId),
                ),
              }
            : null,
        ...(pane.collapsed === true ? { collapsed: true as const } : {}),
      },
    ];
  });
  if (panes.length < 2) return INITIAL_SPLIT_VIEW;
  const sizes =
    Array.isArray(raw.sizes) &&
    raw.sizes.length === panes.length &&
    raw.sizes.every((size) => typeof size === "number" && size > 0)
      ? (raw.sizes as number[])
      : panes.map(() => 1 / panes.length);
  return {
    ...INITIAL_SPLIT_VIEW,
    panes,
    sizes,
    focusedPaneId: panes.some((pane) => pane.id === raw.focusedPaneId)
      ? (raw.focusedPaneId as string)
      : panes[0]!.id,
    linked: raw.linked === true,
  };
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(() => INITIAL_SPLIT_VIEW, {
    name: SPLIT_VIEW_STORAGE_KEY,
    version: SPLIT_VIEW_STORAGE_VERSION,
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
    merge: (persisted, current) => ({ ...current, ...hydrateSplitView(persisted) }),
  }),
);

export function updateSplitView(update: (state: SplitViewState) => SplitViewState): void {
  useSplitViewStore.setState(update(useSplitViewStore.getState()), true);
}
