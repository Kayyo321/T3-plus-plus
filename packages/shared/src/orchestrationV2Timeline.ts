import type {
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunId,
  TurnItemId,
} from "@t3tools/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status">;
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId"> & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export interface ForkHistoryCut {
  /** Rolled-back runs a rewind branch still shows. */
  readonly keepRunIds?: ReadonlyArray<RunId> | undefined;
  /** The fork point inside its run, when the fork cuts that run short. */
  readonly throughTurnItemId?: TurnItemId | undefined;
}

export function forkHistoryRows<
  Item extends Pick<OrchestrationV2TurnItem, "id" | "runId" | "ordinal">,
>(
  items: ReadonlyArray<Item>,
  throughRun: Pick<OrchestrationV2Run, "id">,
  cut: Pick<ForkHistoryCut, "throughTurnItemId">,
): ReadonlyArray<Item> {
  const through =
    cut.throughTurnItemId === undefined
      ? undefined
      : items.find((item) => item.id === cut.throughTurnItemId);
  return through === undefined
    ? items
    : items.filter((item) => item.runId !== throughRun.id || item.ordinal <= through.ordinal);
}

/** A rewind branch shows the runs it took from its source as ordinary history. */
export function restoreKeptRuns<Run extends Pick<OrchestrationV2Run, "id" | "status">>(
  runs: ReadonlyArray<Run>,
  keepRunIds: ForkHistoryCut["keepRunIds"],
): ReadonlyArray<Run> {
  if (keepRunIds === undefined || keepRunIds.length === 0) return runs;
  const kept = new Set(keepRunIds);
  return runs.map((run) => (kept.has(run.id) ? { ...run, status: "completed" } : run));
}

export function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }

  // Show paired stop-then-steer results; hide legacy plain-steer results without matching requests.
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }

  // Cancelled queued input never reached the provider and must stay out of the transcript.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "cancelled")
  ) {
    return false;
  }

  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}

export function createOrchestrationV2TurnItemVisibility(input: {
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): (item: TimelineTurnItem) => boolean {
  const statuses = new Map(input.runs.map((run) => [run.id, run.status]));
  const supersededRoots = new Map<
    TimelineRunAttempt["runId"],
    Set<TimelineRunAttempt["rootNodeId"]>
  >();
  for (const attempt of input.attempts) {
    if (attempt.status !== "superseded") continue;
    let roots = supersededRoots.get(attempt.runId);
    if (roots === undefined) supersededRoots.set(attempt.runId, (roots = new Set()));
    roots.add(attempt.rootNodeId);
  }
  const interruptRuns = new Set(
    input.items.filter((item) => item.type === "run_interrupt_request").map((item) => item.runId),
  );
  return (item) => {
    const status = item.runId === null ? undefined : statuses.get(item.runId);
    if (status === "rolled_back") return false;
    if (
      status === "cancelled" &&
      item.type === "user_message" &&
      item.inputIntent === "queued_turn"
    )
      return false;
    return !(
      item.type === "run_interrupt_result" &&
      item.runId !== null &&
      item.nodeId !== null &&
      supersededRoots.get(item.runId)?.has(item.nodeId) === true &&
      !interruptRuns.has(item.runId)
    );
  };
}
