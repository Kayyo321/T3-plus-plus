import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadLineageTree } from "@t3tools/client-runtime/state/thread-relationships";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitForkIcon, HistoryIcon, Layers2Icon } from "lucide-react";
import { useState } from "react";

import { cn, newThreadId } from "~/lib/utils";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { useThreadRelationshipShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

function RowIcon(props: { readonly thread: OrchestrationV2ThreadShell }) {
  const Icon =
    props.thread.rewindBranch !== undefined
      ? HistoryIcon
      : props.thread.lineage.nestedSession === true
        ? Layers2Icon
        : GitForkIcon;
  return <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
}

/** The conversation's family as a tree, with what rewinds left behind and how to get it back. */
export function ThreadLineageTree(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const live = useThreadRelationshipShells(ref);
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedThreads =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? [];
  const threads = [...live, ...archivedThreads];
  const current = threads.find((thread) => thread.id === props.threadId);
  const navigate = useNavigate();
  const reopen = useAtomCommand(threadEnvironment.reopenRewindBranch, { reportFailure: false });
  const fork = useAtomCommand(threadEnvironment.forkFromMessage, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  if (current === undefined) return null;
  const rows = threadLineageTree(threads, current.lineage.rootThreadId);
  if (rows.length < 2) return null;

  const open = (threadId: ThreadId) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  const reopenBranch = async (thread: OrchestrationV2ThreadShell) => {
    setBusy(true);
    const result = await reopen({
      environmentId: props.environmentId,
      input: { threadId: thread.id, restoreFiles: thread.rewindBranch?.hasSnapshot === true },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not reopen this branch" });
      return;
    }
    await open(thread.id);
  };
  const forkBranch = async (thread: OrchestrationV2ThreadShell) => {
    setBusy(true);
    const targetThreadId = newThreadId();
    const result = await fork({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: thread.id,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not fork this branch" });
      return;
    }
    await open(targetThreadId);
  };

  return (
    <ThreadDetailsSection headingId="thread-details-lineage-tree-heading" title="History">
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map(({ thread, depth }) => (
          <li
            key={thread.id}
            style={{ paddingInlineStart: `${depth * 0.75}rem` }}
            className="group flex h-6 min-w-0 items-center gap-1.5 text-xs"
          >
            <RowIcon thread={thread} />
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(props.environmentId, thread.id))}
              className={cn(
                "min-w-0 flex-1 truncate hover:underline",
                thread.id === props.threadId && "font-medium",
                thread.archivedAt !== null && "text-muted-foreground",
              )}
            >
              {thread.title}
            </Link>
            {thread.rewindBranch !== undefined && thread.archivedAt !== null ? (
              <span className="hidden shrink-0 gap-1 group-focus-within:flex group-hover:flex pointer-coarse:flex">
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void reopenBranch(thread)}
                >
                  Reopen
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void forkBranch(thread)}
                >
                  Fork
                </Button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
