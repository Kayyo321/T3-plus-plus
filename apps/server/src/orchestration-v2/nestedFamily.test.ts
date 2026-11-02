import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { nestedFamilyOf } from "./nestedFamily.ts";

const root = ThreadId.make("root");
const shell = (id: string, parent: ThreadId | null, nested = true) =>
  ({
    id: ThreadId.make(id),
    title: id,
    lineage: {
      parentThreadId: parent,
      relationshipToParent: parent === null ? null : "fork",
      rootThreadId: root,
      ...(nested && parent !== null ? { nestedSession: true } : {}),
    },
    activityRunStatus: null,
    status: "completed",
    archivedAt: null,
    deletedAt: null,
  }) as never;

const threads = [
  shell("root", null),
  shell("team", root),
  shell("other-team", root),
  shell("member", ThreadId.make("team")),
  shell("cousin", ThreadId.make("other-team")),
  shell("plain-fork", root, false),
];

describe("nestedFamilyOf", () => {
  it("names each relative from a member's view and leaves out plain forks", () => {
    const family = nestedFamilyOf(threads, ThreadId.make("member"));
    expect(Object.fromEntries(family.map((entry) => [entry.threadId, entry.relation]))).toEqual({
      root: "ancestor",
      team: "parent",
      "other-team": "cousin",
      member: "self",
      cousin: "cousin",
    });
  });

  it("names a team's sibling, child, and the root's descendants", () => {
    const fromTeam = nestedFamilyOf(threads, ThreadId.make("team"));
    expect(fromTeam.find((entry) => entry.threadId === "other-team")?.relation).toBe("sibling");
    expect(fromTeam.find((entry) => entry.threadId === "member")?.relation).toBe("child");
    const fromRoot = nestedFamilyOf(threads, root);
    expect(fromRoot.find((entry) => entry.threadId === "member")).toMatchObject({
      relation: "descendant",
      depth: 2,
    });
  });
});
