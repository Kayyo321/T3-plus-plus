import type {
  ConversationFolder,
  ConversationFolderId,
  ConversationFolderStreamEvent,
  ConversationSmartFilter,
  ConversationTag,
  ThreadCapabilityMode,
  ThreadId,
} from "@t3tools/contracts";

const DAY_MS = 86_400_000;

/** A folder without a mode is Code, as a thread without one is. */
export const conversationFolderMode = (folder: ConversationFolder): ThreadCapabilityMode =>
  folder.capabilityMode ?? "code";

/** Folder placement as a client holds it: the snapshot with every delta applied. */
export interface ConversationFolderState {
  readonly folders: ReadonlyMap<ConversationFolderId, ConversationFolder>;
  readonly folderByThread: ReadonlyMap<ThreadId, ConversationFolderId>;
  readonly tagsByThread: ReadonlyMap<ThreadId, ReadonlyArray<ConversationTag>>;
}

export const emptyConversationFolderState: ConversationFolderState = {
  folders: new Map(),
  folderByThread: new Map(),
  tagsByThread: new Map(),
};

export const reduceConversationFolderEvent = (
  state: ConversationFolderState,
  event: ConversationFolderStreamEvent,
): ConversationFolderState => {
  switch (event.type) {
    case "snapshot":
      return {
        folders: new Map(event.snapshot.folders.map((folder) => [folder.id, folder])),
        folderByThread: new Map(
          event.snapshot.placements.flatMap(({ folderId, threadIds }) =>
            threadIds.map((threadId) => [threadId, folderId] as const),
          ),
        ),
        tagsByThread: new Map(event.snapshot.tags.map(({ threadId, tags }) => [threadId, tags])),
      };
    case "folders-updated": {
      const folders = new Map(state.folders);
      for (const folder of event.folders) folders.set(folder.id, folder);
      return { ...state, folders };
    }
    case "threads-moved": {
      const folderByThread = new Map(state.folderByThread);
      for (const threadId of event.threadIds) {
        if (event.folderId === null) folderByThread.delete(threadId);
        else folderByThread.set(threadId, event.folderId);
      }
      return { ...state, folderByThread };
    }
    case "tags-updated": {
      const tagsByThread = new Map(state.tagsByThread);
      if (event.tags.length === 0) tagsByThread.delete(event.threadId);
      else tagsByThread.set(event.threadId, event.tags);
      return { ...state, tagsByThread };
    }
  }
};

/** The fields a smart folder reads. Every client's thread shell has them. */
export interface ConversationFolderThread {
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly running: boolean;
}

export const threadMatchesSmartFilter = (
  thread: ConversationFolderThread,
  filter: ConversationSmartFilter,
  tags: ReadonlyArray<ConversationTag>,
  nowMs: number,
): boolean => {
  if (filter.tag !== undefined && !tags.includes(filter.tag)) return false;
  if (filter.updatedWithinDays !== undefined) {
    const updatedMs = Date.parse(thread.updatedAt);
    if (!(nowMs - updatedMs <= filter.updatedWithinDays * DAY_MS)) return false;
  }
  if (filter.statuses === undefined || filter.statuses.length === 0) return true;
  return filter.statuses.some((status) =>
    status === "running"
      ? thread.running
      : thread.hasPendingApprovals || thread.hasPendingUserInput,
  );
};

export type ConversationFolderRow<Thread> =
  | {
      readonly kind: "folder";
      readonly key: string;
      readonly folder: ConversationFolder;
      readonly depth: number;
      readonly count: number;
      readonly collapsed: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: Thread;
      readonly depth: number;
      readonly folderId: ConversationFolderId | null;
    }
  | { readonly kind: "unfiled"; readonly key: "unfiled"; readonly count: number };

export const UNFILED_FOLDER_KEY = "unfiled";

const compareFolders = (left: ConversationFolder, right: ConversationFolder) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/**
 * Flattens the tree into the rows a virtualized list renders. Collapsed folders contribute one row
 * and no work, so a closed folder of thousands of threads costs nothing per scroll. A thread whose
 * folder was deleted is unfiled, which is what lets a restore put it straight back.
 */
