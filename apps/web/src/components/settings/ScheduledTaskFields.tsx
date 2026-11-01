import {
  DEFAULT_SCHEDULED_TASK_ITERATIONS,
  SCHEDULED_TASK_MISSED_RUN_OPTIONS,
  SCHEDULED_TASK_NOTIFY_OPTIONS,
  SCHEDULED_TASK_PROMPT_OPTIONS,
  defaultScheduledTaskMissedRuns,
  type ScheduledTaskPolicyDraft,
} from "@t3tools/client-runtime/scheduled-task-policy";
import {
  DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
  MAX_SCHEDULED_TASK_ITERATIONS,
  type RuntimeMode,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  formatScheduleTime,
  interpretScheduleText,
  nextCronRunFromDraft,
  type DraftState,
} from "./scheduledTasksSettings.logic";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80">{hint}</span>
        ) : null}
      </Label>
      {children}
    </div>
  );
}

const useMinuteDate = () => new Date(Date.parse(`${useNowMinute()}:00.000Z`));

export function ScheduleTextField({
  value,
  onChange,
  onApply,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onApply: () => void;
}) {
  const now = useMinuteDate();
  const typed = value.trim() !== "";
  const understood = typed ? interpretScheduleText(value, now) : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-1">
          <Input
            aria-label="Describe the schedule"
            placeholder="weekdays at 9am"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && understood !== null) onApply();
            }}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={understood === null}
          onClick={onApply}
        >
          Apply
        </Button>
      </div>
      {!typed ? (
        <p className="text-xs text-muted-foreground">
          Try “every 30 minutes”, “tomorrow at 9am” or a cron expression, or use the controls below.
        </p>
      ) : understood === null ? (
        <p className="text-xs text-destructive" role="status">
          Could not read that as a schedule.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" role="status">
          {understood.description}
          {understood.nextRun === null
            ? ". Never runs."
            : ` · Next run ${formatScheduleTime(understood.nextRun)}`}
        </p>
      )}
    </div>
  );
}

export function CronScheduleFields({
  draft,
  onChange,
}: {
  readonly draft: DraftState;
  readonly onChange: (patch: Pick<Partial<DraftState>, "cronExpression" | "cronTimeZone">) => void;
}) {
  const now = useMinuteDate();
  const next = nextCronRunFromDraft(draft, now);
  const zoneIsBlank = draft.cronTimeZone.trim() === "";
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Cron expression"
          hint="minute hour day month weekday"
          htmlFor="scheduled-task-cron"
        >
          <Input
            id="scheduled-task-cron"
            font="mono"
            placeholder="0 9 * * 1-5"
            value={draft.cronExpression}
            onChange={(event) => onChange({ cronExpression: event.target.value })}
          />
        </Field>
        <Field label="Time zone" hint="optional" htmlFor="scheduled-task-cron-zone">
          <Input
            id="scheduled-task-cron-zone"
            placeholder="The server's time zone"
            value={draft.cronTimeZone}
            onChange={(event) => onChange({ cronTimeZone: event.target.value })}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {next !== null
          ? `Next run ${formatScheduleTime(next)}${zoneIsBlank ? ", if the server shares this device's time zone" : ""}`
          : "No next run. Check the expression and the time zone."}
      </p>
    </div>
  );
}

function PolicySelect<Value extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select
        value={value}
        onValueChange={(next) => {
          const known = options.find((option) => option.value === next);
          if (known) onChange(known.value);
        }}
      >
        <SelectTrigger size="sm" id={id}>
          <SelectValue>{options.find((option) => option.value === value)?.label}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Field>
  );
}

function runtimeNote(runtimeMode: RuntimeMode, policy: ScheduledTaskPolicyDraft): string {
  const { label, description } = runtimeModeConfig[runtimeMode];
  if (runtimeMode !== "approval-required") return `Runs as ${label}. ${description}`;
  return `Runs as ${label}. With no one watching, a run ${
    policy.onPrompt === "fail" ? "stops" : "parks until you answer"
  } at the first command or file change.`;
}

