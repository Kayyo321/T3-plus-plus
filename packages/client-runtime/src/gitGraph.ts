import {
  GIT_GRAPH_MAX_LANES,
  type GitGraphCommitRisk,
  type GitGraphFilter,
  type GitGraphLayout,
  type GitGraphOperation,
  type GitGraphPage,
  type GitGraphRow,
  type GitGraphSummary,
} from "@t3tools/contracts";

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

export interface GitGraphCell {
  /** Bitmask of the half-lines leaving this cell's centre. */
  readonly directions: number;
  /** Colour index of the line drawn here, or null for an empty cell. */
  readonly color: number | null;
}

export interface GitGraphCellSegment {
  readonly lane: number;
  readonly directions: number;
  readonly color: number;
}

const BOX_GLYPHS: Readonly<Record<number, string>> = {
  [UP]: "╵",
  [DOWN]: "╷",
  [LEFT]: "╴",
  [RIGHT]: "╶",
  [UP | DOWN]: "│",
  [LEFT | RIGHT]: "─",
  [DOWN | RIGHT]: "╭",
  [DOWN | LEFT]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [UP | DOWN | RIGHT]: "├",
  [UP | DOWN | LEFT]: "┤",
  [DOWN | LEFT | RIGHT]: "┬",
  [UP | LEFT | RIGHT]: "┴",
  [UP | DOWN | LEFT | RIGHT]: "┼",
};

/**
 * The half-lines of one row. Lanes never move sideways between rows, so every row joins the next
 * by construction; only lanes ending at or leaving the node run horizontally.
 */
export function gitGraphSegments(row: GitGraphRow): ReadonlyArray<GitGraphCellSegment> {
  const segments: Array<GitGraphCellSegment> = row.through.map(([lane, color]) => ({
    lane,
    directions: UP | DOWN,
    color,
  }));
  const connect = (lane: number, color: number, vertical: number) => {
    if (lane === row.lane) {
      segments.push({ lane, directions: vertical, color });
      return;
    }
    const towardNode = lane < row.lane ? RIGHT : LEFT;
    const fromNode = lane < row.lane ? LEFT : RIGHT;
    segments.push({ lane, directions: vertical | towardNode, color });
    const step = lane < row.lane ? 1 : -1;
    for (let between = lane + step; between !== row.lane; between += step) {
      segments.push({ lane: between, directions: LEFT | RIGHT, color });
    }
    segments.push({ lane: row.lane, directions: fromNode, color });
  };
  for (const [lane, color] of row.into) connect(lane, color, UP);
  for (const [lane, color] of row.out) connect(lane, color, DOWN);
  return segments;
}

export const gitGraphDirections = {
  up: (directions: number) => (directions & UP) !== 0,
  down: (directions: number) => (directions & DOWN) !== 0,
  left: (directions: number) => (directions & LEFT) !== 0,
  right: (directions: number) => (directions & RIGHT) !== 0,
};

export type GitGraphNodeShape = "commit" | "merge" | "agent" | "checkpoint" | "head";

/** Shape carries what colour alone must not: a commit reads the same to everyone. */
export function gitGraphNodeShape(row: GitGraphRow, headSha: string | null): GitGraphNodeShape {
  if (row.kind === "checkpoint") return "checkpoint";
  if (row.sha === headSha) return "head";
  if (row.agentMade) return "agent";
  return row.parents.length > 1 ? "merge" : "commit";
}

const NODE_GLYPHS: Readonly<Record<GitGraphNodeShape, string>> = {
  commit: "●",
  merge: "◉",
  agent: "◆",
  checkpoint: "◇",
  head: "◎",
};

export interface GitGraphTextRun {
  readonly text: string;
  readonly color: number | null;
}

/** One row as box-drawing text, two characters per lane, for surfaces that draw with a font. */
export function gitGraphTextRow(
  row: GitGraphRow,
  laneCount: number,
  headSha: string | null,
): ReadonlyArray<GitGraphTextRun> {
  const cells: Array<GitGraphCell> = Array.from({ length: laneCount }, () => ({
    directions: 0,
    color: null,
  }));
  for (const segment of gitGraphSegments(row)) {
    const cell = cells[segment.lane];
    if (cell === undefined) continue;
    cells[segment.lane] = {
      directions: cell.directions | segment.directions,
      color: cell.color ?? segment.color,
    };
  }
  const runs: Array<GitGraphTextRun> = [];
  cells.forEach((cell, lane) => {
    const isNode = lane === row.lane;
    const glyph = isNode
      ? NODE_GLYPHS[gitGraphNodeShape(row, headSha)]
      : (BOX_GLYPHS[cell.directions] ?? " ");
    const connector = (cell.directions & RIGHT) !== 0 ? "─" : " ";
    runs.push({ text: `${glyph}${connector}`, color: isNode ? row.color : cell.color });
  });
  return runs;
}

