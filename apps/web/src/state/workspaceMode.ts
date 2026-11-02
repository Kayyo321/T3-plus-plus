import type { ThreadCapabilityMode } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

interface WorkspaceModeState {
  readonly mode: ThreadCapabilityMode;
  readonly setMode: (mode: ThreadCapabilityMode) => void;
}

/** Which half of the app the sidebar shows. The open conversation decides it when there is one. */
export const useWorkspaceMode = create<WorkspaceModeState>()(
  persist(
    (set) => ({
      mode: "code",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: "t3pp:workspace-mode:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);

type ChatThreadStarter = () => Promise<boolean>;

let chatThreadStarter: ChatThreadStarter | null = null;

/** Scratch needs live environments, so the mounted app lends its starter to non-React callers. */
export function registerChatThreadStarter(starter: ChatThreadStarter): () => void {
  chatThreadStarter = starter;
  return () => {
    if (chatThreadStarter === starter) chatThreadStarter = null;
  };
}

/** Starts a Chat conversation when Chat is the open half. Null means the caller should go on. */
export function startThreadInWorkspaceMode(): Promise<boolean> | null {
  if (useWorkspaceMode.getState().mode !== "chat" || chatThreadStarter === null) return null;
  return chatThreadStarter();
}
