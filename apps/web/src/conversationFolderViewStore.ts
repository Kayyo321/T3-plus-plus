import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { UNFILED_FOLDER_KEY } from "@t3tools/client-runtime/state/conversationFolders";

import { resolveStorage } from "./lib/storage";

const STORE_KEY = "t3pp:conversation-folders:v1";

interface ConversationFolderViewState {
  /** The sidebar shows the folder tree instead of projects. */
  readonly foldersVisible: boolean;
  /** Per device on purpose: two screens can want different folders open. */
  readonly collapsedKeys: Readonly<Record<string, true>>;
  readonly toggleFoldersVisible: () => void;
  readonly toggleCollapsed: (key: string) => void;
}

export const useConversationFolderViewStore = create<ConversationFolderViewState>()(
  persist(
    (set) => ({
      foldersVisible: false,
      collapsedKeys: {},
      toggleFoldersVisible: () => set((state) => ({ foldersVisible: !state.foldersVisible })),
      toggleCollapsed: (key) =>
        set((state) => {
          const { [key]: collapsed, ...rest } = state.collapsedKeys;
          return { collapsedKeys: collapsed ? rest : { ...rest, [key]: true } };
        }),
    }),
    {
      name: STORE_KEY,
      storage: createJSONStorage(() => resolveStorage(globalThis.localStorage)),
      partialize: ({ foldersVisible, collapsedKeys }) => ({ foldersVisible, collapsedKeys }),
    },
  ),
);

export const conversationFolderCollapseKey = (folderId: string | null) =>
  folderId ?? UNFILED_FOLDER_KEY;