/** Only lanes actually drawn in `rows`, capped where the server folds the rest into one column. */
export function gitGraphLaneCount(rows: ReadonlyArray<GitGraphRow>): number {
  let widest = 0;
  for (const row of rows) {
    widest = Math.max(widest, row.lane);
    for (const [lane] of row.through) widest = Math.max(widest, lane);
    for (const [lane] of row.out) widest = Math.max(widest, lane);
  }
  return Math.min(widest, GIT_GRAPH_MAX_LANES) + 1;
}

export interface GitGraphView {
  readonly revision: string;
  readonly rows: ReadonlyArray<GitGraphRow>;
  readonly nextCursor: string | null;
  readonly layout: GitGraphLayout;
  readonly summary: GitGraphSummary | null;
}

export const gitGraphRowKey = (row: GitGraphRow) => `${row.kind}:${row.checkpointRef ?? row.sha}`;

/** A later page extends the list, unless the server restarted it because refs moved. */
export function applyGitGraphPage(
  view: GitGraphView | null,
  page: GitGraphPage,
  appending: boolean,
): GitGraphView {
  const replaces = view === null || !appending || page.reset;
  return {
    revision: page.revision,
    rows: replaces ? page.rows : [...view.rows, ...page.rows],
    nextCursor: page.nextCursor,
    layout: page.layout,
    summary: page.summary ?? view?.summary ?? null,
  };
}

/** Rows a refresh brought in, for short entry motion. Empty on the first load: nothing is new. */
export function gitGraphArrivals(
  previous: ReadonlyArray<GitGraphRow> | null,
  next: ReadonlyArray<GitGraphRow>,
): ReadonlySet<string> {
  if (previous === null || previous.length === 0) return new Set();
  const known = new Set(previous.map(gitGraphRowKey));
  return new Set(next.map(gitGraphRowKey).filter((key) => !known.has(key)));
}

/** Team builders and agent worktrees work on branches named for the role. */
export function gitGraphBranchRole(name: string): "review" | "agent" | null {
  const shortName = name.replace(/^[^/]+\/(?=(?:team|teamwork|builder|t3)\/)/u, "");
  if (/^(?:team|teamwork|builder)\//u.test(shortName)) return "review";
  return shortName.startsWith("t3/") ? "agent" : null;
}

/** `author:ada path:src/app.ts fix parser`: named filters, and the rest searches messages. */
export function parseGitGraphQuery(query: string): GitGraphFilter {
  const message: Array<string> = [];
  const filter: { author?: string; path?: string } = {};
  for (const word of query.trim().split(/\s+/u)) {
    const [, key, value] = /^(author|path):(.+)$/u.exec(word) ?? [];
    if (key === "author" || key === "path") filter[key] = value!;
    else if (word.length > 0) message.push(word);
  }
  return { ...filter, ...(message.length > 0 ? { message: message.join(" ") } : {}) };
}

export function gitGraphRiskLabels(risk: GitGraphCommitRisk): ReadonlyArray<string> {
  return risk.reasons.map((reason) =>
    reason === "sensitive-path"
      ? `Touches ${risk.sensitivePaths.length === 1 ? "a sensitive path" : "sensitive paths"}: ${risk.sensitivePaths.join(", ")}`
      : `Large: ${risk.changedFiles} files, ${risk.changedLines} lines`,
  );
}

const OPERATION_TITLES: Readonly<Record<GitGraphOperation["kind"], string>> = {
  merge: "Merge in progress",
  rebase: "Rebase in progress",
  "cherry-pick": "Copying a commit",
};

export const gitGraphOperationTitle = (operation: GitGraphOperation) =>
  OPERATION_TITLES[operation.kind];

/** The first message of a conversation opened to help with a stopped operation. */
export function gitGraphConflictPrompt(input: {
  readonly operation: GitGraphOperation;
  readonly branch: string | null;
}): string {
  const { operation, branch } = input;
  const files = operation.conflicts.map((file) => `- ${file}`).join("\n");
  return [
    `A ${operation.kind} on ${branch ?? "this checkout"} stopped on conflicts${operation.incoming ? ` (${operation.incoming})` : ""}.`,
    "",
    "Conflicted files:",
    files,
    "",
    "Resolve each one by keeping the intent of both sides, stage it, and tell me what you decided. Ask me if the two sides really disagree. Do not continue or abort the operation; I will do that.",
  ].join("\n");
}
