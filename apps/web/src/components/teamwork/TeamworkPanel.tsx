import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { teamMemberName } from "@t3tools/shared/teamSheets";
import type {
  ScopedThreadRef,
  TeamGrowthRequest,
  TeamMember,
  TeamRosterSlot,
  TeamRun,
  TeamRunStatus,
  TeamTask,
  TeamworkChange,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { openThreadInSplit } from "../../layouts/layoutActions";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type EnvironmentId = ScopedThreadRef["environmentId"];

const STATUS_LABEL: Record<TeamRunStatus, string> = {
  running: "Running",
  awaiting_owner: "Needs you",
  blocked: "Blocked",
  over_budget: "Over budget",
  stopped: "Stopped",
  done: "Done",
};

const MEMBER_STATE_LABEL: Record<TeamMember["state"], string> = {
  idle: "Idle",
  invoked: "Working",
  blocked: "Blocked",
  removed: "Removed",
};

const GROWTH_LABEL: Record<TeamGrowthRequest["status"], string> = {
  refused: "Refused",
  open: "With the lead",
  awaiting_owner: "Needs you",
  owner_allowed: "Allowed, with the lead",
  accepted: "Accepted",
  denied: "Denied",
};

const changeKey = (change: TeamworkChange | null) => {
  if (change === null) return null;
  return change.type === "run"
    ? `run:${change.runId}:${change.updatedAt}`
    : `${change.type}:${
        change.type === "sheet" ? `${change.sheetId}:${change.revision}` : change.threadId
      }`;
};

const budgetLabel = (run: TeamRun) => {
  const cost = run.costUsd == null ? "Cost unknown" : `$${run.costUsd.toFixed(2)}`;
  return run.budget.maxCostUsd === undefined ? cost : `${cost} of $${run.budget.maxCostUsd}`;
};

function MemberRow(props: { readonly member: TeamMember; readonly environmentId: EnvironmentId }) {
  const { member, environmentId } = props;
  const ref = member.threadId === null ? null : scopeThreadRef(environmentId, member.threadId);
  return (
    <li className="flex items-center gap-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate">
          {ref === null ? (
            member.name
          ) : (
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(ref)}
              className="underline-offset-2 hover:underline"
            >
              {member.name}
            </Link>
          )}
          {member.modelSelection ? (
            <span className="text-muted-foreground"> · {member.modelSelection.model}</span>
          ) : null}
        </p>
        {member.detail ? <p className="text-muted-foreground">{member.detail}</p> : null}
      </div>
      <span className="text-muted-foreground">{MEMBER_STATE_LABEL[member.state]}</span>
      {ref === null ? null : (
        <Button size="xs" variant="ghost" onClick={() => openThreadInSplit(ref)}>
          Split
        </Button>
      )}
    </li>
  );
}

function TaskRow(props: { readonly task: TeamTask }) {
  const { task } = props;
  return (
    <li className="flex flex-col gap-0.5 text-xs">
      <div className="flex gap-2">
        <span className="min-w-0 flex-1">{task.objective}</span>
        <span className="text-muted-foreground">{task.status}</span>
      </div>
      {task.blocker ? <p className="text-muted-foreground">Blocked: {task.blocker}</p> : null}
      {task.findings.map((finding) => (
        <p key={finding.id} className="text-muted-foreground">
          {finding.severity === "blocking" ? "Blocking" : "Suggestion"} ({finding.status}):{" "}
          {finding.problem}
        </p>
      ))}
    </li>
  );
}