export const buildConversationFolderRows = <Thread extends ConversationFolderThread>(input: {
  readonly state: ConversationFolderState;
  readonly threads: ReadonlyArray<Thread>;
  /** Only folders of this mode show. A thread filed in another mode's folder lands in Unfiled. */
  readonly capabilityMode: ThreadCapabilityMode;
  readonly isCollapsed: (key: string) => boolean;
  readonly nowMs: number;
}): ReadonlyArray<ConversationFolderRow<Thread>> => {
  const { state, threads, isCollapsed, nowMs } = input;
  const live = [...state.folders.values()].filter(
    (folder) =>
      folder.deletedAt === null && conversationFolderMode(folder) === input.capabilityMode,
  );
  const childrenByParent = new Map<ConversationFolderId | null, Array<ConversationFolder>>();
  for (const folder of live) {
    const siblings = childrenByParent.get(folder.parentId);
    if (siblings === undefined) childrenByParent.set(folder.parentId, [folder]);
    else siblings.push(folder);
  }
  const threadsByFolder = new Map<ConversationFolderId | null, Array<Thread>>();
  const liveIds = new Set(live.map((folder) => folder.id));
  for (const thread of threads) {
    const placed = state.folderByThread.get(thread.id) ?? null;
    const folderId = placed !== null && liveIds.has(placed) ? placed : null;
    const siblings = threadsByFolder.get(folderId);
    if (siblings === undefined) threadsByFolder.set(folderId, [thread]);
    else siblings.push(thread);
  }

  const threadsIn = (folder: ConversationFolder): ReadonlyArray<Thread> =>
    folder.smartFilter === undefined
      ? (threadsByFolder.get(folder.id) ?? [])
      : threads.filter((thread) =>
          threadMatchesSmartFilter(
            thread,
            folder.smartFilter!,
            state.tagsByThread.get(thread.id) ?? [],
            nowMs,
          ),
        );

  const rows: Array<ConversationFolderRow<Thread>> = [];
  const visit = (parentId: ConversationFolderId | null, depth: number) => {
    for (const folder of [...(childrenByParent.get(parentId) ?? [])].sort(compareFolders)) {
      const held = threadsIn(folder);
      const collapsed = isCollapsed(folder.id);
      rows.push({
        kind: "folder",
        key: `folder:${folder.id}`,
        folder,
        depth,
        count: held.length,
        collapsed,
      });
      if (collapsed) continue;
      visit(folder.id, depth + 1);
      for (const thread of held) {
        rows.push({
          kind: "thread",
          key: `${folder.id}:${thread.id}`,
          thread,
          depth: depth + 1,
          folderId: folder.id,
        });
      }
    }
  };
  visit(null, 0);

  const unfiled = threadsByFolder.get(null) ?? [];
  rows.push({ kind: "unfiled", key: UNFILED_FOLDER_KEY, count: unfiled.length });
  if (!isCollapsed(UNFILED_FOLDER_KEY)) {
    for (const thread of unfiled) {
      rows.push({
        kind: "thread",
        key: `unfiled:${thread.id}`,
        thread,
        depth: 1,
        folderId: null,
      });
    }
  }
  return rows;
};

/** Folders a conversation can move into, labelled by path, for a picker. */
export const conversationFolderChoices = (
  state: ConversationFolderState,
  capabilityMode: ThreadCapabilityMode,
): ReadonlyArray<{ readonly id: ConversationFolderId; readonly path: string }> => {
  const pathOf = (folder: ConversationFolder): string => {
    const parent = folder.parentId === null ? undefined : state.folders.get(folder.parentId);
    return parent === undefined ? folder.name : `${pathOf(parent)} / ${folder.name}`;
  };
  return [...state.folders.values()]
    .filter(
      (folder) =>
        folder.deletedAt === null &&
        folder.smartFilter === undefined &&
        conversationFolderMode(folder) === capabilityMode,
    )
    .map((folder) => ({ id: folder.id, path: pathOf(folder) }))
    .sort((left, right) => left.path.localeCompare(right.path));
};
