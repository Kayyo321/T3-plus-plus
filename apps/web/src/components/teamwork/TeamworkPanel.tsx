import { useAtomValue } from "@effect/atom-react";
import {
  BUILT_IN_TEAM_PRESETS,
  DEFAULT_TEAM_BUDGET,
  TEAM_PHASES,
  type ScopedThreadRef,
  type TeamDial,
  type TeamMember,
  type TeamRun,
  type TeamRunStatus,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const STATUS_LABEL: Record<TeamRunStatus, string> = {
  running: "Running",
  awaiting_owner: "Needs you",
  over_budget: "Over budget",
  stopped: "Stopped",
  completed: "Completed",
};

const DIALS: ReadonlyArray<{ readonly value: TeamDial; readonly label: string }> = [
  { value: "approve_each_phase", label: "Approve each phase" },
  { value: "approve_plan", label: "Approve the plan" },
  { value: "autonomous", label: "Autonomous" },
];

function ChoiceRow<T extends string>(props: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <Button
          key={option.value}
          size="xs"
          variant={option.value === props.value ? "secondary" : "ghost"}
          aria-pressed={option.value === props.value}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function StartTeam(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const start = useAtomCommand(serverEnvironment.startTeamwork);
  const [request, setRequest] = useState("");
  const [presetId, setPresetId] = useState(BUILT_IN_TEAM_PRESETS[0]?.id ?? "");
  const [dial, setDial] = useState<TeamDial>("approve_each_phase");
  const preset = BUILT_IN_TEAM_PRESETS.find((candidate) => candidate.id === presetId);
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="What should the team do"
        placeholder="What should the team do?"
        value={request}
        onChange={(event) => setRequest(event.target.value)}
      />
      <ChoiceRow
        label="Team"
        value={presetId}
        options={BUILT_IN_TEAM_PRESETS.map(({ id, name }) => ({ value: id, label: name }))}
        onChange={setPresetId}
      />
      {preset ? (
        <p className="text-xs text-muted-foreground">
          {preset.roles.map(({ role, count }) => `${count} ${role}`).join(", ")}. Budget $
          {DEFAULT_TEAM_BUDGET.maxCostUsd}, {DEFAULT_TEAM_BUDGET.maxMinutes} minutes.
        </p>
      ) : null}
      <ChoiceRow label="Oversight" value={dial} options={DIALS} onChange={setDial} />
      <Button
        size="xs"
        className="self-start"
        disabled={request.trim().length === 0}
        onClick={async () => {
          const result = await start({
            environmentId,
            input: { parentThreadId: threadId, request: request.trim(), presetId, dial },
          });
          if (result._tag === "Success") setRequest("");
        }}
      >
        Create board
      </Button>
      <p className="text-xs text-muted-foreground">
        Creating a board spends nothing. Start the lead when you are ready.
      </p>
    </div>
  );
}

function MemberRow(props: {
  readonly run: TeamRun;
  readonly member: TeamMember;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly canAct: boolean;
}) {
  const startMember = useAtomCommand(serverEnvironment.startTeamMember);
  const { member, run } = props;
  return (
    <li className="flex items-center gap-2 text-xs">
      <span className="min-w-0 flex-1 truncate capitalize">
        {member.role}
        {member.modelSelection ? ` · ${member.modelSelection.model}` : ""}
      </span>
      {member.threadId !== null ? (
        <span className="text-muted-foreground">Started</span>
      ) : props.canAct ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() =>
            startMember({
              environmentId: props.environmentId,
              input: { runId: run.id, memberId: member.id, message: run.request },
            })
          }
        >
          Start
        </Button>
      ) : null}
    </li>
  );
}

function TeamRunCard(props: {
  readonly run: TeamRun;
  readonly environmentId: ScopedThreadRef["environmentId"];
}) {
  const { run, environmentId } = props;
  const act = useAtomCommand(serverEnvironment.actTeamwork);
  const canAct = useAtomValue(serverEnvironment.actTeamwork.permissionAtom(environmentId));
  const closed = run.status === "stopped" || run.status === "completed";
  const phaseIndex = TEAM_PHASES.indexOf(run.phase);
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
        Phase {phaseIndex + 1} of {TEAM_PHASES.length}: {run.phase.replace("_", " ")}
        {run.waitingFor ? ` · Waiting for ${run.waitingFor}` : ""}
        {run.costUsd != null ? ` · About $${run.costUsd.toFixed(2)} measured` : " · Cost unknown"}
      </p>
      <ul className="flex flex-col gap-1">
        {run.members.map((member) => (
          <MemberRow
            key={member.id}
            run={run}
            member={member}
            environmentId={environmentId}
            canAct={canAct && !closed}
          />
        ))}
      </ul>
      {run.tasks.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs">
          {run.tasks.map((task) => (
            <li key={task.id} className="flex gap-2">
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="text-muted-foreground">{task.blocker ?? task.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {run.evidence.length} checks, {failedChecks} failed · {run.verdicts.length} verdicts ·{" "}
        {run.reviewLoops} of {run.budget.maxReviewLoops} review loops
      </p>
      {run.notes.slice(-3).map((note) => (
        <p key={`${note.at}:${note.byId}`} className="text-xs text-muted-foreground">
          {note.kind}: {note.text}
        </p>
      ))}
      {run.report ? (
        <div className="flex flex-col gap-1 text-xs">
          <p>{run.report.summary}</p>
          {run.report.notVerified.length > 0 ? (
            <p>Not verified: {run.report.notVerified.join("; ")}</p>
          ) : null}
          {run.report.openRisks.length > 0 ? (
            <p>Open risks: {run.report.openRisks.join("; ")}</p>
          ) : null}
        </div>
      ) : null}
      {canAct && !closed ? (
        <div className="flex gap-1">
          {run.status === "awaiting_owner" ? (
            <Button
              size="xs"
              onClick={() =>
                act({
                  environmentId,
                  input: { runId: run.id, action: { type: "owner_approve" } },
                })
              }
            >
              Approve
            </Button>
          ) : null}
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
      ) : null}
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
  const changeKey = changed.data === null ? null : `${changed.data.id}:${changed.data.updatedAt}`;
  const { refresh } = runs;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server stream is the outside system; each change re-reads the board.
  useEffect(() => {
    if (changeKey !== null) refresh();
  }, [changeKey, refresh]);
  const canStart = useAtomValue(serverEnvironment.startTeamwork.permissionAtom(environmentId));
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {canStart ? <StartTeam threadRef={props.threadRef} /> : null}
      {runs.data === null ? (
        <p className="text-xs text-muted-foreground">{runs.error ?? "Loading teams"}</p>
      ) : (
        runs.data.runs.map((run) => (
          <TeamRunCard key={run.id} run={run} environmentId={environmentId} />
        ))
      )}
    </div>
  );
}
