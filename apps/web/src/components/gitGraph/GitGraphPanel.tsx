import { LegendList } from "@legendapp/list/react";
import {
  gitGraphConflictPrompt,
  gitGraphLaneCount,
  gitGraphOperationTitle,
  gitGraphRowKey,
} from "@t3tools/client-runtime/git-graph";
import type {
  EnvironmentId,
  GitGraphAction,
  GitGraphActionResult,
  GitGraphConversationMark,
  GitGraphPreview,
  GitGraphRow,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  DiamondIcon,
  LifeBuoyIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useState } from "react";

import { RelativeTime } from "~/components/RelativeTime";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";

import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle-group";
import { GitGraphChangesView } from "./GitGraphChangesView";
import { GitGraphDetail } from "./GitGraphDetail";
import { GitGraphPreviewDialog } from "./GitGraphPreviewDialog";
import { GitGraphRowView, LANE_WIDTH, ROW_HEIGHT } from "./GitGraphRows";
import { commandError, useGitGraph } from "./useGitGraph";

const CONFIRM_LABELS: Partial<Record<GitGraphAction["type"], string>> = {
  rollback: "Go back",
  rollbackToCheckpoint: "Put my files back",
  merge: "Merge",
  rebase: "Rebase",
  cherryPick: "Copy commit",
  branchDelete: "Delete branch",
  stashDrop: "Drop stash",
  recoveryRestore: "Go back",
  operationAbort: "Abort",
};

const needsPreview = (action: GitGraphAction) => action.type in CONFIRM_LABELS;

interface PendingPreview {
  readonly action: GitGraphAction;
  readonly preview: GitGraphPreview;
}

