import { describe, expect, it } from "@effect/vitest";
import {
  type ConversationFolder,
  ConversationFolderId,
  type ConversationFolderStreamEvent,
  ProjectId,
  type ThreadCapabilityMode,
  ThreadId,
  type Workspace,
  WorkspaceId,
} from "@t3tools/contracts";

import {
  buildConversationFolderRows,
  buildConversationTreeRows,
  type ConversationFolderThread,
  conversationFolderChoices,
  conversationFolderMode,
  emptyConversationFolderState,
  reduceConversationFolderEvent,
  threadMatchesSmartFilter,
} from "./conversationFolders.ts";
import { resolveThreadWorkspace } from "./workspaces.ts";

const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const folderIdOf = ConversationFolderId.make;

const folder = (id: string, overrides: Partial<ConversationFolder> = {}): ConversationFolder => ({
  id: folderIdOf(id),
  parentId: null,
  name: id as ConversationFolder["name"],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const thread = (
  id: string,
  overrides: Partial<ConversationFolderThread> = {},
): ConversationFolderThread => ({
  id: ThreadId.make(id),
  updatedAt: "2026-10-31T00:00:00.000Z",
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  running: false,
  ...overrides,
});

const stateOf = (...events: ReadonlyArray<ConversationFolderStreamEvent>) =>
  events.reduce(reduceConversationFolderEvent, emptyConversationFolderState);

const snapshot = (
  folders: ReadonlyArray<ConversationFolder>,
  placements: Record<string, ReadonlyArray<string>> = {},
): ConversationFolderStreamEvent => ({
  type: "snapshot",
  snapshot: {
    folders,
    placements: Object.entries(placements).map(([folderId, threadIds]) => ({
      folderId: folderIdOf(folderId),
      threadIds: threadIds.map((id) => ThreadId.make(id)),
    })),
    tags: [],
  },
});

const keys = (
  input: Omit<
    Parameters<typeof buildConversationFolderRows>[0],
    "nowMs" | "isCollapsed" | "capabilityMode"
  > & {
    readonly collapsed?: ReadonlyArray<string>;
    readonly capabilityMode?: ThreadCapabilityMode;
  },
) =>
  buildConversationFolderRows({
    ...input,
    capabilityMode: input.capabilityMode ?? "code",
    nowMs: NOW,
    isCollapsed: (key) => input.collapsed?.includes(key) ?? false,
  }).map((row) => row.key);

describe("conversation folder rows", () => {
  it("nests folders, then their threads, with threads outside any folder last", () => {
    const state = stateOf(
      snapshot([folder("b"), folder("a"), folder("child", { parentId: folderIdOf("a") })], {
        a: ["t1"],
        child: ["t2"],
      }),
    );
    expect(keys({ state, threads: [thread("t1"), thread("t2"), thread("t3")] })).toStrictEqual([
      "folder:a",
      "folder:child",
      "child:t2",
      "a:t1",
      "folder:b",
      "thread:t3",
    ]);
  });

  it("drops everything under a collapsed folder and keeps its count", () => {
    const state = stateOf(snapshot([folder("a")], { a: ["t1", "t2"] }));
    const rows = buildConversationFolderRows({
      state,
      threads: [thread("t1"), thread("t2")],
      capabilityMode: "code",
      nowMs: NOW,
      isCollapsed: (key) => key === "a",
    });
    expect(rows.map((row) => row.key)).toStrictEqual(["folder:a"]);
    expect(rows[0]).toMatchObject({ count: 2, collapsed: true });
  });

  it("shows a deleted folder's threads outside any folder and puts them back on restore", () => {
    const deleted = stateOf(
      snapshot([folder("a", { deletedAt: "2026-10-30T00:00:00.000Z" })], { a: ["t1"] }),
    );
    expect(keys({ state: deleted, threads: [thread("t1")] })).toStrictEqual(["thread:t1"]);
    const restored = reduceConversationFolderEvent(deleted, {
      type: "folders-updated",
      folders: [folder("a")],
    });
    expect(keys({ state: restored, threads: [thread("t1")] })).toStrictEqual(["folder:a", "a:t1"]);
  });

  it("applies moves and unfiling as deltas", () => {
    const moved = stateOf(snapshot([folder("a"), folder("b")], { a: ["t1", "t2"] }), {
      type: "threads-moved",
      threadIds: [ThreadId.make("t1")],
      folderId: folderIdOf("b"),
    });
    expect(moved.folderByThread.get(ThreadId.make("t1"))).toBe("b");
    expect(moved.folderByThread.get(ThreadId.make("t2"))).toBe("a");
    const unfiled = reduceConversationFolderEvent(moved, {
      type: "threads-moved",
      threadIds: [ThreadId.make("t1")],
      folderId: null,
    });
    expect(unfiled.folderByThread.has(ThreadId.make("t1"))).toBe(false);
  });

  it("offers real folders by path, never smart ones or deleted ones", () => {
    const state = stateOf(
      snapshot([
        folder("Work"),
        folder("Client", { parentId: folderIdOf("Work") }),
        folder("Running", { smartFilter: { statuses: ["running"] } }),
        folder("Old", { deletedAt: "2026-10-30T00:00:00.000Z" }),
      ]),
    );
    expect(conversationFolderChoices(state, "code").map((choice) => choice.path)).toStrictEqual([
      "Work",
      "Work / Client",
    ]);
  });

  it("lets a smart folder show a thread that also lives in a real folder", () => {
    const state = stateOf(
      snapshot([folder("Real"), folder("Busy", { smartFilter: { statuses: ["running"] } })], {
        Real: ["t1"],
      }),
    );
    expect(keys({ state, threads: [thread("t1", { running: true })] })).toStrictEqual([
      "folder:Busy",
      "Busy:t1",
      "folder:Real",
      "Real:t1",
    ]);
  });

  it("shows only the folders of the requested mode and lists threads filed in the other mode outside any folder", () => {
    const state = stateOf(
      snapshot([folder("Work"), folder("Chat notes", { capabilityMode: "chat" })], {
        "Chat notes": ["t1"],
      }),
    );
    expect(keys({ state, threads: [thread("t1")], capabilityMode: "code" })).toStrictEqual([
      "folder:Work",
      "thread:t1",
    ]);
    expect(keys({ state, threads: [thread("t1")], capabilityMode: "chat" })).toStrictEqual([
      "folder:Chat notes",
      "Chat notes:t1",
    ]);
  });

  it("reads a folder without a mode as code", () => {
    const state = stateOf(snapshot([folder("Work")]));
    expect(conversationFolderMode(folder("Work"))).toBe("code");
    expect(conversationFolderMode(folder("Chat", { capabilityMode: "chat" }))).toBe("chat");
    expect(keys({ state, threads: [], capabilityMode: "chat" })).toStrictEqual([]);
  });

  it("offers the folders of one mode by path", () => {
    const state = stateOf(
      snapshot([
        folder("Work"),
        folder("Client", { parentId: folderIdOf("Work") }),
        folder("Chat notes", { capabilityMode: "chat" }),
      ]),
    );
    expect(conversationFolderChoices(state, "code").map((choice) => choice.path)).toStrictEqual([
      "Work",
      "Work / Client",
    ]);
    expect(conversationFolderChoices(state, "chat").map((choice) => choice.path)).toStrictEqual([
      "Chat notes",
    ]);
  });
});

describe("conversation tree rows", () => {
  const session = (id: string, parent?: string) => ({
    ...thread(id),
    archivedAt: null,
    lineage: {
      parentThreadId: parent === undefined ? null : ThreadId.make(parent),
      relationshipToParent: parent === undefined ? null : "fork",
      nestedSession: parent !== undefined,
    } as never,
  });
  const summarize = (
    threads: ReadonlyArray<ReturnType<typeof session>>,
    options: { readonly collapsed?: ReadonlyArray<string>; readonly active?: string } = {},
    state = emptyConversationFolderState,
  ) =>
    buildConversationTreeRows({
      state,
      threads,
      capabilityMode: "code",
      nowMs: NOW,
      isCollapsed: (key) => options.collapsed?.includes(key) ?? false,
      threadKey: (candidate) => candidate.id,
      isActive: (candidate) => candidate.id === options.active,
    }).map((row) =>
      row.kind === "nested-thread"
        ? `${row.thread.id} d${row.depth} ${row.lastSibling ? "last" : "mid"} [${row.guides}]`
        : row.kind === "nested-collapsed"
          ? `collapsed ${row.parent.id} d${row.depth} [${row.guides}] ${row.containsActive}`
          : row.key,
    );
  const family = [
    session("root"),
    session("first", "root"),
    session("grandchild", "first"),
    session("second", "root"),
  ];

  it("moves nested sessions under their parent with depth and sibling flags", () => {
    expect(summarize(family)).toEqual([
      "thread:root",
      "first d1 mid []",
      "grandchild d2 last [true]",
      "second d1 last []",
    ]);
  });

  it("nests under a parent inside a folder at the folder's depth", () => {
    const state = stateOf(snapshot([folder("a")], { a: ["root"] }));
    expect(summarize(family, {}, state)).toEqual([
      "folder:a",
      "a:root",
      "first d2 mid []",
      "grandchild d3 last [true]",
      "second d2 last []",
    ]);
  });

  it("replaces a collapsed branch with one row that reports a hidden active thread", () => {
    expect(summarize(family, { collapsed: ["nested:root"], active: "grandchild" })).toEqual([
      "thread:root",
      "collapsed root d1 [] true",
    ]);
    expect(summarize(family, { collapsed: ["nested:first"] })).toEqual([
      "thread:root",
      "first d1 mid []",
      "collapsed first d2 [true] false",
      "second d1 last []",
    ]);
  });

  it("keeps a nested session top-level when its parent is not listed or the lineage loops", () => {
    expect(summarize([session("orphan", "gone")])).toEqual(["thread:orphan"]);
    expect(summarize([session("a", "b"), session("b", "a")])).toEqual(["thread:a", "thread:b"]);
  });
});

describe("threadMatchesSmartFilter", () => {
  it.each([
    [{ statuses: ["running" as const] }, { running: true }, true],
    [{ statuses: ["running" as const] }, {}, false],
    [{ statuses: ["needs-input" as const] }, { hasPendingApprovals: true }, true],
    [{ statuses: ["needs-input" as const] }, { hasPendingUserInput: true }, true],
    [{ updatedWithinDays: 7 }, {}, true],
    [{ updatedWithinDays: 7 }, { updatedAt: "2026-10-01T00:00:00.000Z" }, false],
    [{ updatedWithinDays: 7 }, { updatedAt: "not a date" }, false],
  ])("%j with %j -> %s", (filter, overrides, expected) => {
    expect(threadMatchesSmartFilter(thread("t", overrides), filter, [], NOW)).toBe(expected);
  });

  it("filters by tag", () => {
    const filter = { tag: "billing" as never };
    expect(threadMatchesSmartFilter(thread("t"), filter, [], NOW)).toBe(false);
    expect(threadMatchesSmartFilter(thread("t"), filter, ["billing" as never], NOW)).toBe(true);
  });
});

describe("resolveThreadWorkspace", () => {
  const projectId = ProjectId.make("project");
  const parent = ThreadId.make("parent");
  const child = ThreadId.make("child");
  const workspace = (id: string, deletedAt: string | null = null) =>
    ({ id: WorkspaceId.make(id), deletedAt }) as Workspace;
  const parentOf = (id: ThreadId) => (id === child ? parent : null);

  it("prefers the thread, then the nearest parent, then the project", () => {
    const projectLink = { target: { kind: "project", projectId }, workspaceId: "p" } as const;
    const threadLink = (threadId: ThreadId, workspaceId: string) =>
      ({ target: { kind: "thread", threadId }, workspaceId }) as const;
    const resolve = (attachments: ReadonlyArray<unknown>) =>
      resolveThreadWorkspace({
        catalog: {
          workspaces: [workspace("p"), workspace("up"), workspace("own")],
          attachments: attachments as never,
        },
        threadId: child,
        projectId,
        parentOf,
      });
    expect(resolve([projectLink])).toMatchObject({ attachedTo: "project" });
    expect(resolve([projectLink, threadLink(parent, "up")])).toMatchObject({
      attachedTo: "parent",
    });
    expect(
      resolve([projectLink, threadLink(parent, "up"), threadLink(child, "own")]),
    ).toMatchObject({ attachedTo: "thread" });
    expect(resolve([])).toBeNull();
  });

  it("treats a deleted workspace as none, as the server does", () => {
    expect(
      resolveThreadWorkspace({
        catalog: {
          workspaces: [workspace("gone", "2026-10-30T00:00:00.000Z")],
          attachments: [
            {
              target: { kind: "thread", threadId: child },
              workspaceId: WorkspaceId.make("gone"),
            },
          ],
        },
        threadId: child,
        projectId,
        parentOf,
      }),
    ).toBeNull();
  });
});
