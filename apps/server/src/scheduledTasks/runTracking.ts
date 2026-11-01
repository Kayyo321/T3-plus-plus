import {
  DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type ScheduledRunVerdict,
  type ScheduledTaskRepeater,
  type ScheduledTaskRunOutcome,
  type ScheduledTaskRunPolicy,
} from "@t3tools/contracts";

const RUN_SUMMARY_MAX_CHARS = 500;

/** Each of these is one tool the agent ran. */
export const TOOL_TURN_ITEM_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

export interface RunMeasure {
  readonly elapsedMs: number;
  readonly toolCalls: number;
  /** Null when the model's price is unknown; a cost limit then cannot apply. */
  readonly costUsd: number | null;
  readonly waitingOnPerson: boolean;
}

export type RunAssessment =
  | { readonly type: "continue" }
  | { readonly type: "park" }
  | { readonly type: "stop"; readonly outcome: ScheduledTaskRunOutcome; readonly error: string }
  | { readonly type: "finish"; readonly outcome: ScheduledTaskRunOutcome };

const SETTLED_OUTCOMES: Readonly<
  Partial<Record<OrchestrationV2Run["status"], ScheduledTaskRunOutcome>>
> = {
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  rolled_back: "interrupted",
};

function overBudget(
  budget: NonNullable<ScheduledTaskRunPolicy["budget"]>,
  measure: RunMeasure,
): string | null {
  if (
    budget.maxDurationMinutes !== undefined &&
    measure.elapsedMs >= budget.maxDurationMinutes * 60_000
  ) {
    return `Stopped after the ${budget.maxDurationMinutes}-minute limit.`;
  }
  if (budget.maxToolCalls !== undefined && measure.toolCalls >= budget.maxToolCalls) {
    return `Stopped after the limit of ${budget.maxToolCalls} tool calls.`;
  }
  if (
    budget.maxCostUsd !== undefined &&
    measure.costUsd !== null &&
    measure.costUsd >= budget.maxCostUsd
  ) {
    return `Stopped at the $${budget.maxCostUsd} cost limit.`;
  }
  return null;
}

/** What to do with a run this tick. A run waiting on a person spends nothing, so no budget ends it. */
export function assessRun(input: {
  readonly status: OrchestrationV2Run["status"];
  readonly policy: ScheduledTaskRunPolicy | undefined;
  readonly measure: RunMeasure;
  readonly verdict: ScheduledRunVerdict | null;
}): RunAssessment {
  const { status, policy, measure, verdict } = input;
  if (status === "completed") {
    return {
      type: "finish",
      outcome:
        verdict === "done"
          ? "done"
          : verdict === "nothing_changed"
            ? "nothing_changed"
            : "succeeded",
    };
  }
  const settled = SETTLED_OUTCOMES[status];
  if (settled !== undefined) return { type: "finish", outcome: settled };
  if (status !== "running" && status !== "waiting") return { type: "continue" };
  if (measure.waitingOnPerson) {
    return policy?.onPrompt === "fail"
      ? {
          type: "stop",
          outcome: "failed",
          error: "The run needed an answer, and this task stops instead of waiting.",
        }
      : { type: "park" };
  }
  const exceeded = overBudget(policy?.budget ?? DEFAULT_SCHEDULED_TASK_RUN_BUDGET, measure);
  return exceeded === null
    ? { type: "continue" }
    : { type: "stop", outcome: "budget_exceeded", error: exceeded };
}

/** Whether a repeater keeps going after a run, and if not, the outcome it stops on. */
export function repeaterStep(input: {
  readonly repeater: ScheduledTaskRepeater;
  readonly iteration: number;
  readonly outcome: ScheduledTaskRunOutcome;
}): { readonly stop: boolean; readonly outcome: ScheduledTaskRunOutcome } {
  const { repeater, iteration, outcome } = input;
  if (outcome !== "succeeded" && outcome !== "nothing_changed") return { stop: true, outcome };
  return iteration >= repeater.maxIterations
    ? { stop: true, outcome: "iteration_limit" }
    : { stop: false, outcome };
}

/** What a run must be told to report. Only tasks that act on the report carry it. */
export function runReportRequest(
  policy: ScheduledTaskRunPolicy | undefined,
  iteration: number,
): string | null {
  if (policy?.repeater !== undefined) {
    const { doneWhen, maxIterations } = policy.repeater;
    return `This is scheduled run ${iteration} of at most ${maxIterations}. Stop when: ${doneWhen}\nAs your last step, call \`report_scheduled_run\` with verdict "done" if that holds, otherwise "continue".`;
  }
  return policy?.notify === "changes"
    ? `As your last step, call \`report_scheduled_run\`. Use verdict "nothing_changed" if there was nothing to do.`
    : null;
}

export const summarize = (text: string): string | null => {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  return trimmed.length > RUN_SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, RUN_SUMMARY_MAX_CHARS - 1)}…`
    : trimmed;
};
