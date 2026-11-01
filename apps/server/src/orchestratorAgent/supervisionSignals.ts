import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  SupervisionSignalKind,
  SupervisionThresholds,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;
/** The owner opened this thread this recently, so they are watching it themselves. */
const OWNER_PRESENT_MS = 2 * MINUTE_MS;

export interface SupervisionSignal {
  readonly kind: SupervisionSignalKind;
  readonly detail: string;
}

type ActionItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "command_execution" | "file_change" | "dynamic_tool" }
>;

export const ACTION_ITEM_TYPES = ["command_execution", "file_change", "dynamic_tool"] as const;

const isActionItem = (item: OrchestrationV2TurnItem): item is ActionItem =>
  item.type === "command_execution" || item.type === "file_change" || item.type === "dynamic_tool";

const normalize = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

/** What makes two actions "the same": the command, the file, or the tool and its input. */
const actionFingerprint = (item: ActionItem): string => {
  switch (item.type) {
    case "command_execution":
      return `command:${normalize(item.input)}`;
    case "file_change":
      return `file:${item.changes?.map((change) => change.path).join(",") ?? ""}`;
    case "dynamic_tool":
      return `tool:${item.toolName}:${normalize(JSON.stringify(item.input) ?? "")}`;
  }
};

/**
 * The longest run of equal actions at the end, counting A-B-A-B as a repeat of its pair, since two
 * steps undoing each other are a loop too.
 */
export const trailingRepeats = (fingerprints: ReadonlyArray<string>): number => {
  let best = 1;
  for (const period of [1, 2]) {
    let repeats = 1;
    while (true) {
      const end = fingerprints.length - repeats * period;
      const start = end - period;
      if (start < 0) break;
      const earlier = fingerprints.slice(start, end);
      const latest = fingerprints.slice(fingerprints.length - period);
      if (earlier.some((value, index) => value !== latest[index])) break;
      repeats += 1;
    }
    best = Math.max(best, repeats);
  }
  return fingerprints.length === 0 ? 0 : best;
};

const minutesSince = (from: DateTime.Utc, now: DateTime.Utc) =>
  (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(from)) / MINUTE_MS;

export const ownerIsPresent = (
  shell: Pick<OrchestrationV2ThreadShell, "lastVisitedAt">,
  now: DateTime.Utc,
) =>
  shell.lastVisitedAt != null &&
  DateTime.toEpochMillis(now) - DateTime.toEpochMillis(shell.lastVisitedAt) < OWNER_PRESENT_MS;

/** Computed on every tick for every watched thread, so it reads only what it is given. */
export const computeSignals = (input: {
  readonly shell: OrchestrationV2ThreadShell;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly attempts: number;
  readonly thresholds: SupervisionThresholds;
  readonly now: DateTime.Utc;
}): ReadonlyArray<SupervisionSignal> => {
  const { shell, thresholds, now } = input;
  const signals: Array<SupervisionSignal> = [];
  if (shell.activeRunId === null) return signals;

  const startedAt = shell.latestRunStartedAt ?? shell.activityRunStartedAt;
  if (startedAt != null && minutesSince(startedAt, now) >= thresholds.maxRunMinutes) {
    signals.push({
      kind: "long_running",
      detail: `This run has taken ${Math.round(minutesSince(startedAt, now))} minutes.`,
    });
  }

  const request = shell.pendingRuntimeRequest;
  if (request !== null) {
    if (
      request.blocking !== false &&
      minutesSince(request.createdAt, now) >= thresholds.waitingMinutes
    ) {
      signals.push({
        kind: "long_wait",
        detail: `It has waited ${Math.round(minutesSince(request.createdAt, now))} minutes on a ${request.kind} request.`,
      });
    }
  } else if (shell.blockedOnThreadWait === true) {
    signals.push({ kind: "child_blocking", detail: "It is waiting on another thread." });
  } else if (minutesSince(shell.updatedAt, now) >= thresholds.silenceMinutes) {
    signals.push({
      kind: "silent",
      detail: `Nothing has happened for ${Math.round(minutesSince(shell.updatedAt, now))} minutes.`,
    });
  }

  const actions = input.items.filter(
    (item) => isActionItem(item) && item.runId === shell.activeRunId,
  ) as ReadonlyArray<ActionItem>;
  const repeats = trailingRepeats(actions.map(actionFingerprint));
  if (repeats >= thresholds.repeatedActionLimit) {
    signals.push({ kind: "loop", detail: `It has repeated the same action ${repeats} times.` });
  }

  if (input.attempts >= thresholds.retryLimit) {
    signals.push({ kind: "retries", detail: `This run has been retried ${input.attempts} times.` });
  }
  return signals;
};