export default function GitGraphPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly projectRef: ScopedProjectRef | null;
  readonly threadWorktreePath: string | null;
  readonly visible: boolean;
}) {
  const { environmentId, cwd, threadRef, projectRef, threadWorktreePath, visible } = props;
  const graph = useGitGraph({ environmentId, cwd, threadId: threadRef.threadId, visible });
  const { view, filters, setFilters } = graph;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const [tab, setTab] = useState<"graph" | "changes">("graph");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingPreview | null>(null);
  const [acting, setActing] = useState(false);

  const summary = view?.summary ?? null;
  const rows = view?.rows ?? [];
  const readOnly = summary?.readOnlyReason != null;
  const laneCount = view?.layout === "flat" ? 1 : gitGraphLaneCount(rows);
  const selected = rows.find((row) => gitGraphRowKey(row) === selectedKey) ?? null;
  const operation = summary?.operation ?? null;

  const worktreeByCommit = new Map(
    (summary?.worktrees ?? [])
      .filter((worktree) => !worktree.isCurrent && worktree.sha !== null)
      .map((worktree) => [worktree.sha!, worktree.path] as const),
  );
  const riskByCommit = new Map((summary?.risks ?? []).map((risk) => [risk.sha, risk] as const));

  const reportResult = (result: GitGraphActionResult) => {
    const recovery = result.recovery;
    const id = toastManager.add({
      type: result.outcome === "conflicts" ? "warning" : "success",
      title: result.message,
      ...(recovery === null
        ? {}
        : {
            actionProps: {
              children: "Go back",
              onClick: () => {
                toastManager.close(id);
                void requestAction({ type: "recoveryRestore", id: recovery.id });
              },
            },
          }),
    });
  };

  const perform = async (action: GitGraphAction) => {
    setActing(true);
    const outcome = await graph.run(action);
    setActing(false);
    if (outcome.ok) {
      reportResult(outcome.result);
    } else {
      toastManager.add({ type: "error", title: "Git action failed", description: outcome.error });
    }
    return outcome.ok;
  };

  const requestAction = async (action: GitGraphAction) => {
    if (!needsPreview(action)) {
      await perform(action);
      return;
    }
    const result = await graph.preview(action);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not preview this",
        description: commandError(result),
      });
      return;
    }
    setPending({ action, preview: result.value });
  };

  const confirmPending = async () => {
    if (pending === null) return;
    const { action, preview } = pending;
    const acknowledged =
      action.type === "branchDelete" && preview.requiresAcknowledgement
        ? { ...action, acknowledgeUnmerged: true }
        : action;
    await perform(acknowledged);
    setPending(null);
  };

  const openConversation = (mark: GitGraphConversationMark | null) => {
    if (mark === null) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, mark.threadId)),
    });
  };

  const askAgent = () => {
    if (operation === null || projectRef === null) return;
    void handleNewThread(projectRef, {
      branch: summary?.branch ?? null,
      worktreePath: threadWorktreePath,
      envMode: threadWorktreePath === null ? "local" : "worktree",
      prompt: gitGraphConflictPrompt({ operation, branch: summary?.branch ?? null }),
    });
  };

  const renderRow = ({ item }: { readonly item: GitGraphRow }) => {
    const key = gitGraphRowKey(item);
    return (
      <GitGraphRowView
        row={item}
        laneCount={laneCount}
        headSha={summary?.headSha ?? null}
        selected={key === selectedKey}
        arrived={graph.arrivals.has(key)}
        rewound={graph.rewound}
        worktree={worktreeByCommit.get(item.sha) ?? null}
        risk={riskByCommit.get(item.sha)}
        onSelect={(row) => {
          const next = gitGraphRowKey(row);
          setSelectedKey((current) => (current === next ? null : next));
        }}
      />
    );
  };

  const recoveries = summary?.recoveries ?? [];
  const stashes = summary?.stashes ?? [];
  const canSync = !readOnly && !acting;

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 truncate font-mono text-xs">
          {summary?.branch ?? (summary?.headSha ? summary.headSha.slice(0, 7) : "")}
        </span>
        {summary && (summary.ahead > 0 || summary.behind > 0) ? (
          <span className="shrink-0 font-mono text-3xs text-muted-foreground">
            ↑{summary.ahead} ↓{summary.behind}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Fetch"
          title="Fetch"
          disabled={!canSync}
          onClick={() => void perform({ type: "fetch" })}
        >
          <RefreshCwIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Pull"
          title="Pull"
          disabled={!canSync || summary?.upstream == null}
          onClick={() => void perform({ type: "pull" })}
        >
          <ArrowDownIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Push"
          title={
            riskByCommit.size > 0
              ? `Push. ${riskByCommit.size} unpushed ${riskByCommit.size === 1 ? "commit needs" : "commits need"} a look first.`
              : "Push"
          }
          disabled={!canSync || summary?.branch == null}
          onClick={() => void perform({ type: "push" })}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Create pull request"
          title="Create pull request"
          disabled={!canSync || summary?.branch == null}
          onClick={() => void perform({ type: "createPullRequest" })}
        >
          <PullRequestGlyph.pullRequest />
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Stashes and recovery points, ${stashes.length + recoveries.length}`}
                title="Stashes and recovery points"
              />
            }
          >
            <LifeBuoyIcon />
          </MenuTrigger>
          <MenuPopup align="end" className="max-w-96">
            <MenuGroupLabel>Recovery points</MenuGroupLabel>
            {recoveries.length === 0 ? <MenuItem disabled>Nothing to go back to</MenuItem> : null}
            {recoveries.slice(0, 12).map((recovery) => (
              <MenuItem
                key={recovery.id}
                disabled={readOnly}
                onClick={() => void requestAction({ type: "recoveryRestore", id: recovery.id })}
              >
                <span className="min-w-0 flex-1 truncate">{recovery.label}</span>
                <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                  <RelativeTime timestamp={new Date(recovery.createdAt * 1000).toISOString()} />
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuGroupLabel>Stashes</MenuGroupLabel>
            <MenuItem
              disabled={readOnly || (summary?.changedFiles ?? 0) === 0}
              onClick={() => void perform({ type: "stashPush", includeUntracked: true })}
            >
              Stash my changes
            </MenuItem>
            {stashes.slice(0, 12).flatMap((stash) => [
              <MenuItem
                key={`apply:${stash.sha}`}
                disabled={readOnly}
                onClick={() => void perform({ type: "stashApply", sha: stash.sha })}
              >
                <span className="min-w-0 flex-1 truncate">Apply: {stash.message}</span>
              </MenuItem>,
              <MenuItem
                key={`drop:${stash.sha}`}
                variant="destructive"
                disabled={readOnly}
                onClick={() => void requestAction({ type: "stashDrop", sha: stash.sha })}
              >
                <span className="min-w-0 flex-1 truncate">Drop: {stash.message}</span>
              </MenuItem>,
            ])}
          </MenuPopup>
        </Menu>
      </header>

      {summary?.readOnlyReason ? (
        <p className="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground">
          {summary.readOnlyReason}
        </p>
      ) : null}

      {operation === null ? null : (
        <div className="flex shrink-0 flex-col gap-1 border-b border-border bg-warning/8 px-2 py-1 text-xs">
          <p className="font-medium">
            {gitGraphOperationTitle(operation)}
            {operation.conflicts.length > 0
              ? `: ${operation.conflicts.length === 1 ? "1 conflict" : `${operation.conflicts.length} conflicts`}`
              : ""}
          </p>
          <ul className="max-h-20 overflow-y-auto font-mono text-2xs">
            {operation.conflicts.map((file) => (
              <li key={file} className="truncate">
                {file}
              </li>
            ))}
          </ul>
          <div className="flex gap-1">
            <Button
              size="compact"
              variant="ghost"
              disabled={acting || operation.conflicts.length > 0}
              onClick={() => void perform({ type: "operationContinue" })}
            >
              Continue
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={acting}
              onClick={() => void requestAction({ type: "operationAbort" })}
            >
              Abort
            </Button>
            {operation.conflicts.length > 0 && projectRef !== null ? (
              <Button size="compact" variant="ghost" onClick={askAgent}>
                <BotIcon />
                Ask an agent
              </Button>
            ) : null}
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <Button
          size="compact"
          variant={tab === "graph" ? "secondary" : "ghost"}
          onClick={() => setTab("graph")}
        >
          Graph
        </Button>
        <Button
          size="compact"
          variant={tab === "changes" ? "secondary" : "ghost"}
          disabled={readOnly}
          onClick={() => setTab("changes")}
        >
          Changes{summary && summary.changedFiles > 0 ? ` ${summary.changedFiles}` : ""}
        </Button>
        {tab === "graph" ? (
          <>
            <Input
              size="sm"
              className="min-w-0 flex-1"
              aria-label="Search history"
              placeholder="Search, author:ada, path:src"
              value={filters.query}
              onChange={(event) => setFilters({ ...filters, query: event.target.value })}
            />
            <Menu>
              <MenuTrigger
                render={
                  <Button size="compact" variant="ghost">
                    <ChevronDownIcon />
                  </Button>
                }
              />
              <MenuPopup align="end">
                <MenuItem
                  onClick={() => setFilters({ ...filters, agentOnly: !filters.agentOnly })}
                  closeOnClick={false}
                >
                  {filters.agentOnly ? "✓ " : ""}Agent-made only
                </MenuItem>
                <MenuItem
                  onClick={() =>
                    setFilters({ ...filters, thisConversation: !filters.thisConversation })
                  }
                  closeOnClick={false}
                >
                  {filters.thisConversation ? "✓ " : ""}This conversation only
                </MenuItem>
              </MenuPopup>
            </Menu>
            <Toggle
              size="sm"
              aria-label="Show checkpoints"
              title="Show this conversation's checkpoints"
              pressed={filters.showCheckpoints}
              onPressedChange={(showCheckpoints) => setFilters({ ...filters, showCheckpoints })}
            >
              <DiamondIcon className="size-3" />
            </Toggle>
          </>
        ) : null}
        {graph.loading ? <Spinner className="size-3 shrink-0" /> : null}
      </div>

      {tab === "changes" ? (
        <GitGraphChangesView
          environmentId={environmentId}
          cwd={cwd}
          threadId={threadRef.threadId}
          run={perform}
        />
      ) : (
        <>
          {graph.error === null ? null : (
            <p className="shrink-0 px-2 py-1 text-xs text-destructive-foreground">{graph.error}</p>
          )}
          <div
            className={cn("min-h-0 flex-1", view === null && "flex items-center justify-center")}
            onAnimationEnd={() => graph.clearMotion()}
          >
            {view === null ? (
              graph.error === null ? (
                <Spinner />
              ) : null
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 p-4 text-xs text-muted-foreground">
                <p>{view.nextCursor === null ? "Nothing to show." : "Nothing in this stretch."}</p>
                {view.nextCursor === null ? null : (
                  <Button
                    size="compact"
                    variant="ghost"
                    disabled={graph.loading}
                    onClick={() => void graph.loadMore()}
                  >
                    Keep looking
                  </Button>
                )}
              </div>
            ) : (
              <LegendList<GitGraphRow>
                data={rows}
                keyExtractor={gitGraphRowKey}
                renderItem={renderRow}
                estimatedItemSize={ROW_HEIGHT}
                drawDistance={ROW_HEIGHT * 20}
                onEndReachedThreshold={0.6}
                onEndReached={() => void graph.loadMore()}
                className="size-full"
                style={{ minWidth: laneCount * LANE_WIDTH }}
              />
            )}
          </div>
          {selected === null ? null : (
            <GitGraphDetail
              environmentId={environmentId}
              cwd={cwd}
              row={selected}
              summary={summary}
              readOnly={readOnly}
              onAction={(action) => void requestAction(action)}
              onOpenConversation={openConversation}
              onClose={() => setSelectedKey(null)}
            />
          )}
        </>
      )}

      {pending === null ? null : (
        <GitGraphPreviewDialog
          preview={pending.preview}
          confirmLabel={CONFIRM_LABELS[pending.action.type] ?? "Continue"}
          pending={acting}
          onCancel={() => setPending(null)}
          onConfirm={() => void confirmPending()}
        />
      )}
    </div>
  );
}
