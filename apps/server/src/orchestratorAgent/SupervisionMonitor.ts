import {
  BackgroundTask,
  CommandId,
  isOrchestratorAgentThread,
  type OrchestrationV2ThreadShell,
  resolveThreadSupervisionMode,
  RunId,
  OrchestratorMcpFailure,
  ProjectId,
  type ServerSettings as ServerSettingsValue,
  type SupervisionMode,
  type SupervisionResolvedThreadState,
  type SupervisionSetThreadInput,
  SupervisionThreadState,
  type SupervisionThresholds,
  supervisionThresholdsFor,
  ThreadId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestratorAgent from "./OrchestratorAgent.ts";
import {
  ACTION_ITEM_TYPES,
  computeSignals,
  ownerIsPresent,
  type SupervisionSignal,
} from "./supervisionSignals.ts";

/** Aggressive threads get a second pass halfway through each full one. */
const HALF_TICK = "30 seconds";
const RECENT_ITEM_LIMIT = 60;

const StateJson = Schema.fromJsonString(SupervisionThreadState);
const decodeTask = Schema.decodeUnknownOption(Schema.fromJsonString(BackgroundTask));
const decodeState = Schema.decodeUnknownOption(StateJson);
const encodeState = Schema.encodeSync(StateJson);

const INITIAL: SupervisionThreadState = {
  mode: null,
  reviews: 0,
  lastReviewAt: null,
  snoozedUntil: null,
  runId: null,
  escalatedAt: null,
};

export class SupervisionMonitor extends Context.Service<
  SupervisionMonitor,
  {
    readonly threadState: (threadId: ThreadId) => Effect.Effect<SupervisionResolvedThreadState>;
    /** "off" is also what "let it run" means; null clears the thread's choice. */
    readonly setThreadMode: (input: SupervisionSetThreadInput) => Effect.Effect<void>;
    /** Records the review's verdict: leave it, snoozed, or tell the owner. */
    readonly decide: (input: {
      readonly threadId: ThreadId;
      readonly decision: "leave" | "escalate";
      readonly note: string;
      readonly snoozeMinutes?: number | undefined;
    }) => Effect.Effect<void>;
    readonly governIntervention: <A, E, R>(
      target: ThreadId | { readonly backgroundTaskId: string },
      run: Effect.Effect<A, E, R>,
      expectedRunId?: RunId,
    ) => Effect.Effect<A, E | OrchestratorMcpFailure, R>;
    readonly status: Effect.Effect<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly mode: SupervisionMode;
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
  const serverSettings = yield* ServerSettings.ServerSettingsService;

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

  const unattended = sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId" FROM scheduled_task_runs WHERE finished_at IS NULL AND thread_id IS NOT NULL
    UNION SELECT thread_id AS "threadId" FROM background_tasks WHERE state IN ('running', 'needs_input')
    UNION SELECT json_extract(task_json, '$.childThreadId') AS "threadId" FROM background_tasks
      WHERE state IN ('running', 'needs_input') AND json_extract(task_json, '$.childThreadId') IS NOT NULL
    UNION SELECT json_extract(member.value, '$.threadId') AS "threadId"
      FROM teamwork_runs, json_each(run_json, '$.members') AS member
      WHERE json_extract(run_json, '$.status') = 'running' AND json_extract(member.value, '$.threadId') IS NOT NULL
  `.pipe(
    Effect.orDie,
    Effect.map((rows) => new Set(rows.map((row) => ThreadId.make(row.threadId)))),
  );

  const running = sql<{ readonly threadId: string }>`
    SELECT DISTINCT thread_id AS "threadId" FROM orchestration_v2_projection_runs
    WHERE status IN ('preparing', 'starting', 'running', 'waiting')
  `.pipe(
    Effect.orDie,
    Effect.map((rows) => rows.map((row) => ThreadId.make(row.threadId))),
  );

  const interventions = yield* Semaphore.make(1);

  const stateFor = (threadId: ThreadId) => states.get(threadId) ?? INITIAL;
  const settings = serverSettings.getSettings.pipe(Effect.orDie);

  const publishThreadModes = Effect.suspend(() =>
    agent.setSupervisionThreadModes(
      Object.fromEntries(
        [...states].flatMap(([threadId, { mode }]) =>
          mode === null ? [] : [[threadId, mode] as const],
        ),
      ),
    ),
  );
  yield* publishThreadModes;

  const modeOf = (shell: OrchestrationV2ThreadShell, current: ServerSettingsValue) =>
    resolveThreadSupervisionMode(current, shell.projectId, stateFor(shell.id).mode).mode;

  /** Provider subagents answer to their parent, so they are watched only as unattended work. */
  const watchable = (shell: OrchestrationV2ThreadShell, unattendedWork: ReadonlySet<ThreadId>) =>
    shell.deletedAt === null &&
    !isOrchestratorAgentThread(shell) &&
    (shell.lineage.relationshipToParent !== "subagent" || unattendedWork.has(shell.id));

  const watchedThreads = Effect.gen(function* () {
    const automatic = yield* unattended;
    const candidates = new Set([...(yield* running), ...automatic]);
    const current = yield* settings;
    const watched: Array<{
      readonly shell: OrchestrationV2ThreadShell;
      readonly mode: Exclude<SupervisionMode, "off">;
    }> = [];
    for (const threadId of candidates) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || !watchable(shell, automatic)) continue;
      const mode = modeOf(shell, current);
      if (mode !== "off") watched.push({ shell, mode });
    }
    return watched;
  });

  const THREAD_MODE_ACTIONS: Record<SupervisionMode, string> = {
    off: "thread.let-run",
    modest: "thread.watch",
    aggressive: "thread.watch-aggressive",
  };

  const setThreadMode: SupervisionMonitor["Service"]["setThreadMode"] = Effect.fn(
    "SupervisionMonitor.setThreadMode",
  )(function* (input) {
    yield* save(input.threadId, { ...stateFor(input.threadId), mode: input.mode });
    yield* publishThreadModes;
    yield* audit.record({
      actor: "user",
      domain: "supervision",
      action: input.mode === null ? "thread.follow-default" : THREAD_MODE_ACTIONS[input.mode],
      outcome: "succeeded",
      threadId: input.threadId,
    });
  }, interventions.withPermits(1));

  const auditSettingsChange = Effect.fn("SupervisionMonitor.auditSettingsChange")(function* (
    previous: ServerSettingsValue,
    next: ServerSettingsValue,
  ) {
    if (previous.supervisionMode !== next.supervisionMode) {
      yield* audit.record({
        actor: "user",
        domain: "supervision",
        action: `default.${next.supervisionMode}`,
        outcome: "succeeded",
      });
    }
    const projects = new Set([
      ...Object.keys(previous.projectSettingsOverrides),
      ...Object.keys(next.projectSettingsOverrides),
    ]);
    for (const key of projects) {
      const projectId = ProjectId.make(key);
      const before = previous.projectSettingsOverrides[projectId]?.supervisionMode;
      const after = next.projectSettingsOverrides[projectId]?.supervisionMode;
      if (before === after) continue;
      yield* audit.record({
        actor: "user",
        domain: "supervision",
        action: after === undefined ? "project.clear" : `project.${after}`,
        outcome: "succeeded",
        target: { kind: "project", id: projectId },
      });
    }
  });

  const lastSettings = yield* Ref.make(yield* settings);
  yield* serverSettings.streamChanges.pipe(
    Stream.runForEach((next) =>
      Ref.getAndSet(lastSettings, next).pipe(
        Effect.flatMap((previous) => auditSettingsChange(previous, next)),
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Could not audit a supervision change", cause)),
    Effect.forkScoped,
  );

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
        const aggressive = shell !== null && modeOf(shell, yield* settings) === "aggressive";
        const snapshot = aggressive ? yield* agent.snapshot.pipe(Effect.option) : Option.none();
        // A long snooze would undo what aggressive is for: staying on top of the thread.
        const minutes = Option.match(snapshot, {
          onNone: () => input.snoozeMinutes!,
          onSome: ({ thresholds }) =>
            Math.min(
              input.snoozeMinutes!,
              supervisionThresholdsFor("aggressive", thresholds).silenceMinutes,
            ),
        });
        const until = DateTime.add(yield* DateTime.now, { minutes });
        yield* save(input.threadId, {
          ...stateFor(input.threadId),
          snoozedUntil: DateTime.formatIso(until),
        });
      }
    },
    interventions.withPermits(1),
  );

  const reviewPrompt = (
    shell: OrchestrationV2ThreadShell,
    signals: ReadonlyArray<SupervisionSignal>,
    mode: Exclude<SupervisionMode, "off">,
    backgroundTaskId?: string,
  ) =>
    [
      `Supervision: ${formatThreadLink({ environmentId, threadId: shell.id })} may be stuck.`,
      ...signals.map((signal) => `- ${signal.kind}: ${signal.detail}`),
      ...(backgroundTaskId === undefined
        ? []
        : [
            `The parent is idle; inspect background task ${backgroundTaskId} with background_task_log before deciding what to do.`,
          ]),
      "",
      mode === "aggressive"
        ? "The owner chose aggressive supervision for this conversation. Read its recent activity with t3_thread_read (view: activity). Unless progress is clear, step in now: give its agent specific direction with t3_thread_send, or answer what it is blocked on. Leave it only when it is clearly progressing, escalate to the owner when you cannot unblock it, and interrupt or stop it only when it is looping or doing harm. End by calling supervision_decide unless you sent it a message."
        : "Read its recent activity with t3_thread_read (view: activity) and judge whether it is making progress, waiting on something legitimate, stuck, or looping. In order of preference: leave it, talk to its agent with t3_thread_send, help directly by answering what it is blocked on, escalate to the owner, or interrupt or stop it. End by calling supervision_decide unless you sent it a message.",
    ].join("\n");

  const superviseThread = Effect.fn("SupervisionMonitor.superviseThread")(function* (
    actual: OrchestrationV2ThreadShell,
    mode: Exclude<SupervisionMode, "off">,
    base: SupervisionThresholds,
  ) {
    const threadId = actual.id;
    const state = stateFor(threadId);
    const thresholds = supervisionThresholdsFor(mode, base);
    const backgroundRows =
      actual.activeRunId !== null
        ? []
        : yield* sql<{
            readonly json: string;
          }>`SELECT task_json AS json FROM background_tasks WHERE thread_id = ${threadId} AND state = 'running' ORDER BY started_at`.pipe(
            Effect.orDie,
          );
    const background = backgroundRows
      .flatMap((row) => Option.toArray(decodeTask(row.json)))
      .find((task) => task.kind === "command");
    const shell =
      actual.activeRunId !== null || background === undefined
        ? actual
        : {
            ...actual,
            activeRunId: RunId.make(`background:${background.id}`),
            latestRunStartedAt: DateTime.makeUnsafe(background.startedAt),
            updatedAt: DateTime.makeUnsafe(background.updatedAt),
            pendingRuntimeRequest: null,
          };
    if (shell.activeRunId === null) return;
    const current: SupervisionThreadState =
      state.runId === shell.activeRunId
        ? state
        : {
            ...state,
            runId: shell.activeRunId as RunId,
            reviews: 0,
            nudges: 0,
            lastReviewAt: null,
            lastNudgeAt: null,
            escalatedAt: null,
          };
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

    if ((current.nudges ?? 0) >= thresholds.nudgeCap) {
      if (current.escalatedAt === null) {
        yield* escalate(
          shell,
          `${shell.title} still looks stuck after ${current.nudges ?? 0} nudges: ${signals[0]?.detail ?? ""}`,
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
    yield* agent.review(reviewPrompt(shell, signals, mode, background?.id), {
      threadId,
      runId: shell.activeRunId,
    });
  }, interventions.withPermits(1));

  const governIntervention: SupervisionMonitor["Service"]["governIntervention"] = Effect.fn(
    "SupervisionMonitor.governIntervention",
  )(function* (target, run, expectedRunId) {
    const threadId =
      typeof target === "string"
        ? target
        : (yield* sql<{
            threadId: ThreadId;
          }>`SELECT thread_id AS "threadId" FROM background_tasks WHERE id = ${target.backgroundTaskId}`.pipe(
            Effect.orDie,
          ))[0]?.threadId;
    if (threadId === undefined)
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "That background task no longer exists.",
      });
    yield* interventions.withPermits(1)(
      Effect.gen(function* () {
        const state = states.get(threadId);
        if (
          state === undefined ||
          state.reviews === 0 ||
          (expectedRunId !== undefined && expectedRunId !== state.runId)
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "The reviewed run has ended or changed.",
          });
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        const mode = resolveThreadSupervisionMode(
          yield* settings,
          shell?.projectId,
          state.mode,
        ).mode;
        const backgroundRun =
          shell?.activeRunId == null
            ? (yield* sql<{
                id: string;
              }>`SELECT id FROM background_tasks WHERE thread_id = ${threadId} AND state = 'running' AND json_extract(task_json, '$.kind') = 'command' ORDER BY started_at LIMIT 1`.pipe(
                Effect.orDie,
              ))[0]
            : undefined;
        const runId =
          shell?.activeRunId ??
          (backgroundRun === undefined ? null : `background:${backgroundRun.id}`);
        const snapshot = yield* agent.snapshot.pipe(Effect.orDie);
        const now = yield* DateTime.now;
        const nowMs = DateTime.toEpochMillis(now);
        const thresholds = supervisionThresholdsFor(mode, snapshot.thresholds);
        const reason =
          mode === "off"
            ? "The owner chose let it run."
            : shell === null || runId !== state.runId
              ? "The reviewed run has ended or changed."
              : ownerIsPresent(shell, now)
                ? "The owner is present."
                : snapshot.supervision.status !== "active"
                  ? snapshot.supervision.reason
                  : state.snoozedUntil !== null && Date.parse(state.snoozedUntil) > nowMs
                    ? "Supervision is snoozed."
                    : state.lastNudgeAt != null &&
                        nowMs - Date.parse(state.lastNudgeAt) < thresholds.cooldownMinutes * 60_000
                      ? "The supervision nudge cooldown is active."
                      : (state.nudges ?? 0) >= thresholds.nudgeCap
                        ? "The supervision nudge cap was reached."
                        : null;
        if (reason !== null)
          return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: reason });
        // Reserve before dispatch: failures may have applied a partial side effect.
        yield* save(threadId, {
          ...state,
          nudges: (state.nudges ?? 0) + 1,
          lastNudgeAt: DateTime.formatIso(now),
        });
        yield* audit.record({
          actor: "orchestrator",
          domain: "supervision",
          action: "nudge",
          outcome: "pending",
          threadId,
        });
      }),
    );
    return yield* run;
  });

  let aggressiveThreads = false;

  const pass = Effect.fn("SupervisionMonitor.tick")(
    function* (scope: "all" | "aggressive") {
      if (scope === "all") yield* agent.checkOrchestrator;
      const watched = yield* watchedThreads;
      aggressiveThreads = watched.some(({ mode }) => mode === "aggressive");
      yield* agent.setWatching(watched.length);
      if (watched.length === 0) return;
      const snapshot = yield* agent.snapshot.pipe(Effect.option);
      // Paused, and the snapshot says why; no model runs while the brain is unavailable.
      if (Option.isNone(snapshot) || snapshot.value.supervision.status !== "active") return;
      for (const { shell, mode } of watched) {
        if (scope === "all" || mode === "aggressive") {
          yield* superviseThread(shell, mode, snapshot.value.thresholds);
        }
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("A supervision pass failed", cause)),
  );

  const tick = pass("all");

  yield* tick.pipe(
    Effect.andThen(Effect.sleep(HALF_TICK)),
    Effect.andThen(Effect.suspend(() => (aggressiveThreads ? pass("aggressive") : Effect.void))),
    Effect.andThen(Effect.sleep(HALF_TICK)),
    Effect.forever,
    Effect.forkScoped,
  );

  return SupervisionMonitor.of({
    threadState: Effect.fn("SupervisionMonitor.threadState")(function* (threadId) {
      const state = stateFor(threadId);
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const { mode, source } = resolveThreadSupervisionMode(
        yield* settings,
        shell?.projectId,
        state.mode,
      );
      return { ...state, effectiveMode: mode, modeSource: source };
    }),
    setThreadMode,
    decide,
    governIntervention,
    status: watchedThreads.pipe(
      Effect.map((watched) =>
        watched.map(({ shell, mode }) => ({
          threadId: shell.id,
          mode,
          state: stateFor(shell.id),
        })),
      ),
    ),
    tick,
  });
});

export const layer = Layer.effect(SupervisionMonitor, make);
