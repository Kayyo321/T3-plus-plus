import type { GitGraphPage, GitGraphRow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitGraphPage,
  gitGraphArrivals,
  gitGraphBranchRole,
  gitGraphConflictPrompt,
  gitGraphLaneCount,
  gitGraphNodeShape,
  gitGraphTextRow,
  parseGitGraphQuery,
} from "./gitGraph.ts";

const row = (overrides: Partial<GitGraphRow>): GitGraphRow => ({
  kind: "commit",
  sha: "a".repeat(40),
  parents: [],
  subject: "",
  authorName: "",
  authoredAt: 0,
  refs: [],
  lane: 0,
  color: 0,
  through: [],
  into: [],
  out: [],
  agentMade: false,
  conversation: null,
  checkpointRef: null,
  ...overrides,
});

const text = (input: GitGraphRow, lanes: number) =>
  gitGraphTextRow(input, lanes, null)
    .map((run) => run.text)
    .join("")
    .trimEnd();

const page = (overrides: Partial<GitGraphPage>): GitGraphPage => ({
  revision: "r1",
  rows: [],
  nextCursor: null,
  reset: false,
  layout: "graph",
  summary: null,
  ...overrides,
});

describe("gitGraphTextRow", () => {
  it("draws a lane passing a commit", () => {
    expect(
      text(
        row({
          lane: 0,
          into: [[0, 0]],
          out: [[0, 0]],
          through: [[1, 2]],
        }),
        2,
      ),
    ).toBe("● │");
  });

  it("draws a merge leaving to a new lane on the right", () => {
    expect(
      text(
        row({
          lane: 0,
          into: [[0, 0]],
          out: [
            [0, 0],
            [1, 3],
          ],
        }),
        2,
      ),
    ).toBe("●─╮");
  });

  it("crosses a lane it does not join", () => {
    expect(
      text(
        row({
          lane: 0,
          out: [
            [0, 0],
            [2, 3],
          ],
          through: [[1, 1]],
        }),
        3,
      ),
    ).toBe("●─┼─╮");
  });

  it("joins lanes arriving from the left and right at the node", () => {
    expect(
      text(
        row({
          lane: 1,
          into: [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
          out: [[1, 1]],
        }),
        3,
      ),
    ).toBe("╰─●─╯");
  });
});

describe("gitGraphNodeShape", () => {
  it("never leaves the distinction to colour", () => {
    const head = "b".repeat(40);
    expect(gitGraphNodeShape(row({ kind: "checkpoint" }), head)).toBe("checkpoint");
    expect(gitGraphNodeShape(row({ sha: head }), head)).toBe("head");
    expect(gitGraphNodeShape(row({ agentMade: true }), head)).toBe("agent");
    expect(gitGraphNodeShape(row({ parents: ["a", "b"] }), head)).toBe("merge");
    expect(gitGraphNodeShape(row({}), head)).toBe("commit");
  });
});

describe("gitGraphLaneCount", () => {
  it("counts the widest lane drawn", () => {
    expect(gitGraphLaneCount([row({ out: [[3, 0]] }), row({ lane: 1 })])).toBe(4);
    expect(gitGraphLaneCount([])).toBe(1);
  });
});

describe("applyGitGraphPage", () => {
  const first = row({ sha: "1".repeat(40) });
  const second = row({ sha: "2".repeat(40) });
  const summary = { branch: "main" } as GitGraphPage["summary"];

  it("appends pages and keeps the first page's summary", () => {
    const view = applyGitGraphPage(null, page({ rows: [first], nextCursor: "c", summary }), false);
    const next = applyGitGraphPage(view, page({ rows: [second] }), true);
    expect(next.rows).toEqual([first, second]);
    expect(next.nextCursor).toBeNull();
    expect(next.summary).toBe(summary);
  });

  it("restarts when the server reset a stale cursor", () => {
    const view = applyGitGraphPage(null, page({ rows: [first] }), false);
    const next = applyGitGraphPage(view, page({ rows: [second], reset: true, summary }), true);
    expect(next.rows).toEqual([second]);
  });
});

describe("gitGraphArrivals", () => {
  const first = row({ sha: "1".repeat(40) });
  const second = row({ sha: "2".repeat(40) });

  it("animates nothing on the first load and only new rows on a refresh", () => {
    expect(gitGraphArrivals(null, [first]).size).toBe(0);
    expect([...gitGraphArrivals([first], [second, first])]).toEqual([`commit:${second.sha}`]);
  });
});

describe("gitGraphBranchRole", () => {
  it("reads a branch's role from its name, on remotes too", () => {
    expect(gitGraphBranchRole({ kind: "branch", name: "team/parser" })).toBe("review");
    expect(gitGraphBranchRole({ kind: "remote", name: "origin/builder/lexer" })).toBe("review");
    expect(gitGraphBranchRole({ kind: "head", name: "t3/abc123" })).toBe("agent");
    expect(gitGraphBranchRole({ kind: "branch", name: "feature/team/parser" })).toBeNull();
    expect(gitGraphBranchRole({ kind: "tag", name: "team/v1" })).toBeNull();
  });
});

describe("parseGitGraphQuery", () => {
  it("separates named filters from the message search", () => {
    expect(parseGitGraphQuery("author:ada fix path:src/app.ts parser")).toEqual({
      author: "ada",
      path: "src/app.ts",
      message: "fix parser",
    });
    expect(parseGitGraphQuery("   ")).toEqual({});
  });
});

describe("gitGraphConflictPrompt", () => {
  it("attaches every conflicted file and leaves the decision to the user", () => {
    const prompt = gitGraphConflictPrompt({
      branch: "main",
      operation: {
        kind: "merge",
        incoming: "Merge branch 'feature'",
        conflicts: ["src/a.ts", "src/b.ts"],
        recoveryId: null,
      },
    });
    expect(prompt).toContain("- src/a.ts\n- src/b.ts");
    expect(prompt).toContain("Do not continue or abort");
  });
});
