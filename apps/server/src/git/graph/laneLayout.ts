import {
  GIT_GRAPH_LANE_COLORS,
  GIT_GRAPH_MAX_LANES,
  type GitGraphLaneSegment,
} from "@t3tools/contracts";

export interface LaneCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  /** Names a lane this commit starts, so its colour survives every reload. */
  readonly tipName: string | null;
}

export interface OpenLane {
  /** The commit this lane is waiting for. */
  readonly sha: string;
  readonly color: number;
}

/** One slot per column; a closed lane leaves `null` so columns never shift between pages. */
export type LaneState = ReadonlyArray<OpenLane | null>;

export interface LaneRow {
  readonly lane: number;
  readonly color: number;
  readonly through: ReadonlyArray<GitGraphLaneSegment>;
  readonly into: ReadonlyArray<GitGraphLaneSegment>;
  readonly out: ReadonlyArray<GitGraphLaneSegment>;
}

const DEFAULT_BRANCH_NAMES = new Set(["main", "master", "trunk", "develop"]);

function hashToColor(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  // Colour 0 is the default branch's, so a feature branch never reads as trunk.
  return 1 + (Math.abs(hash) % (GIT_GRAPH_LANE_COLORS - 1));
}

export function laneColor(name: string): number {
  const shortName = name.replace(/^[^/]+\//u, "");
  return DEFAULT_BRANCH_NAMES.has(name) || DEFAULT_BRANCH_NAMES.has(shortName)
    ? 0
    : hashToColor(name);
}

const firstFreeLane = (lanes: ReadonlyArray<OpenLane | null>) => {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
};

const visible = (segments: ReadonlyArray<GitGraphLaneSegment>) =>
  segments.filter(([lane]) => lane < GIT_GRAPH_MAX_LANES);

/** Lays out commits that arrive children first. Resuming from the returned state joins pages seamlessly. */
export function layoutLanes(
  commits: ReadonlyArray<LaneCommit>,
  state: LaneState,
): { readonly rows: ReadonlyArray<LaneRow>; readonly state: LaneState } {
  const lanes: Array<OpenLane | null> = [...state];
  const rows = commits.map((commit): LaneRow => {
    const into: Array<GitGraphLaneSegment> = [];
    const through: Array<GitGraphLaneSegment> = [];
    lanes.forEach((open, index) => {
      if (open === null) return;
      (open.sha === commit.sha ? into : through).push([index, open.color]);
    });

    const arrived = into[0];
    const lane = arrived?.[0] ?? firstFreeLane(lanes);
    const color = arrived?.[1] ?? laneColor(commit.tipName ?? commit.sha);
    for (const [index] of into) lanes[index] = null;

    const out: Array<GitGraphLaneSegment> = [];
    for (const [parentIndex, parent] of commit.parents.entries()) {
      if (commit.parents.indexOf(parent) !== parentIndex) continue;
      // A branch keeps its own lane down to its first parent, however many others wait there too.
      if (parentIndex === 0) {
        lanes[lane] = { sha: parent, color };
        out.push([lane, color]);
        continue;
      }
      const existing = lanes.findIndex((open) => open?.sha === parent);
      if (existing !== -1) {
        out.push([existing, lanes[existing]!.color]);
        continue;
      }
      const next = firstFreeLane(lanes);
      const nextColor = laneColor(parent);
      lanes[next] = { sha: parent, color: nextColor };
      out.push([next, nextColor]);
    }

    return {
      lane: Math.min(lane, GIT_GRAPH_MAX_LANES),
      color,
      through: visible(through),
      into: visible(into),
      out: visible(out),
    };
  });

  while (lanes.length > 0 && lanes.at(-1) === null) lanes.pop();
  return { rows, state: lanes };
}

/**
 * Stacks a commit's checkpoints on its own lane, above it. Checkpoints hang off one parent by the
 * hundred, so giving each a real lane would push every commit off screen.
 */
export function stackAboveRow(row: LaneRow, count: number): ReadonlyArray<LaneRow> {
  if (count === 0 || row.lane >= GIT_GRAPH_MAX_LANES) return [row];
  const segment: GitGraphLaneSegment = [row.lane, row.color];
  const arrivesFromAbove = row.into.some(([lane]) => lane === row.lane);
  const otherArrivals = row.into.filter(([lane]) => lane !== row.lane);
  const stacked = Array.from({ length: count }, (_, index): LaneRow => {
    const isTop = index === 0;
    return {
      lane: row.lane,
      color: row.color,
      through: [...row.through, ...otherArrivals].toSorted((a, b) => a[0] - b[0]),
      into: isTop && !arrivesFromAbove ? [] : [segment],
      out: [segment],
    };
  });
  return [...stacked, { ...row, into: arrivesFromAbove ? row.into : [segment, ...row.into] }];
}
