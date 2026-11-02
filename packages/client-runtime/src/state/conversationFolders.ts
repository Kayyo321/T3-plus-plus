import type {
  ConversationFolder,
  ConversationFolderId,
  ConversationFolderStreamEvent,
  ConversationSmartFilter,
  ConversationTag,
  OrchestrationV2ThreadShell,
  ThreadCapabilityMode,
  ThreadId,
} from "@t3tools/contracts";

import { nestedSessionsByParent } from "./threadRelationships.ts";

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
    };

const compareFolders = (left: ConversationFolder, right: ConversationFolder) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/**
 * Flattens the tree into the rows a virtualized list renders. Collapsed folders contribute one row
 * and no work, so a closed folder of thousands of threads costs nothing per scroll. Threads outside
 * any folder follow the folders at the top level. A thread whose folder was deleted is one of them,
 * which is what lets a restore put it straight back.
 */
export const buildConversationFolderRows = <Thread extends ConversationFolderThread>(input: {
  readonly state: ConversationFolderState;
  readonly threads: ReadonlyArray<Thread>;
  /** Only folders of this mode show. A thread filed in another mode's folder shows outside any folder. */
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

  for (const thread of threadsByFolder.get(null) ?? []) {
    rows.push({ kind: "thread", key: `thread:${thread.id}`, thread, depth: 0, folderId: null });
  }
  return rows;
};

const nestedBranchKey = (threadKey: string) => `nested:${threadKey}`;

interface NestedSessionRowBase<Thread> {
  readonly key: string;
  readonly parent: Thread;
  /** Collapses the parent's branch. */
  readonly branchKey: string;
  readonly depth: number;
  /** One entry per ancestor level below the root: whether that level's vertical line continues. */
  readonly guides: ReadonlyArray<boolean>;
}

export type NestedSessionRow<Thread> =
  | (NestedSessionRowBase<Thread> & {
      readonly kind: "nested-thread";
      readonly thread: Thread;
      readonly firstSibling: boolean;
      readonly lastSibling: boolean;
      /** Null when this thread has no children of its own. */
      readonly ownBranch: { readonly key: string; readonly collapsed: boolean } | null;
    })
  | (NestedSessionRowBase<Thread> & {
      readonly kind: "nested-collapsed";
      readonly containsActive: boolean;
    });

export type ConversationTreeRow<Thread> = ConversationFolderRow<Thread> | NestedSessionRow<Thread>;

interface NestedSessionRowOptions<Thread> {
  readonly threadKey: (thread: Thread) => string;
  readonly isActive: (thread: Thread) => boolean;
  readonly isCollapsed: (key: string) => boolean;
}

/** The rows under one parent, deepest first in reading order, stopping at collapsed branches. */
export const buildNestedSessionRows = <Thread extends { readonly id: ThreadId }>(
  input: NestedSessionRowOptions<Thread> & {
    readonly parent: Thread;
    readonly parentRowKey: string;
    readonly parentDepth: number;
    readonly nested: ReadonlyMap<ThreadId, ReadonlyArray<Thread>>;
  },
): ReadonlyArray<NestedSessionRow<Thread>> => {
  const { nested, threadKey, isActive, isCollapsed } = input;
  const childrenOf = (thread: Thread) => nested.get(thread.id) ?? [];
  const branchContainsActive = (thread: Thread): boolean =>
    childrenOf(thread).some((child) => isActive(child) || branchContainsActive(child));

  const rows: Array<NestedSessionRow<Thread>> = [];
  const visit = (
    parent: Thread,
    parentRowKey: string,
    depth: number,
    guides: ReadonlyArray<boolean>,
  ) => {
    const children = childrenOf(parent);
    if (children.length === 0) return;
    const branchKey = nestedBranchKey(threadKey(parent));
    if (isCollapsed(branchKey)) {
      rows.push({
        kind: "nested-collapsed",
        key: `${parentRowKey}/collapsed`,
        parent,
        branchKey,
        depth,
        guides,
        containsActive: branchContainsActive(parent),
      });
      return;
    }
    children.forEach((thread, index) => {
      const key = `${parentRowKey}/${thread.id}`;
      const lastSibling = index === children.length - 1;
      const ownKey = nestedBranchKey(threadKey(thread));
      rows.push({
        kind: "nested-thread",
        key,
        thread,
        parent,
        branchKey,
        depth,
        guides,
        firstSibling: index === 0,
        lastSibling,
        ownBranch:
          childrenOf(thread).length === 0 ? null : { key: ownKey, collapsed: isCollapsed(ownKey) },
      });
      visit(thread, key, depth + 1, [...guides, !lastSibling]);
    });
  };
  visit(input.parent, input.parentRowKey, input.parentDepth + 1, []);
  return rows;
};

/**
 * The folder rows with nested sessions moved from the flat list to under their parents. A nested
 * session no listed root leads to (missing parent, a lineage cycle) stays a top-level row, so no
 * thread can disappear from the tree.
 */
export const buildConversationTreeRows = <
  Thread extends ConversationFolderThread & {
    readonly archivedAt: unknown;
    readonly lineage: OrchestrationV2ThreadShell["lineage"];
  },
>(
  input: Parameters<typeof buildConversationFolderRows<Thread>>[0] &
    NestedSessionRowOptions<Thread>,
): ReadonlyArray<ConversationTreeRow<Thread>> => {
  const nested = nestedSessionsByParent(input.threads);
  const childIds = new Set([...nested.values()].flat().map((thread) => thread.id));
  const reachable = new Set<ThreadId>();
  const reach = (thread: Thread) => {
    for (const child of nested.get(thread.id) ?? []) {
      reachable.add(child.id);
      reach(child);
    }
  };
  for (const thread of input.threads) if (!childIds.has(thread.id)) reach(thread);
  const reachableNested = new Map(
    [...nested].map(([parentId, children]) => [
      parentId,
      children.filter((child) => reachable.has(child.id)),
    ]),
  );
  const folderRows = buildConversationFolderRows({
    ...input,
    threads: input.threads.filter(
      (thread) => !childIds.has(thread.id) || !reachable.has(thread.id),
    ),
  });
  return folderRows.flatMap((row): ReadonlyArray<ConversationTreeRow<Thread>> =>
    row.kind === "folder"
      ? [row]
      : [
          row,
          ...buildNestedSessionRows({
            parent: row.thread,
            parentRowKey: row.key,
            parentDepth: row.depth,
            nested: reachableNested,
            threadKey: input.threadKey,
            isActive: input.isActive,
            isCollapsed: input.isCollapsed,
          }),
        ],
  );
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