function GrowthRow(props: {
  readonly request: TeamGrowthRequest;
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly canAct: boolean;
}) {
  const { request, run, environmentId } = props;
  const act = useAtomCommand(serverEnvironment.actTeamwork);
  const answer = (allow: boolean) =>
    act({
      environmentId,
      input: {
        runId: run.id,
        action: { type: "owner_growth_answer", requestId: request.id, allow },
      },
    });
  return (
    <li className="flex flex-col gap-1 text-xs">
      <div className="flex gap-2">
        <span className="min-w-0 flex-1">{request.capacity}</span>
        <span className="text-muted-foreground">{GROWTH_LABEL[request.status]}</span>
      </div>
      <p className="text-muted-foreground">{request.why}</p>
      {request.decidedBy !== null ? (
        <p className="text-muted-foreground">
          Decided by {request.decidedBy}
          {request.reason ? `: ${request.reason}` : ""}
        </p>
      ) : null}
      {request.status === "awaiting_owner" && props.canAct ? (
        <div className="flex gap-1">
          <Button size="xs" onClick={() => answer(true)}>
            Allow
          </Button>
          <Button size="xs" variant="ghost" onClick={() => answer(false)}>
            Deny
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function BlockedSlotRow(props: {
  readonly slot: TeamRosterSlot;
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly onReplaced: () => void;
}) {
  const { slot, run, environmentId } = props;
  const replace = useAtomCommand(serverEnvironment.replaceTeamSlot);
  const canReplace = useAtomValue(serverEnvironment.replaceTeamSlot.permissionAtom(environmentId));
  const nodeName = run.flow.nodes.find((node) => node.id === slot.nodeId)?.name ?? slot.nodeId;
  return (
    <li className="flex items-start gap-2 text-xs">
      <div className="min-w-0 flex-1">
        <p>{teamMemberName(nodeName, slot.slot)} is blocked</p>
        {slot.detail ? <p className="text-muted-foreground">{slot.detail}</p> : null}
      </div>
      {canReplace ? (
        <Button
          size="xs"
          variant="outline"
          onClick={async () => {
            const result = await replace({
              environmentId,
              input: {
                threadId: slot.threadId,
                sheetId: slot.sheetId,
                nodeId: slot.nodeId,
                slot: slot.slot,
              },
            });
            if (result._tag === "Success") props.onReplaced();
          }}
        >
          Replace
        </Button>
      ) : null}
    </li>
  );
}

function BlockedSlots(props: {
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly changeKey: string | null;
}) {
  const { run, environmentId } = props;
  const roster = useEnvironmentQuery(
    serverEnvironment.teamRoster({
      environmentId,
      input: { threadId: run.parentThreadId, sheetId: run.sheetId },
    }),
  );
  const { refresh } = roster;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server stream is the outside system; each change re-reads the roster.
  useEffect(() => {
    if (props.changeKey !== null) refresh();
  }, [props.changeKey, refresh]);
  const blocked = roster.data?.slots.filter((slot) => slot.status === "blocked") ?? [];
  if (blocked.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {blocked.map((slot) => (
        <BlockedSlotRow
          key={`${slot.nodeId}/${slot.slot}`}
          slot={slot}
          run={run}
          environmentId={environmentId}
          onReplaced={refresh}
        />
      ))}
    </ul>
  );
}

function RunReport(props: { readonly report: NonNullable<TeamRun["report"]> }) {
  const { report } = props;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <p>{report.summary}</p>
      {report.verified.length > 0 ? <p>Verified: {report.verified.join("; ")}</p> : null}
      {report.notVerified.length > 0 ? <p>Not verified: {report.notVerified.join("; ")}</p> : null}
      {report.openRisks.length > 0 ? <p>Open risks: {report.openRisks.join("; ")}</p> : null}
    </div>
  );
}

function RunActions(props: { readonly run: TeamRun; readonly environmentId: EnvironmentId }) {
  const { run, environmentId } = props;
  const act = useAtomCommand(serverEnvironment.actTeamwork);
  return (
    <div className="flex gap-1">
      {run.status === "over_budget" ? (
        <Button
          size="xs"
          onClick={() =>
            act({
              environmentId,
              input: {
                runId: run.id,
                action: {
                  type: "owner_resume",
                  budget: {
                    ...run.budget,
                    maxMinutes: run.budget.maxMinutes * 2,
                    ...(run.budget.maxCostUsd === undefined
                      ? {}
                      : { maxCostUsd: run.budget.maxCostUsd * 2 }),
                  },
                },
              },
            })
          }
        >
          Double budget and resume
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          act({
            environmentId,
            input: {
              runId: run.id,
              action: { type: "owner_stop", reason: "Stopped by the owner" },
            },
          })
        }
      >
        Stop
      </Button>
    </div>
  );
}

function TeamRunCard(props: {
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly changeKey: string | null;
  readonly showRoster: boolean;
}) {
  const { run, environmentId } = props;
  const canAct = useAtomValue(serverEnvironment.actTeamwork.permissionAtom(environmentId));
  const closed = run.status === "stopped" || run.status === "done";
  const activeNode = run.flow.nodes.find((node) => node.id === run.activeNodeId);
  const failedChecks = run.evidence.filter((entry) => !entry.passed).length;
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border/60 p-2">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-xs font-medium">{run.request}</p>
        <Badge variant={run.status === "running" ? "secondary" : "outline"}>
          {STATUS_LABEL[run.status]}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {run.flow.sheetName}
        {activeNode ? ` · At ${activeNode.name}` : ""}
        {run.waitingFor ? ` · Waiting for ${run.waitingFor}` : ""} · {budgetLabel(run)} ·{" "}
        {run.correctionCycles} of {run.budget.maxCorrectionCycles} correction cycles
      </p>
      <ul className="flex flex-col gap-1">
        {run.members.map((member) => (
          <MemberRow key={member.id} member={member} environmentId={environmentId} />
        ))}
      </ul>
      {props.showRoster ? (
        <BlockedSlots run={run} environmentId={environmentId} changeKey={props.changeKey} />
      ) : null}
      {run.tasks.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {run.tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {run.evidence.length} checks, {failedChecks} failed · {run.verdicts.length} verdicts
      </p>
      {run.growth.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {run.growth.map((request) => (
            <GrowthRow
              key={request.id}
              request={request}
              run={run}
              environmentId={environmentId}
              canAct={canAct && !closed}
            />
          ))}
        </ul>
      ) : null}
      {run.notes.slice(-3).map((note) => (
        <p key={`${note.at}:${note.byId}`} className="text-xs text-muted-foreground">
          {note.kind}: {note.text}
        </p>
      ))}
      {run.report ? <RunReport report={run.report} /> : null}
      {canAct && !closed ? <RunActions run={run} environmentId={environmentId} /> : null}
    </section>
  );
}

export function TeamworkPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const changed = useEnvironmentQuery(
    serverEnvironment.teamworkChanges({ environmentId, input: {} }),
  );
  const runs = useEnvironmentQuery(
    serverEnvironment.teamworkList({ environmentId, input: { parentThreadId: threadId } }),
  );
  const key = changeKey(changed.data);
  const { refresh } = runs;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server stream is the outside system; each change re-reads the board.
  useEffect(() => {
    if (key !== null) refresh();
  }, [key, refresh]);
  if (runs.data === null) {
    return <p className="p-3 text-xs text-muted-foreground">{runs.error ?? "Loading teams"}</p>;
  }
  const newestFirst = runs.data.runs.toSorted((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
  const newestBySheet = new Map(newestFirst.toReversed().map((run) => [run.sheetId, run.id]));
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {newestFirst.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No team runs on this thread yet. Enable a sheet from the composer to start one.
        </p>
      ) : (
        newestFirst.map((run) => (
          <TeamRunCard
            key={run.id}
            run={run}
            environmentId={environmentId}
            changeKey={key}
            showRoster={newestBySheet.get(run.sheetId) === run.id}
          />
        ))
      )}
    </div>
  );
}
