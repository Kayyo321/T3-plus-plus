import { createOrchestratorAgentEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestratorAgent";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { connectionAtomRuntime } from "../connection/runtime";
import { resolveStorage } from "../lib/storage";

export const orchestratorEnvironment =
  createOrchestratorAgentEnvironmentAtoms(connectionAtomRuntime);

interface OrchestratorDockState {
  readonly open: boolean;
  readonly toggle: () => void;
  readonly setOpen: (open: boolean) => void;
}

/** Closing hides the panel only: the conversation lives on the server. */
export const useOrchestratorDock = create<OrchestratorDockState>()(
  persist(
    (set) => ({
      open: false,
      toggle: () => set((state) => ({ open: !state.open })),
      setOpen: (open) => set({ open }),
    }),
    {
      name: "t3pp:orchestrator-dock:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
