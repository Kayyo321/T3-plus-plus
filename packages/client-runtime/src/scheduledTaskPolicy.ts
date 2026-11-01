import {
  DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
  MAX_SCHEDULED_TASK_ITERATIONS,
  type ScheduledTaskHost,
  type ScheduledTaskMissedRunPolicy,
  type ScheduledTaskNotifyPolicy,
  type ScheduledTaskPromptPolicy,
  type ScheduledTaskRun,
  type ScheduledTaskRunPolicy,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskSchedule,
} from "@t3tools/contracts";

export const DEFAULT_SCHEDULED_TASK_ITERATIONS = 10;

const MAX_DONE_WHEN_LENGTH = 2000;

/** One editable policy. Numbers stay text, and an empty choice leaves it to the server's default. */
export interface ScheduledTaskPolicyDraft {
  readonly maxDurationMinutes: string;
  readonly maxToolCalls: string;
  readonly maxCostUsd: string;
  readonly doneWhen: string;
  readonly maxIterations: string;
  readonly missedRuns: ScheduledTaskMissedRunPolicy | "";
  readonly notify: ScheduledTaskNotifyPolicy | "";
  readonly onPrompt: ScheduledTaskPromptPolicy | "";
  /** The policy the form opened with, so a save keeps what the form doesn't edit. */
  readonly saved: ScheduledTaskRunPolicy;
}

export const SCHEDULED_TASK_MISSED_RUN_OPTIONS: ReadonlyArray<{
  readonly value: ScheduledTaskMissedRunPolicy;
  readonly label: string;
}> = [
  { value: "skip", label: "Skip it" },
  { value: "run_once", label: "Run once on wake" },
  { value: "catch_up", label: "Catch up" },
];

export const SCHEDULED_TASK_NOTIFY_OPTIONS: ReadonlyArray<{
  readonly value: ScheduledTaskNotifyPolicy;
  readonly label: string;
}> = [
  { value: "all", label: "Every run" },
  { value: "changes", label: "Only changes" },
  { value: "failures", label: "Only failures" },
  { value: "none", label: "Never" },
];

export const SCHEDULED_TASK_PROMPT_OPTIONS: ReadonlyArray<{
  readonly value: ScheduledTaskPromptPolicy;
  readonly label: string;
}> = [
  { value: "park", label: "Wait for me" },
  { value: "fail", label: "Stop it" },
];

/** Matches the server: clock schedules skip a missed time, the rest run late. */
export function defaultScheduledTaskMissedRuns(
  scheduleType: ScheduledTaskSchedule["type"],
): ScheduledTaskMissedRunPolicy {
  return scheduleType === "fixed_time" || scheduleType === "cron" ? "skip" : "run_once";
}

export function scheduledTaskPolicyDraft(
  policy: ScheduledTaskRunPolicy | undefined,
): ScheduledTaskPolicyDraft {
  const saved = policy ?? {};
  return {
    maxDurationMinutes: String(saved.budget?.maxDurationMinutes ?? ""),
    maxToolCalls: String(saved.budget?.maxToolCalls ?? ""),
    maxCostUsd: String(saved.budget?.maxCostUsd ?? ""),
    doneWhen: saved.repeater?.doneWhen ?? "",
    maxIterations: String(saved.repeater?.maxIterations ?? ""),
    missedRuns: saved.missedRuns ?? "",
    notify: saved.notify ?? "",
    onPrompt: saved.onPrompt ?? "",
    saved,
  };
}

/** Blank is null. Undefined means the text is not a valid value, which blocks saving. */
function parsePositive(text: string, integer: boolean): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  const valid = integer ? Number.isSafeInteger(value) : Number.isFinite(value);
  return valid && value > 0 ? value : undefined;
}

