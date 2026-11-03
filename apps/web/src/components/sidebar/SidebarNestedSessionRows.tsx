import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  buildNestedSessionRows,
  type NestedSessionRow,
} from "@t3tools/client-runtime/state/conversationFolders";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { MoreHorizontalIcon } from "lucide-react";

import { useConversationFolderViewStore } from "../../conversationFolderViewStore";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";

export const isThreadRunning = (thread: EnvironmentThreadShell) =>
  thread.runtime?.activeRunId != null ||
  thread.runtime?.status === "running" ||
  thread.runtime?.status === "starting";

const threadKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

const branchLabel = (thread: EnvironmentThreadShell, expanded: boolean) =>
  `${expanded ? "Collapse" : "Expand"} nested sessions of ${thread.title}`;

const CONNECTOR_BUTTON =
  "cursor-pointer rounded-sm outline-none hover:bg-sidebar-row-hover focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

function Elbow(props: { readonly last: boolean }) {
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "absolute top-0 left-0 border-l border-sidebar-border",
          props.last ? "h-1/2" : "h-full",
        )}
      />
      <span aria-hidden className="absolute top-1/2 left-0 w-full border-t border-sidebar-border" />
    </>
  );
}

/** The inset of the row's own elbow, which the guide columns and the parent's button sit inside. */
function TreeGutter(props: {
  readonly row: NestedSessionRow<EnvironmentThreadShell>;
  readonly parentToggle: { readonly expanded: boolean; readonly onToggle: () => void } | null;
}) {
  const { row, parentToggle } = props;
  const rootInset = 0.625 + (row.depth - row.guides.length - 1) * 0.75;
  const guideColumns = row.guides.map((continues, level) => ({ level, continues }));
  return (
    <>
      <span aria-hidden className="shrink-0" style={{ width: `${rootInset}rem` }} />
      {guideColumns.map(({ level, continues }) => (
        <span
          key={level}
          aria-hidden
          className={cn("h-full w-3 shrink-0", continues && "border-l border-sidebar-border")}
        />
      ))}
      {parentToggle === null ? null : (
        <button
          type="button"
          aria-label={branchLabel(row.parent, parentToggle.expanded)}
          aria-expanded={parentToggle.expanded}
          onClick={parentToggle.onToggle}
          style={{ width: `${rootInset + row.guides.length * 0.75}rem` }}
          className={cn("absolute inset-y-0 left-0", CONNECTOR_BUTTON)}
        />
      )}
    </>
  );
}

export function NestedSessionTreeRow(props: {
  readonly row: NestedSessionRow<EnvironmentThreadShell>;
  readonly activeThreadKey: string | null;
  readonly onToggle: (key: string) => void;
  readonly onOpenThreadMenu: (
    threadRef: ScopedThreadRef,
    position: { readonly x: number; readonly y: number },
  ) => void;
}) {
  const { row, onToggle } = props;
  if (row.kind === "nested-collapsed") {
    return (
      <div data-in-folder className="relative flex h-6 min-w-0 items-center">
        <TreeGutter row={row} parentToggle={null} />
        <button
          type="button"
          aria-label={branchLabel(row.parent, false)}
          aria-expanded={false}
          aria-current={row.containsActive ? "true" : undefined}
          onClick={() => onToggle(row.branchKey)}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center pe-2 text-left text-xs text-sidebar-muted-foreground",
            CONNECTOR_BUTTON,
            row.containsActive && "bg-accent text-foreground",
          )}
        >
          <span className="relative h-full w-3 shrink-0">
            <Elbow last />
          </span>
          <span className="ps-1">...</span>
        </button>
      </div>
    );
  }

  const { thread, ownBranch } = row;
  const ref = scopeThreadRef(thread.environmentId, thread.id);
  const active = threadKeyOf(thread) === props.activeThreadKey;
  const needsInput = thread.hasPendingApprovals || thread.hasPendingUserInput;
  return (
    <div
      data-in-folder
      className="group/nested-thread relative flex h-6 min-w-0 items-center"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onOpenThreadMenu(ref, { x: event.clientX, y: event.clientY });
      }}
    >
      <TreeGutter
        row={row}
        parentToggle={
          row.firstSibling ? { expanded: true, onToggle: () => onToggle(row.branchKey) } : null
        }
      />
      {ownBranch === null ? (
        <span className="relative h-full w-3 shrink-0">
          <Elbow last={row.lastSibling} />
        </span>
      ) : (
        <button
          type="button"
          aria-label={branchLabel(thread, !ownBranch.collapsed)}
          aria-expanded={!ownBranch.collapsed}
          onClick={() => onToggle(ownBranch.key)}
          className={cn("relative h-full w-3 shrink-0", CONNECTOR_BUTTON)}
        >
          <Elbow last={row.lastSibling} />
        </button>
      )}
      <Link
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(ref)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "ms-0.5 flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md ps-1 pe-2 text-xs outline-none group-focus-within/nested-thread:pe-7 group-hover/nested-thread:pe-7 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:pe-7",
          active
            ? "bg-accent text-foreground"
            : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {needsInput ? (
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Needs input" />
        ) : isThreadRunning(thread) ? (
          <span className="size-1.5 shrink-0 rounded-full bg-success" aria-label="Running" />
        ) : null}
      </Link>
      <button
        type="button"
        aria-label={`Actions for ${thread.title}`}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          props.onOpenThreadMenu(ref, { x: rect.left, y: rect.bottom });
        }}
        className="absolute inset-y-0 right-1 my-auto flex size-5 cursor-pointer items-center justify-center rounded text-sidebar-muted-foreground opacity-0 outline-none group-focus-within/nested-thread:opacity-100 group-hover/nested-thread:opacity-100 hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:opacity-100"
      >
        <MoreHorizontalIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** A nested session's rows sit directly under the parent's, whatever folder that is in. */
export function SidebarNestedSessionRows(props: {
  readonly nested: ReadonlyMap<ThreadId, ReadonlyArray<EnvironmentThreadShell>>;
  readonly parent: EnvironmentThreadShell;
  readonly activeThreadKey: string | null;
  readonly onOpenThreadMenu: (
    threadRef: ScopedThreadRef,
    position: { readonly x: number; readonly y: number },
  ) => void;
}) {
  const collapsedKeys = useConversationFolderViewStore((state) => state.collapsedKeys);
  const toggleCollapsed = useConversationFolderViewStore((state) => state.toggleCollapsed);
  return buildNestedSessionRows({
    parent: props.parent,
    parentRowKey: threadKeyOf(props.parent),
    parentDepth: 0,
    nested: props.nested,
    threadKey: threadKeyOf,
    isActive: (thread) => threadKeyOf(thread) === props.activeThreadKey,
    isCollapsed: (key) => collapsedKeys[key] === true,
  }).map((row) => (
    <NestedSessionTreeRow
      key={row.key}
      row={row}
      activeThreadKey={props.activeThreadKey}
      onToggle={toggleCollapsed}
      onOpenThreadMenu={props.onOpenThreadMenu}
    />
  ));
}
