import {
  gitGraphBranchRole,
  gitGraphDirections,
  gitGraphNodeShape,
  type GitGraphNodeShape,
  gitGraphSegments,
} from "@t3tools/client-runtime/git-graph";
import type {
  GitGraphBranch,
  GitGraphCommitRisk,
  GitGraphRow,
  GitGraphRowRef,
} from "@t3tools/contracts";
import { BotIcon, MessageSquareIcon, ShieldAlertIcon } from "lucide-react";
import { memo } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { cn } from "~/lib/utils";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 12;

const laneColor = (color: number) => `var(--git-lane-${color})`;

/** The lanes this row draws in, counting those that end at its node. */
export const gitGraphRowLaneCount = (row: GitGraphRow) =>
  Math.max(row.lane, ...gitGraphSegments(row).map((segment) => segment.lane)) + 1;

/** Box-drawing lines: every stroke ends at a cell edge or centre, so rows join without gaps. */
function RowLanes(props: {
  readonly row: GitGraphRow;
  readonly laneCount: number;
  readonly shape: GitGraphNodeShape;
}) {
  const { row, laneCount, shape } = props;
  const mid = ROW_HEIGHT / 2;
  const centre = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const nodeX = centre(row.lane);
  const nodeColor = laneColor(row.color);
  return (
    <svg
      aria-hidden
      className="shrink-0"
      width={laneCount * LANE_WIDTH}
      height={ROW_HEIGHT}
      fill="none"
    >
      {gitGraphSegments(row).map((segment, index) => {
        const x = centre(segment.lane);
        const path = [
          gitGraphDirections.up(segment.directions) ? `M${x} 0V${mid}` : "",
          gitGraphDirections.down(segment.directions) ? `M${x} ${mid}V${ROW_HEIGHT}` : "",
          gitGraphDirections.left(segment.directions) ? `M${x} ${mid}H${x - LANE_WIDTH / 2}` : "",
          gitGraphDirections.right(segment.directions) ? `M${x} ${mid}H${x + LANE_WIDTH / 2}` : "",
        ].join("");
        return (
          // oxlint-disable-next-line react/no-array-index-key -- segments have no identity beyond their order in this row.
          <path key={index} d={path} stroke={laneColor(segment.color)} strokeWidth={1.5} />
        );
      })}
      <RowNode x={nodeX} y={mid} shape={shape} color={nodeColor} />
    </svg>
  );
}

function RowNode(props: {
  readonly x: number;
  readonly y: number;
  readonly shape: GitGraphNodeShape;
  readonly color: string;
}) {
  const { x, y, shape, color } = props;
  switch (shape) {
    case "head":
      return (
        <>
          <circle cx={x} cy={y} r={4.5} fill="var(--background)" stroke={color} strokeWidth={1.5} />
          <circle cx={x} cy={y} r={2} fill={color} />
        </>
      );
    case "agent":
      return (
        <path
          d={`M${x} ${y - 4.5}L${x + 4.5} ${y}L${x} ${y + 4.5}L${x - 4.5} ${y}Z`}
          fill={color}
        />
      );
    case "checkpoint":
      return (
        <path
          d={`M${x} ${y - 4}L${x + 4} ${y}L${x} ${y + 4}L${x - 4} ${y}Z`}
          fill="var(--background)"
          stroke={color}
          strokeWidth={1.25}
        />
      );
    case "merge":
      return (
        <rect x={x - 3.5} y={y - 3.5} width={7} height={7} fill={color} stroke="none" rx={1} />
      );
    case "commit":
      return <circle cx={x} cy={y} r={3.5} fill={color} />;
  }
}

const REF_PREFIX: Readonly<Record<GitGraphRowRef["kind"], string>> = {
  head: "●",
  branch: "",
  remote: "⇅",
  tag: "#",
};

