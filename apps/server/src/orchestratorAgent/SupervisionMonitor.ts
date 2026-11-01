import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type RunId,
  type SupervisionSetThreadInput,
  SupervisionThreadState,
  type SupervisionThresholds,
  ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestratorAgent from "./OrchestratorAgent.ts";
import {
  ACTION_ITEM_TYPES,
  computeSignals,
  ownerIsPresent,
  type SupervisionSignal,
} from "./supervisionSignals.ts";

const TICK = "1 minute";
const RECENT_ITEM_LIMIT = 60;

const StateJson = Schema.fromJsonString(SupervisionThreadState);
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeSync(StateJson);

const OFF: SupervisionThreadState = {
  mode: "off",
  reviews: 0,
  lastReviewAt: null,
  snoozedUntil: null,
  runId: null,
  escalatedAt: null,
};

export class SupervisionMonitor extends Context.Service<
  SupervisionMonitor,
  {
    readonly threadState: (threadId: ThreadId) => Effect.Effect<SupervisionThreadState>;
    /** "off" is also what "let it run" means. */
    readonly setThreadMode: (input: SupervisionSetThreadInput) => Effect.Effect<void>;
    /** Records the review's verdict: leave it, snoozed, or tell the owner. */
    readonly decide: (input: {
      readonly threadId: ThreadId;
      readonly decision: "leave" | "escalate";
      readonly note: string;
      readonly snoozeMinutes?: number | undefined;
    }) => Effect.Effect<void>;
    readonly status: Effect.Effect<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly state: SupervisionThreadState;
      }>
    >;
    /** One pass over every watched thread. The loop calls this; tests can too. */
    readonly tick: Effect.Effect<void>;
  }
