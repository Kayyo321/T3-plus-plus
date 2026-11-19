import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

export type WindowSurface = "chat" | "ide";

interface IdeSurfaceState {
  readonly surface: WindowSurface;
  /** Where the orchestrator panel renders while the IDE covers the window. */
  readonly orchestratorSlot: HTMLElement | null;
  readonly setSurface: (surface: WindowSurface) => void;
  readonly toggle: () => void;
  readonly setOrchestratorSlot: (slot: HTMLElement | null) => void;
}

/** Whether the window shows the conversation or the IDE. Per device, like layouts. */
export const useIdeSurface = create<IdeSurfaceState>()(
  persist(
    (set) => ({
      surface: "chat",
      orchestratorSlot: null,
      setSurface: (surface) => set({ surface }),
      toggle: () => set((state) => ({ surface: state.surface === "ide" ? "chat" : "ide" })),
      setOrchestratorSlot: (orchestratorSlot) => set({ orchestratorSlot }),
    }),
    {
      name: "t3pp:window-surface:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ surface: state.surface }),
    },
  ),
);
