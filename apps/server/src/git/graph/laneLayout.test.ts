import { GIT_GRAPH_MAX_LANES } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  type LaneCommit,
  type LaneRow,
  laneColor,
  layoutLanes,
  stackAboveRow,
} from "./laneLayout.ts";

const commit = (sha: string, parents: ReadonlyArray<string> = [], tipName: string | null = null) =>
  ({ sha, parents, tipName }) satisfies LaneCommit;

const lanes = (row: LaneRow, side: "into" | "out" | "through") =>
  row[side].map(([lane]) => lane).toSorted((a, b) => a - b);

describe("layoutLanes", () => {
  it("keeps a linear history on one lane", () => {
    const { rows, state } = layoutLanes([commit("c", ["b"]), commit("b", ["a"]), commit("a")], []);
    expect(rows.map((row) => row.lane)).toEqual([0, 0, 0]);
    expect(rows[2]!.out).toEqual([]);
    expect(state).toEqual([]);
  });

  it("forks a merge's second parent to a new lane and closes it at the fork point", () => {
    const { rows } = layoutLanes(
      [
        commit("merge", ["main", "feature"], "main"),
        commit("feature", ["base"]),
        commit("main", ["base"]),
        commit("base"),
      ],
      [],
    );
    expect(rows[0]!.lane).toBe(0);
    expect(lanes(rows[0]!, "out")).toEqual([0, 1]);
    expect(rows[1]!).toMatchObject({ lane: 1 });
    expect(lanes(rows[1]!, "through")).toEqual([0]);
    expect(lanes(rows[3]!, "into")).toEqual([0, 1]);
  });

  it("gives every octopus parent its own lane and joins them all at the base", () => {
    const { rows, state } = layoutLanes(
      [
        commit("octopus", ["a", "b", "c", "d"]),
        commit("d", ["base"]),
        commit("c", ["base"]),
        commit("b", ["base"]),
        commit("a", ["base"]),
        commit("base"),
      ],
      [],
    );
    expect(lanes(rows[0]!, "out")).toEqual([0, 1, 2, 3]);
    expect(rows.slice(1, 5).map((row) => row.lane)).toEqual([3, 2, 1, 0]);
    expect(lanes(rows[5]!, "into")).toEqual([0, 1, 2, 3]);
    expect(state).toEqual([]);
  });

  it("draws criss-cross merges without losing a lane", () => {
    const { rows, state } = layoutLanes(
      [
        commit("x", ["a1", "b1"]),
        commit("y", ["b1", "a1"]),
        commit("a1", ["root"]),
        commit("b1", ["root"]),
        commit("root"),
      ],
      [],
    );
    // The second merge keeps its own lane to b1 and reaches a1 on the lane already waiting there.
    expect(lanes(rows[1]!, "out")).toEqual([0, 2]);
    expect(lanes(rows[3]!, "into")).toEqual([1, 2]);
    expect(lanes(rows[4]!, "into")).toEqual([0, 1]);
    expect(state).toEqual([]);
  });

  it("joins pages seamlessly, even mid-lane", () => {
    const history = [
      commit("tip-a", ["m"], "a"),
      commit("tip-b", ["n"], "b"),
      commit("n", ["m"]),
      commit("m", ["o", "side"]),
      commit("side", ["root"]),
      commit("o", ["root"]),
      commit("root"),
    ];
    const whole = layoutLanes(history, []);
    for (let split = 1; split < history.length; split += 1) {
      const first = layoutLanes(history.slice(0, split), []);
      const second = layoutLanes(history.slice(split), first.state);
      expect([...first.rows, ...second.rows]).toEqual(whole.rows);
    }
  });

  it("keeps a colour for a branch name across layouts and reserves the default branch's", () => {
    expect(laneColor("main")).toBe(0);
    expect(laneColor("origin/main")).toBe(0);
    expect(laneColor("feature/x")).toBe(laneColor("feature/x"));
    expect(laneColor("feature/x")).toBeGreaterThan(0);
  });

  it("folds lanes past the cap into one overflow column", () => {
    const parents = Array.from({ length: GIT_GRAPH_MAX_LANES + 6 }, (_, index) => `p${index}`);
    const { rows } = layoutLanes([commit("wide", parents), ...parents.map((p) => commit(p))], []);
    expect(rows[0]!.out.every(([lane]) => lane < GIT_GRAPH_MAX_LANES)).toBe(true);
    expect(rows[1]!.lane).toBe(0);
    expect(Math.max(...rows.map((row) => row.lane))).toBe(GIT_GRAPH_MAX_LANES);
  });
});

describe("stackAboveRow", () => {
  const tip: LaneRow = { lane: 1, color: 3, through: [[0, 0]], into: [], out: [[1, 3]] };

  it("starts the lane at the top of a stack on a branch tip", () => {
    const rows = stackAboveRow(tip, 2);
    expect(rows.map((row) => lanes(row, "into"))).toEqual([[], [1], [1]]);
    expect(rows.map((row) => lanes(row, "out"))).toEqual([[1], [1], [1]]);
    expect(rows.every((row) => row.through.length === 1)).toBe(true);
  });

  it("keeps other lanes that end at the commit running past the stack", () => {
    const fork: LaneRow = {
      lane: 0,
      color: 0,
      through: [],
      into: [
        [0, 0],
        [2, 5],
      ],
      out: [[0, 0]],
    };
    const [checkpoint, commitRow] = stackAboveRow(fork, 1);
    expect(checkpoint!.through).toEqual([[2, 5]]);
    expect(lanes(checkpoint!, "into")).toEqual([0]);
    expect(lanes(commitRow!, "into")).toEqual([0, 2]);
  });
});
