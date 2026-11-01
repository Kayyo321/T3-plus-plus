import type { ProjectId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { randomUUID } from "../lib/utils";
import {
  BUILT_IN_LAYOUTS,
  DEFAULT_BUILT_IN_LAYOUT_ID,
  decodeLayoutDocument,
  isFutureLayoutDocument,
  type LayoutDocument,
} from "./layoutDocument";

const LAYOUT_STORAGE_KEY = "t3pp:layouts:v1";
const LAYOUT_STORAGE_VERSION = 1;

interface LayoutStoreData {
  readonly saved: ReadonlyArray<LayoutDocument>;
  /** Documents from a newer build, kept so a downgrade and return does not lose them. */
  readonly future: ReadonlyArray<unknown>;
  /** Null follows the built-in default. */
  readonly favoriteId: string | null;
  /** Per-project defaults, which outrank the favorite. */
  readonly projectLayoutIds: Readonly<Record<string, string>>;
}

interface LayoutStoreState extends LayoutStoreData {
  save: (document: Omit<LayoutDocument, "id">) => LayoutDocument;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  setFavorite: (id: string | null) => void;
  setProjectLayout: (projectId: ProjectId, id: string | null) => void;
  resetDefaults: () => void;
}

export function selectLayouts(state: Pick<LayoutStoreData, "saved">): LayoutDocument[] {
  return [...BUILT_IN_LAYOUTS, ...state.saved];
}

function isBuiltInLayout(id: string): boolean {
  return BUILT_IN_LAYOUTS.some((layout) => layout.id === id);
}

/** Finds a layout by id, or by name so an agent's directive can say "review". */
export function findLayout(
  state: Pick<LayoutStoreData, "saved">,
  idOrName: string,
): LayoutDocument | null {
  const layouts = selectLayouts(state);
  const name = idOrName.trim().toLowerCase();
  return (
    layouts.find((layout) => layout.id === idOrName) ??
    layouts.find((layout) => layout.name.toLowerCase() === name) ??
    null
  );
}

/** The layout a new conversation opens in: project override, then favorite, then the default. */
export function resolveDefaultLayout(
  state: Pick<LayoutStoreData, "saved" | "favoriteId" | "projectLayoutIds">,
  projectId: ProjectId | null,
): LayoutDocument {
  const overrideId = projectId === null ? undefined : state.projectLayoutIds[projectId];
  const override = overrideId === undefined ? null : findLayout(state, overrideId);
  const favorite = state.favoriteId === null ? null : findLayout(state, state.favoriteId);
  return override ?? favorite ?? findLayout(state, DEFAULT_BUILT_IN_LAYOUT_ID)!;
}

export function hydrateLayoutState(persisted: unknown): LayoutStoreData {
  const raw = typeof persisted === "object" && persisted !== null ? persisted : {};
  const documents = [
    ...("saved" in raw && Array.isArray(raw.saved) ? (raw.saved as unknown[]) : []),
    ...("future" in raw && Array.isArray(raw.future) ? (raw.future as unknown[]) : []),
  ];
  const projectLayoutIds =
    "projectLayoutIds" in raw &&
    typeof raw.projectLayoutIds === "object" &&
    raw.projectLayoutIds !== null
      ? Object.fromEntries(
          Object.entries(raw.projectLayoutIds).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  return {
    saved: documents.flatMap((document) => {
      const decoded = decodeLayoutDocument(document);
      return decoded !== null && !isBuiltInLayout(decoded.id) ? [decoded] : [];
    }),
    future: documents.filter(isFutureLayoutDocument),
    favoriteId: "favoriteId" in raw && typeof raw.favoriteId === "string" ? raw.favoriteId : null,
    projectLayoutIds,
  };
}

export const useLayoutStore = create<LayoutStoreState>()(
  persist(
    (set) => ({
      saved: [],
      future: [],
      favoriteId: null,
      projectLayoutIds: {},
      save: (document) => {
        const created: LayoutDocument = { ...document, id: randomUUID() };
        set((state) => ({ saved: [...state.saved, created] }));
        return created;
      },
      rename: (id, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => ({
          saved: state.saved.map((layout) =>
            layout.id === id ? { ...layout, name: trimmed } : layout,
          ),
        }));
      },
      remove: (id) =>
        set((state) => ({
          saved: state.saved.filter((layout) => layout.id !== id),
          favoriteId: state.favoriteId === id ? null : state.favoriteId,
          projectLayoutIds: Object.fromEntries(
            Object.entries(state.projectLayoutIds).filter(([, layoutId]) => layoutId !== id),
          ),
        })),
      setFavorite: (id) => set({ favoriteId: id }),
      setProjectLayout: (projectId, id) =>
        set((state) => {
          const { [projectId]: _previous, ...rest } = state.projectLayoutIds;
          return { projectLayoutIds: id === null ? rest : { ...rest, [projectId]: id } };
        }),
      resetDefaults: () => set({ favoriteId: null, projectLayoutIds: {} }),
    }),
    {
      name: LAYOUT_STORAGE_KEY,
      version: LAYOUT_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        saved: state.saved,
        future: state.future,
        favoriteId: state.favoriteId,
        projectLayoutIds: state.projectLayoutIds,
      }),
      merge: (persisted, current) => ({ ...current, ...hydrateLayoutState(persisted) }),
    },
  ),
);