function parseBudget(
  draft: ScheduledTaskPolicyDraft,
  stored: ScheduledTaskPolicyDraft,
): { readonly budget: ScheduledTaskRunPolicy["budget"] } | { readonly error: string } {
  const maxDurationMinutes = parsePositive(draft.maxDurationMinutes, true);
  const maxToolCalls = parsePositive(draft.maxToolCalls, true);
  const maxCostUsd = parsePositive(draft.maxCostUsd, false);
  if (maxDurationMinutes === undefined || maxToolCalls === undefined) {
    return { error: "Run limits must be whole numbers above zero, or blank." };
  }
  if (maxCostUsd === undefined) return { error: "A cost limit must be above zero, or blank." };
  if (
    draft.maxDurationMinutes.trim() === stored.maxDurationMinutes &&
    draft.maxToolCalls.trim() === stored.maxToolCalls &&
    draft.maxCostUsd.trim() === stored.maxCostUsd
  ) {
    return { budget: draft.saved.budget };
  }
  if (maxDurationMinutes === null && maxToolCalls === null && maxCostUsd === null) {
    return { budget: undefined };
  }
  // The server replaces its default budget with a stored one, so a partial budget drops the rest.
  const { maxCostUsd: _replaced, ...savedBudget } = draft.saved.budget ?? {};
  return {
    budget: {
      ...savedBudget,
      ...DEFAULT_SCHEDULED_TASK_RUN_BUDGET,
      ...(maxDurationMinutes === null ? {} : { maxDurationMinutes }),
      ...(maxToolCalls === null ? {} : { maxToolCalls }),
      ...(maxCostUsd === null ? {} : { maxCostUsd }),
    },
  };
}

function parseRepeater(
  draft: ScheduledTaskPolicyDraft,
): { readonly repeater: ScheduledTaskRunPolicy["repeater"] } | { readonly error: string } {
  const doneWhen = draft.doneWhen.trim();
  if (doneWhen === "") return { repeater: undefined };
  if (doneWhen.length > MAX_DONE_WHEN_LENGTH) {
    return { error: `Keep the done condition under ${MAX_DONE_WHEN_LENGTH} characters.` };
  }
  const maxIterations = parsePositive(draft.maxIterations, true);
  if (maxIterations === undefined || (maxIterations ?? 0) > MAX_SCHEDULED_TASK_ITERATIONS) {
    return {
      error: `Max iterations must be a whole number up to ${MAX_SCHEDULED_TASK_ITERATIONS}.`,
    };
  }
  return {
    repeater: {
      ...draft.saved.repeater,
      doneWhen,
      maxIterations: maxIterations ?? DEFAULT_SCHEDULED_TASK_ITERATIONS,
    },
  };
}

/** Checks a draft against the same limits the server's schema enforces. */
export function parseScheduledTaskPolicyDraft(
  draft: ScheduledTaskPolicyDraft,
): { readonly policy: ScheduledTaskRunPolicy } | { readonly error: string } {
  const parsedBudget = parseBudget(draft, scheduledTaskPolicyDraft(draft.saved));
  if ("error" in parsedBudget) return parsedBudget;
  const parsedRepeater = parseRepeater(draft);
  if ("error" in parsedRepeater) return parsedRepeater;
  const {
    budget: _budget,
    repeater: _repeater,
    missedRuns: _missedRuns,
    notify: _notify,
    onPrompt: _onPrompt,
    ...unknownFields
  } = draft.saved;
  return {
    policy: {
      ...unknownFields,
      ...(parsedBudget.budget === undefined ? {} : { budget: parsedBudget.budget }),
      ...(parsedRepeater.repeater === undefined ? {} : { repeater: parsedRepeater.repeater }),
      ...(draft.missedRuns === "" ? {} : { missedRuns: draft.missedRuns }),
      ...(draft.notify === "" ? {} : { notify: draft.notify }),
      ...(draft.onPrompt === "" ? {} : { onPrompt: draft.onPrompt }),
    },
  };
}

