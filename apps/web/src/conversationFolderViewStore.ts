import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { UNFILED_FOLDER_KEY } from "@t3tools/client-runtime/state/conversationFolders";

import { resolveStorage } from "./lib/storage";

const STORE_KEY = "t3pp:conversation-folders:v1";

interface ConversationFolderViewState {
  /** Per device on purpose: two screens can want different folders open. */
  readonly collapsedKeys: Readonly<Record<string, true>>;
  readonly toggleCollapsed: (key: string) => void;
}

export const useConversationFolderViewStore = create<ConversationFolderViewState>()(
  persist(
    (set) => ({
      collapsedKeys: {},
      toggleCollapsed: (key) =>
        set((state) => {
          const { [key]: collapsed, ...rest } = state.collapsedKeys;
          return { collapsedKeys: collapsed ? rest : { ...rest, [key]: true } };
        }),
    }),
    {
      name: STORE_KEY,
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: ({ collapsedKeys }) => ({ collapsedKeys }),
    },
  ),
);

export const conversationFolderCollapseKey = (folderId: string | null) =>
  folderId ?? UNFILED_FOLDER_KEY;
