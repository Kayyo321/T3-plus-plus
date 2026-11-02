import { gitGraphRowKey } from "@t3tools/client-runtime/git-graph";
import type { EnvironmentId, GitGraphBranch, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, GitGraphIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

import { AsciiFieldBlur } from "../ascii/AsciiFieldBlur";
import type { AsciiShaderEngine } from "../ascii/asciiShaderEngine";
import { THREAD_DETAILS_BRANCH_VIEW_MIN_HEIGHT } from "../chat/threadDetailsCardLayout";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { gitGraphRowLaneCount, GitGraphRowView, ROW_HEIGHT } from "./GitGraphRows";
import { useGitGraph } from "./useGitGraph";

const BRANCH_VIEW_OPEN_KEY = "t3code:thread-details:branch-view-open";
const BRANCH_VIEW_ROWS = 50;
/** The popover sizes to its content, so it has no spare room to fill. */
const POPOVER_LIST_HEIGHT = 8 * ROW_HEIGHT;
const NO_BRANCHES: ReadonlyMap<string, GitGraphBranch> = new Map();

/** A minimizable tree under Changes. While the landing shader lives, the tree sits on its blur. */
export function ThreadBranchView(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly landingShader: AsciiShaderEngine | null;
  readonly onOpenGraph?: () => void;
}) {
  const { landingShader } = props;
  const [open, setOpen] = useLocalStorage(BRANCH_VIEW_OPEN_KEY, true, Schema.Boolean);
  const graph = useGitGraph({
    environmentId: props.environmentId,
    cwd: props.cwd,
    threadId: props.threadId,
    visible: true,
    limit: BRANCH_VIEW_ROWS,
  });
  const rows = graph.view?.rows ?? [];
  const headSha = graph.view?.summary?.headSha ?? null;
  const foldRef = useRef<HTMLDivElement>(null);
  const [listHeight, setListHeight] = useState(POPOVER_LIST_HEIGHT);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the room left in the card exists only in the laid-out DOM
  useLayoutEffect(() => {
    const fold = foldRef.current;
    const viewport = fold?.closest('[data-slot="scroll-area-viewport"]');
    const content = viewport?.firstElementChild;
    if (!fold || !viewport || !content) return;
    if (fold.closest('[data-thread-details-panel="inline"]') === null) return;
    const measure = () => {
      const others = content.getBoundingClientRect().height - fold.getBoundingClientRect().height;
      setListHeight(
        Math.max(THREAD_DETAILS_BRANCH_VIEW_MIN_HEIGHT, Math.floor(viewport.clientHeight - others)),
      );
    };
    measure();
    const stopViewport = observeResize(viewport, measure);
    const stopContent = observeResize(content, measure);
    return () => {
      stopViewport();
      stopContent();
    };
  }, []);

  return (
    <div className="flex flex-col">
      <ThreadDetailsControl
        size="xs"
        variant="ghost"
        part="row"
        panel
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <GitGraphIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={cn("flex-1 text-left", THREAD_DETAILS_PANEL_LABEL_CLASS)}>
          Branch view
        </span>
        <ChevronDownIcon
          className={cn(
            THREAD_DETAILS_PANEL_CHEVRON_CLASS,
            "transition-transform duration-200 motion-reduce:transition-none",
            !open && "-rotate-90",
          )}
          aria-hidden
        />
      </ThreadDetailsControl>

      {/* The rows stay put and the bottom edge travels, so it folds up into the row above. */}
      <div
        ref={foldRef}
        data-thread-details-branch-view
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        {/* Cancels the section's padding, so the blur runs to the card's edges. */}
        <div className="relative -mx-2 min-h-0 overflow-hidden px-2" inert={!open}>
          {landingShader !== null ? <AsciiFieldBlur shader={landingShader} /> : null}
          {graph.error !== null && rows.length === 0 ? (
            <p className="relative px-2.5 py-1 text-xs text-muted-foreground">
              Couldn't load branches.
            </p>
          ) : (
            <div className="relative ms-3 overflow-hidden">
              <div
                className="overflow-x-hidden overflow-y-auto overscroll-contain"
                style={{ maxHeight: listHeight }}
              >
                {rows.map((row) => (
                  <GitGraphRowView
                    key={gitGraphRowKey(row)}
                    row={row}
                    // Text starts after each row's own lanes, or one side branch squeezes every row.
                    laneCount={gitGraphRowLaneCount(row)}
                    headSha={headSha}
                    selected={false}
                    arrived={graph.arrivals.has(gitGraphRowKey(row))}
                    rewound={false}
                    worktree={null}
                    risk={undefined}
                    branches={NO_BRANCHES}
                    onSelect={() => props.onOpenGraph?.()}
                    hideTime
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