function RowRef(props: {
  readonly gitRef: GitGraphRowRef;
  readonly color: number;
  readonly tracking: GitGraphBranch | undefined;
}) {
  const { gitRef, color, tracking } = props;
  const role = gitGraphBranchRole(gitRef);
  const drifted = tracking !== undefined && (tracking.ahead > 0 || tracking.behind > 0);
  return (
    <span
      className="inline-flex max-w-32 shrink-0 items-center gap-1 truncate border-s-2 ps-1 font-mono text-3xs leading-4 text-foreground"
      style={{ borderInlineStartColor: laneColor(color) }}
      aria-label={gitRef.kind === "head" ? `${gitRef.name}, checked out` : gitRef.name}
    >
      {REF_PREFIX[gitRef.kind] ? <span aria-hidden>{REF_PREFIX[gitRef.kind]}</span> : null}
      <span className="truncate">{gitRef.name}</span>
      {role === null ? null : <span className="text-muted-foreground">{role}</span>}
      {drifted ? (
        <span className="text-muted-foreground">
          ↑{tracking.ahead} ↓{tracking.behind}
        </span>
      ) : null}
    </span>
  );
}

const SHAPE_LABELS: Readonly<Record<GitGraphNodeShape, string>> = {
  commit: "Commit",
  merge: "Merge",
  agent: "Agent commit",
  checkpoint: "Checkpoint",
  head: "Checked out",
};

export const GitGraphRowView = memo(function GitGraphRowView(props: {
  readonly row: GitGraphRow;
  readonly laneCount: number;
  readonly headSha: string | null;
  readonly selected: boolean;
  readonly arrived: boolean;
  readonly rewound: boolean;
  readonly worktree: string | null;
  readonly risk: GitGraphCommitRisk | undefined;
  readonly branches: ReadonlyMap<string, GitGraphBranch>;
  readonly onSelect: (row: GitGraphRow) => void;
  readonly hideTime?: boolean;
}) {
  const {
    row,
    laneCount,
    headSha,
    selected,
    arrived,
    rewound,
    worktree,
    risk,
    branches,
    onSelect,
    hideTime = false,
  } = props;
  const shape = gitGraphNodeShape(row, headSha);
  return (
    <button
      type="button"
      aria-label={`${SHAPE_LABELS[shape]}: ${row.subject}`}
      aria-pressed={selected}
      onClick={() => onSelect(row)}
      className={cn(
        "flex h-7 w-full items-center gap-2 pe-2 text-left text-xs hover:bg-accent/60",
        selected && "bg-accent",
        arrived && "motion-safe:animate-git-graph-row-enter",
        rewound && shape === "head" && "motion-safe:animate-git-graph-head-rewind",
      )}
    >
      <RowLanes row={row} laneCount={laneCount} shape={shape} />
      {row.refs.map((gitRef) => (
        <RowRef
          key={`${gitRef.kind}:${gitRef.name}`}
          gitRef={gitRef}
          color={row.color}
          tracking={gitRef.kind === "remote" ? undefined : branches.get(gitRef.name)}
        />
      ))}
      {worktree === null ? null : (
        <span
          className="shrink-0 border border-dashed border-border px-1 font-mono text-3xs leading-4 text-muted-foreground"
          aria-label={`Checked out in ${worktree}`}
        >
          worktree
        </span>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          row.kind === "checkpoint" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {row.subject}
      </span>
      {risk === undefined ? null : (
        <Tooltip>
          <TooltipTrigger render={<ShieldAlertIcon className="size-3 shrink-0 text-warning" />} />
          <TooltipPopup>Check this before you push</TooltipPopup>
        </Tooltip>
      )}
      {row.conversation !== null ? (
        <MessageSquareIcon aria-label="From a conversation" className="size-3 shrink-0" />
      ) : row.agentMade ? (
        <BotIcon aria-label="Agent commit" className="size-3 shrink-0 text-muted-foreground" />
      ) : null}
      {hideTime ? null : (
        <span className="w-14 shrink-0 truncate text-right font-mono text-3xs text-muted-foreground">
          <RelativeTime timestamp={new Date(row.authoredAt * 1000).toISOString()} />
        </span>
      )}
    </button>
  );
});
