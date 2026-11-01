import { describe, expect, it } from "vite-plus/test";

import { acceptHunk, baselineBeforePatch, deriveEditReview, revertHunk } from "./agentEditReview";

const lines = (...entries: string[]) => entries.map((entry) => `${entry}\n`).join("");
const baseline = lines("one", "two", "three", "four", "five", "six", "seven", "eight");
const edited = lines("one", "TWO", "three", "four", "five", "six", "eight", "nine");

const review = (from: string, to: string) => {
  const derived = deriveEditReview("src/a.ts", from, to);
  if (derived === null) throw new Error("expected a review");
  return derived;
};

describe("deriveEditReview", () => {
  it("has nothing to review for identical contents", () => {
    expect(deriveEditReview("a.ts", baseline, baseline)).toBeNull();
  });

  it("makes each contiguous change its own hunk", () => {
    const { hunks } = review(baseline, edited);
    expect(hunks.map(({ additions, deletions }) => [additions, deletions])).toEqual([
      [1, 1],
      [0, 1],
      [1, 0],
    ]);
    expect(hunks[0]).toMatchObject({ anchorLine: 2, addedLines: [2] });
    expect(hunks[1]?.removedPreview).toEqual(["seven\n"]);
  });

  it("gives up on a file too large to diff per edit", () => {
    const huge = "x".repeat(600_000);
    expect(deriveEditReview("a.ts", huge, `${huge}y`)).toBeNull();
  });
});

describe("per-hunk decisions", () => {
  it("accepting a hunk moves only that hunk into the baseline", () => {
    const current = review(baseline, edited);
    const next = review(acceptHunk(current, 0), edited);
    expect(next.hunks).toHaveLength(2);
    expect(next.hunks[0]?.removedPreview).toEqual(["seven\n"]);
  });

  it("reverting a hunk restores only that hunk in the file", () => {
    const reverted = revertHunk(review(baseline, edited), 0);
    expect(reverted).toBe(lines("one", "two", "three", "four", "five", "six", "eight", "nine"));
    expect(review(baseline, reverted).hunks).toHaveLength(2);
  });

  it("reverts a deletion and an addition", () => {
    const current = review(baseline, edited);
    expect(revertHunk(current, 1)).toContain("seven\n");
    expect(revertHunk(current, 2)).not.toContain("nine\n");
  });

  it("settles once every hunk is decided", () => {
    let from = baseline;
    let to = edited;
    from = acceptHunk(review(from, to), 0);
    to = revertHunk(review(from, to), 0);
    from = acceptHunk(review(from, to), 0);
    expect(from).toBe(to);
  });

  it("keeps a missing final newline intact", () => {
    const reverted = revertHunk(review("a\nb", "a\nB"), 0);
    expect(reverted).toBe("a\nb");
  });
});

describe("baselineBeforePatch", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,3 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    " three",
    "@@ -6,3 +6,3 @@",
    " six",
    "-seven",
    " eight",
    "+nine",
    "",
  ].join("\n");

  it("walks a checkpoint patch back to the file before the turn", () => {
    expect(baselineBeforePatch(edited, patch, "src/a.ts")).toBe(baseline);
  });

  it("refuses a file that moved on from the patch", () => {
    expect(baselineBeforePatch(edited.replace("TWO", "2"), patch, "src/a.ts")).toBeNull();
  });

  it("finds nothing for a file the patch does not touch", () => {
    expect(baselineBeforePatch(edited, patch, "src/b.ts")).toBeNull();
  });
});