>()("t3pp/orchestratorAgent/SupervisionMonitor") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const agent = yield* OrchestratorAgent.OrchestratorAgent;
  const audit = yield* AuditTrail.AuditTrail;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;

  const rows = yield* sql<{ readonly threadId: string; readonly stateJson: string }>`
    SELECT thread_id AS "threadId", state_json AS "stateJson" FROM supervision_thread_state
  `.pipe(Effect.orDie);
  const states = new Map(
    rows.flatMap((row) =>
      Option.toArray(decodeState(row.stateJson)).map(
        (state) => [ThreadId.make(row.threadId), state] as const,
      ),
    ),
  );

  const save = (threadId: ThreadId, state: SupervisionThreadState) =>
    Effect.suspend(() => {
      states.set(threadId, state);
      const stateJson = encodeState(state);
      return sql`
        INSERT INTO supervision_thread_state (thread_id, state_json)
        VALUES (${threadId}, ${stateJson})
        ON CONFLICT (thread_id) DO UPDATE SET state_json = excluded.state_json
      `.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save a supervision state", cause),
        ),
      );
    });

  const stateFor = (threadId: ThreadId) => states.get(threadId) ?? OFF;

  const setThreadMode: SupervisionMonitor["Service"]["setThreadMode"] = Effect.fn(
    "SupervisionMonitor.setThreadMode",
  )(function* (input) {
    yield* save(input.threadId, { ...stateFor(input.threadId), mode: input.mode });
    yield* audit.record({
      actor: "user",
      domain: "supervision",
      action: input.mode === "on" ? "thread.watch" : "thread.let-run",
      outcome: "succeeded",
      threadId: input.threadId,
    });
  });

  const escalate = Effect.fn("SupervisionMonitor.escalate")(function* (
    shell: OrchestrationV2ThreadShell,
    message: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* save(shell.id, { ...stateFor(shell.id), escalatedAt: now });
    yield* threads
      .dispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make(`server:supervision:escalate:${yield* uuid}`),
        threadId: shell.id,
      })
      .pipe(Effect.ignore);
    yield* agent.directive({ type: "escalate", threadId: shell.id, message });
    yield* audit.record({
      actor: "orchestrator",
      domain: "supervision",
      action: "escalate",
      outcome: "succeeded",
      threadId: shell.id,
      reasoning: message,
    });
  });

  const decide: SupervisionMonitor["Service"]["decide"] = Effect.fn("SupervisionMonitor.decide")(
    function* (input) {
      const shell = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      yield* audit.record({
        actor: "orchestrator",
        domain: "supervision",
        action: `review.${input.decision}`,
        outcome: "succeeded",
        threadId: input.threadId,
        reasoning: input.note,
      });
      if (input.decision === "escalate" && shell !== null) {
        return yield* escalate(shell, input.note);
      }
      if (input.snoozeMinutes !== undefined) {
        const until = DateTime.add(yield* DateTime.now, { minutes: input.snoozeMinutes });
        yield* save(input.threadId, {
          ...stateFor(input.threadId),
          snoozedUntil: DateTime.formatIso(until),
        });
      }
    },
  );

  const reviewPrompt = (
    shell: OrchestrationV2ThreadShell,
    signals: ReadonlyArray<SupervisionSignal>,
  ) =>
    [
      `Supervision: ${formatThreadLink({ environmentId, threadId: shell.id })} may be stuck.`,
      ...signals.map((signal) => `- ${signal.kind}: ${signal.detail}`),
      "",
      "Read its recent activity with t3_thread_read (view: activity) and judge whether it is making progress, waiting on something legitimate, stuck, or looping. In order of preference: leave it, talk to its agent with t3_thread_send, help directly by answering what it is blocked on, escalate to the owner, or interrupt or stop it. End by calling supervision_decide unless you sent it a message.",
    ].join("\n");

  const superviseThread = Effect.fn("SupervisionMonitor.superviseThread")(function* (
    threadId: ThreadId,
    state: SupervisionThreadState,
    thresholds: SupervisionThresholds,
  ) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.activeRunId === null) return;
    const current: SupervisionThreadState =
      state.runId === shell.activeRunId
        ? state
        : { ...state, runId: shell.activeRunId as RunId, reviews: 0, escalatedAt: null };
    if (current !== state) yield* save(threadId, current);

    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (ownerIsPresent(shell, now)) return;
    if (current.snoozedUntil !== null && Date.parse(current.snoozedUntil) > nowMs) return;
    if (
      current.lastReviewAt !== null &&
      nowMs - Date.parse(current.lastReviewAt) < thresholds.cooldownMinutes * 60_000
    ) {
      return;
    }

    const records = yield* threads
      .getThreadRecords(threadId, ["turnItems", "attempts"], {
        turnItemTypes: [...ACTION_ITEM_TYPES],
        messageRoles: [],
      })
      .pipe(Effect.option);
    if (Option.isNone(records)) return;
    const { turnItems, attempts } = records.value;
    const signals = computeSignals({
      shell,
      items: turnItems.slice(-RECENT_ITEM_LIMIT),
      attempts: attempts.filter((attempt) => attempt.runId === shell.activeRunId).length,
      thresholds,
      now,
    });
    if (signals.length === 0) return;

    if (current.reviews >= thresholds.nudgeCap) {
      if (current.escalatedAt === null) {
        yield* escalate(
          shell,
          `${shell.title} still looks stuck after ${current.reviews} reviews: ${signals[0]?.detail ?? ""}`,
        );
      }
      return;
    }
    yield* save(threadId, {
      ...current,
      reviews: current.reviews + 1,
      lastReviewAt: DateTime.formatIso(now),
    });
    yield* audit.record({
      actor: "orchestrator",
      domain: "supervision",
      action: "review.start",
      outcome: "pending",
      threadId,
      request: signals.map((signal) => `${signal.kind}: ${signal.detail}`).join("; "),
    });
    yield* agent.review(reviewPrompt(shell, signals));
  });

  const tick: SupervisionMonitor["Service"]["tick"] = Effect.gen(function* () {
    const watched = [...states].filter(([, state]) => state.mode === "on");
    yield* agent.setWatching(watched.length);
    if (watched.length === 0) return;
    const snapshot = yield* agent.snapshot.pipe(Effect.option);
    // Paused, and the snapshot says why; no model runs while the brain is unavailable.
    if (Option.isNone(snapshot) || snapshot.value.supervision.status !== "active") return;
    for (const [threadId, state] of watched) {
      yield* superviseThread(threadId, state, snapshot.value.thresholds);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("A supervision pass failed", cause)),
    Effect.withSpan("SupervisionMonitor.tick"),
  );

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK)), Effect.forkScoped);

  return SupervisionMonitor.of({
    threadState: Effect.fn("SupervisionMonitor.threadState")(function* (threadId) {
      return stateFor(threadId);
    }),
    setThreadMode,
    decide,
    status: Effect.sync(() =>
      [...states]
        .filter(([, state]) => state.mode === "on")
        .map(([threadId, state]) => ({ threadId, state })),
    ),
    tick,
  });
});

export const layer = Layer.effect(SupervisionMonitor, make);
