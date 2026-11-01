import {
  defaultScheduledTaskMissedRuns,
  SCHEDULED_TASK_MISSED_RUN_OPTIONS,
  SCHEDULED_TASK_NOTIFY_OPTIONS,
  SCHEDULED_TASK_PROMPT_OPTIONS,
} from "@t3tools/client-runtime/scheduled-task-policy";
import {
  DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The summary a run reported, or the reason it stopped. */
export function scheduledRunText(run: Pick<ScheduledTaskRun, "summary" | "error">): string | null {
  return run.error ?? run.summary;
}

function budgetText(task: Pick<ScheduledTask, "policy">): string {
  const budget = task.policy?.budget ?? DEFAULT_SCHEDULED_TASK_RUN_BUDGET;
  return [
    budget.maxDurationMinutes === undefined ? null : `${budget.maxDurationMinutes} min`,
    budget.maxToolCalls === undefined ? null : `${budget.maxToolCalls} tool calls`,
    budget.maxCostUsd === undefined ? null : `$${budget.maxCostUsd}`,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** What an unattended run is held to, with the server's defaults where the task sets nothing. */
export function scheduledTaskPolicyRows(
  task: Pick<ScheduledTask, "policy" | "repeaterIteration" | "schedule">,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const { policy } = task;
  const label = <Value extends string>(
    options: ReadonlyArray<{ readonly value: Value; readonly label: string }>,
    value: Value,
  ) => options.find((option) => option.value === value)?.label ?? value;
  return [
    { label: "Limit per run", value: budgetText(task) },
    {
      label: "If a run is missed",
      value: label(
        SCHEDULED_TASK_MISSED_RUN_OPTIONS,
        policy?.missedRuns ?? defaultScheduledTaskMissedRuns(task.schedule.type),
      ),
    },
    { label: "Notify", value: label(SCHEDULED_TASK_NOTIFY_OPTIONS, policy?.notify ?? "all") },
    {
      label: "If it needs an answer",
      value: label(SCHEDULED_TASK_PROMPT_OPTIONS, policy?.onPrompt ?? "park"),
    },
    ...(policy?.repeater
      ? [
          {
            label: "Repeat until",
            value: `${policy.repeater.doneWhen} (${task.repeaterIteration ?? 0} of ${policy.repeater.maxIterations} runs)`,
          },
        ]
      : []),
  ];
}

export function formatScheduledTaskInterval(everyMs: number): string {
  const units = [
    [7 * DAY, "week"],
    [DAY, "day"],
    [HOUR, "hour"],
    [MINUTE, "minute"],
    [1_000, "second"],
    [1, "millisecond"],
  ] as const;
  let remaining = everyMs;
  const parts: string[] = [];
  for (const [size, unit] of units) {
    const count = Math.floor(remaining / size);
    if (count === 0) continue;
    if (count === 1 && remaining === everyMs && remaining === size) return `Every ${unit}`;
    parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    remaining %= size;
  }
  return `Every ${parts.join(" ")}`;
}

function localCalendarDay(date: Date): number {
  // Compare calendar days, not 24-hour spans: DST days can have 23 or 25 hours.
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export function formatNextScheduledTaskRun(nextRunAt: string, now: number): string {
  const next = new Date(nextRunAt);
  const current = new Date(now);
  const remaining = next.getTime() - now;
  if (!Number.isFinite(remaining)) return "Next run unavailable";
  if (remaining <= 0) return "Next run due";

  const days = localCalendarDay(next) - localCalendarDay(current);
  if (days === 0) {
    if (remaining < MINUTE) return "Next run in less than a minute";
    const unit = remaining < HOUR ? "minute" : "hour";
    const count = Math.round(remaining / (remaining < HOUR ? MINUTE : HOUR));
    return `Next run in ${count} ${unit}${count === 1 ? "" : "s"}`;
  }

  const time = next.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return `Next run tomorrow at ${time}`;
  if (days <= 7) {
    return `Next run next ${next.toLocaleDateString([], { weekday: "long" })} at ${time}`;
  }
  const date = next.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(next.getFullYear() !== current.getFullYear() ? { year: "numeric" as const } : {}),
  });
  return `Next run ${date} at ${time}`;
}