const FAILURE_OUTCOMES: ReadonlySet<string> = new Set([
  "failed",
  "budget_exceeded",
  "iteration_limit",
  "interrupted",
]);

/** `finishedAt` decides, so an outcome this client doesn't know yet still counts once it ends. */
export function shouldNotifyScheduledRun(
  run: Pick<ScheduledTaskRun, "outcome" | "finishedAt">,
  notify: ScheduledTaskNotifyPolicy = "all",
): boolean {
  if (notify === "none") return false;
  if (run.outcome === "needs_input") return true;
  if (run.finishedAt === null) return false;
  if (notify === "failures") return FAILURE_OUTCOMES.has(run.outcome);
  return notify === "all" || run.outcome !== "nothing_changed";
}

export type ScheduledRunTone = "success" | "info" | "warning" | "error" | "neutral";

const RUN_OUTCOMES: ReadonlyMap<
  string,
  { readonly label: string; readonly tone: ScheduledRunTone }
> = new Map([
  ["running", { label: "Running", tone: "info" }],
  ["needs_input", { label: "Needs your answer", tone: "warning" }],
  ["succeeded", { label: "Succeeded", tone: "success" }],
  ["done", { label: "Done", tone: "success" }],
  ["nothing_changed", { label: "Nothing changed", tone: "neutral" }],
  ["skipped", { label: "Skipped", tone: "neutral" }],
  ["interrupted", { label: "Interrupted", tone: "warning" }],
  ["iteration_limit", { label: "Reached iteration limit", tone: "warning" }],
  ["budget_exceeded", { label: "Over budget", tone: "error" }],
  ["failed", { label: "Failed", tone: "error" }],
]);

/** The schema allows any outcome string, so a newer server's outcome still reads as words. */
export function scheduledRunOutcome(outcome: string): {
  readonly label: string;
  readonly tone: ScheduledRunTone;
} {
  const words = outcome.replaceAll("_", " ");
  return (
    RUN_OUTCOMES.get(outcome) ?? {
      label: `${words.charAt(0).toUpperCase()}${words.slice(1)}`,
      tone: "neutral",
    }
  );
}

export const SCHEDULED_RUN_TRIGGER_LABELS: Readonly<Record<ScheduledTaskRunTrigger, string>> = {
  scheduled: "On schedule",
  manual: "Run now",
  webhook: "Webhook",
};

/** Tool calls, cost and iteration, leaving out what the run doesn't have. */
export function scheduledRunDetails(
  run: Pick<ScheduledTaskRun, "toolCalls" | "costUsd" | "iteration">,
): string {
  const cost =
    run.costUsd === null ? null : run.costUsd < 0.01 ? "Under $0.01" : `$${run.costUsd.toFixed(2)}`;
  return [
    `${run.toolCalls} tool ${run.toolCalls === 1 ? "call" : "calls"}`,
    cost,
    run.iteration > 0 ? `Iteration ${run.iteration}` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** A first page can be cached while the live list moves on, so the live run wins. */
export function withLatestScheduledRun(
  runs: ReadonlyArray<ScheduledTaskRun>,
  latest: ScheduledTaskRun | undefined,
): ReadonlyArray<ScheduledTaskRun> {
  if (latest === undefined) return runs;
  if (runs.some((run) => run.id === latest.id)) {
    return runs.map((run) => (run.id === latest.id ? latest : run));
  }
  const newest = runs[0];
  return newest === undefined || latest.startedAt >= newest.startedAt ? [latest, ...runs] : runs;
}

/** Only a background service keeps tasks firing with nothing else open. */
export function scheduledTaskHostNotice(host: ScheduledTaskHost | undefined): string | null {
  if (host === "terminal") {
    return "Tasks run only while this server is open. Run t3pp service install to keep them running.";
  }
  if (host === "desktop") {
    return "Tasks run only while the app is open. Run t3pp service install to keep them running.";
  }
  return null;
}
