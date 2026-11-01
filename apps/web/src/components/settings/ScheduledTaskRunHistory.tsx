import {
  SCHEDULED_RUN_TRIGGER_LABELS,
  scheduledRunDetails,
  scheduledRunOutcome,
  withLatestScheduledRun,
  type ScheduledRunTone,
} from "@t3tools/client-runtime/scheduled-task-policy";
import type { EnvironmentId, ScheduledTask, ScheduledTaskRun } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTime } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { formatScheduleTime } from "./scheduledTasksSettings.logic";

/** formatRelativeTime handles only the past; upcoming runs need future labels. */
function relativeLabel(value: string | null, nowMs: number): string {
  if (!value) return "Not scheduled";
  const diffMs = new Date(value).getTime() - nowMs;
  if (diffMs <= 0) {
    const relative = formatRelativeTime(value, nowMs);
    if (!relative) return "Not scheduled";
    return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
  }
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 2) return "in under a minute";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// Use the label's minute tick because the compiler caches render-time Date.now() on the timestamp.
export function ScheduledRelativeLabel(props: { value: string | null }) {
  const nowMinute = useNowMinute();
  return relativeLabel(props.value, Date.parse(`${nowMinute}:00.000Z`));
}

const TONE_VARIANTS = {
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
  neutral: "outline",
} as const satisfies Record<ScheduledRunTone, string>;

function ScheduledRunOutcomeBadge({ outcome }: { readonly outcome: string }) {
  const { label, tone } = scheduledRunOutcome(outcome);
  return <Badge variant={TONE_VARIANTS[tone]}>{label}</Badge>;
}

function ScheduledRunConversationLink({
  environmentId,
  run,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: ScheduledTaskRun;
  readonly onNavigate?: () => void;
}) {
  if (run.threadId === null) return null;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: run.threadId }}
      className="underline underline-offset-2"
      {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
    >
      {run.outcome === "needs_input" ? "Answer" : "Open conversation"}
    </Link>
  );
}

/** The newest run in one line, for a task's row. */
export function ScheduledRunLine({
  environmentId,
  run,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: ScheduledTaskRun;
}) {
  const detail = run.error ?? run.summary;
  return (
    <>
      <ScheduledRunOutcomeBadge outcome={run.outcome} />
      <span>
        <ScheduledRelativeLabel value={run.startedAt} />
      </span>
      {detail ? <span className="line-clamp-1 min-w-0 wrap-anywhere">{detail}</span> : null}
      {run.outcome === "needs_input" ? (
        <ScheduledRunConversationLink environmentId={environmentId} run={run} />
      ) : null}
    </>
  );
}

function ScheduledRunRow({
  environmentId,
  run,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: ScheduledTaskRun;
  readonly onNavigate: () => void;
}) {
  return (
    <li className="space-y-1 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <ScheduledRunOutcomeBadge outcome={run.outcome} />
        <span>{formatScheduleTime(run.startedAt)}</span>
        <span className="text-muted-foreground">{SCHEDULED_RUN_TRIGGER_LABELS[run.trigger]}</span>
      </div>
      {run.summary ? <p className="wrap-anywhere">{run.summary}</p> : null}
      {run.error ? <p className="wrap-anywhere text-destructive">{run.error}</p> : null}
      <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{scheduledRunDetails(run)}</span>
        <ScheduledRunConversationLink
          environmentId={environmentId}
          run={run}
          onNavigate={onNavigate}
        />
      </p>
    </li>
  );
}

function ScheduledRunHistoryPage({
  environmentId,
  task,
  before,
  onNavigate,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly before?: ScheduledTaskRun["startedAt"];
  readonly onNavigate: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({
      environmentId,
      input: { id: task.id, ...(before === undefined ? {} : { before }) },
    }),
  );
  const [nextOpen, setNextOpen] = useState(false);
  const page = query.data;
  if (query.error !== null) {
    return <li className="py-2 text-sm text-destructive">{query.error}</li>;
  }
  if (page === null) {
    return (
      <li className="py-2 text-sm text-muted-foreground" role="status">
        Loading runs…
      </li>
    );
  }
  const runs = before === undefined ? withLatestScheduledRun(page.runs, task.latestRun) : page.runs;
  if (runs.length === 0 && before === undefined) {
    return <li className="py-2 text-sm text-muted-foreground">No runs yet.</li>;
  }
  const cursor = page.runs.at(-1)?.startedAt;
  return (
    <>
      {runs.map((run) => (
        <ScheduledRunRow
          key={run.id}
          environmentId={environmentId}
          run={run}
          onNavigate={onNavigate}
        />
      ))}
      {!page.hasMore || cursor === undefined ? null : nextOpen ? (
        <ScheduledRunHistoryPage
          environmentId={environmentId}
          task={task}
          before={cursor}
          onNavigate={onNavigate}
        />
      ) : (
        <li className="py-2">
          <Button variant="outline" size="sm" onClick={() => setNextOpen(true)}>
            Load more
          </Button>
        </li>
      )}
    </>
  );
}

export function ScheduledTaskRunHistoryDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly onClose: () => void;
}) {
  const newest = useEnvironmentQuery(
    serverEnvironment.scheduledTaskRuns({ environmentId, input: { id: task.id } }),
  );
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run history · {task.title}</DialogTitle>
          <DialogDescription>Each run of this task, newest first.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="divide-y divide-border">
            <ScheduledRunHistoryPage
              environmentId={environmentId}
              task={task}
              onNavigate={onClose}
            />
          </ul>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={newest.isPending} onClick={newest.refresh}>
            Refresh
          </Button>
          <DialogClose render={<Button size="sm" />}>Done</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