export function ScheduledTaskPolicyFields({
  policy,
  scheduleType,
  runtimeMode,
  postsToConversation,
  onChange,
}: {
  readonly policy: ScheduledTaskPolicyDraft;
  readonly scheduleType: ScheduledTaskSchedule["type"];
  readonly runtimeMode: RuntimeMode;
  readonly postsToConversation: boolean;
  readonly onChange: (patch: Partial<ScheduledTaskPolicyDraft>) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Limits for each run</Label>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Minutes"
            hint={`default ${DEFAULT_SCHEDULED_TASK_RUN_BUDGET.maxDurationMinutes}`}
            htmlFor="scheduled-task-budget-minutes"
          >
            <Input
              id="scheduled-task-budget-minutes"
              type="number"
              nativeInput
              min={1}
              value={policy.maxDurationMinutes}
              placeholder={String(DEFAULT_SCHEDULED_TASK_RUN_BUDGET.maxDurationMinutes)}
              onChange={(event) => onChange({ maxDurationMinutes: event.target.value })}
            />
          </Field>
          <Field
            label="Tool calls"
            hint={`default ${DEFAULT_SCHEDULED_TASK_RUN_BUDGET.maxToolCalls}`}
            htmlFor="scheduled-task-budget-tools"
          >
            <Input
              id="scheduled-task-budget-tools"
              type="number"
              nativeInput
              min={1}
              value={policy.maxToolCalls}
              placeholder={String(DEFAULT_SCHEDULED_TASK_RUN_BUDGET.maxToolCalls)}
              onChange={(event) => onChange({ maxToolCalls: event.target.value })}
            />
          </Field>
          <Field label="Cost" hint="USD, no default" htmlFor="scheduled-task-budget-cost">
            <Input
              id="scheduled-task-budget-cost"
              type="number"
              nativeInput
              min={0}
              step="any"
              value={policy.maxCostUsd}
              placeholder="No limit"
              onChange={(event) => onChange({ maxCostUsd: event.target.value })}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          A cost limit applies only to models with known prices.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
        <Field label="Repeat until" hint="optional" htmlFor="scheduled-task-done-when">
          <Input
            id="scheduled-task-done-when"
            placeholder="All tests pass"
            value={policy.doneWhen}
            onChange={(event) => onChange({ doneWhen: event.target.value })}
          />
        </Field>
        <Field
          label="Max iterations"
          hint={`up to ${MAX_SCHEDULED_TASK_ITERATIONS}`}
          htmlFor="scheduled-task-max-iterations"
        >
          <Input
            id="scheduled-task-max-iterations"
            type="number"
            nativeInput
            min={1}
            max={MAX_SCHEDULED_TASK_ITERATIONS}
            disabled={policy.doneWhen.trim() === ""}
            value={policy.maxIterations}
            placeholder={String(DEFAULT_SCHEDULED_TASK_ITERATIONS)}
            onChange={(event) => onChange({ maxIterations: event.target.value })}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {scheduleType === "webhook" ? null : (
          <PolicySelect
            id="scheduled-task-missed-runs"
            label="If a run is missed"
            value={policy.missedRuns || defaultScheduledTaskMissedRuns(scheduleType)}
            options={SCHEDULED_TASK_MISSED_RUN_OPTIONS}
            onChange={(missedRuns) => onChange({ missedRuns })}
          />
        )}
        <PolicySelect
          id="scheduled-task-notify"
          label="Notify"
          value={policy.notify || "all"}
          options={SCHEDULED_TASK_NOTIFY_OPTIONS}
          onChange={(notify) => onChange({ notify })}
        />
        <PolicySelect
          id="scheduled-task-on-prompt"
          label="If a run needs an answer"
          value={policy.onPrompt || "park"}
          options={SCHEDULED_TASK_PROMPT_OPTIONS}
          onChange={(onPrompt) => onChange({ onPrompt })}
        />
      </div>
      {postsToConversation ? (
        <p className="text-xs text-muted-foreground">
          This task posts into a conversation, which notifies as usual.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{runtimeNote(runtimeMode, policy)}</p>
    </div>
  );
}
