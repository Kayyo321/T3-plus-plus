import {
  BACKGROUND_TASK_LAST_LINE_MAX_CHARS,
  BACKGROUND_TASK_LIST_MAX,
  BACKGROUND_TASK_LOG_PAGE_MAX_BYTES,
  BackgroundTask,
  BackgroundTaskError,
  BackgroundTaskId,
  type BackgroundTaskListInput,
  type BackgroundTaskListResult,
  type BackgroundTaskLogInput,
  type BackgroundTaskLogResult,
  type BackgroundTaskRefInput,
  type BackgroundTaskStartInput,
  type BackgroundTaskState,
  type BackgroundTaskStreamItem,
  CommandId,
  isBackgroundTaskLive,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerConfig from "../config.ts";
import type { DispatchActor } from "../orchestration-v2/NestedSessionService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import { makeBoundedLog, readBoundedLogTail } from "./BoundedLog.ts";

const LINE_PUBLISH_INTERVAL_MS = 1_000;
const FINISHED_TASKS_KEPT = 100;
const STOP_GRACE = "3 seconds";
const ANSI_ESCAPES = new RegExp(String.raw`\u001b\[[0-9;?]*[ -/]*[@-~]`, "g");

const decodeTask = Schema.decodeUnknownOption(Schema.fromJsonString(BackgroundTask));
const encodeTask = Schema.encodeSync(Schema.fromJsonString(BackgroundTask));

const failed = (detail: string) => new BackgroundTaskError({ reason: "failed", detail });
const notFound = (id: string) =>
  new BackgroundTaskError({
    reason: "not-found",
    detail: `Background task ${id} no longer exists.`,
  });

/** The last complete-looking line of a chunk, or null when it held only whitespace. */
export function lastOutputLine(text: string): string | null {
  const line = text
    .replace(ANSI_ESCAPES, "")
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.trim())
    .findLast((candidate) => candidate.length > 0);
  return line === undefined ? null : line.slice(0, BACKGROUND_TASK_LAST_LINE_MAX_CHARS);
}

/** A nested session's task only reflects its thread: what the shell says is what is true. */
export function nestedSessionTaskState(
  shell: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "pendingRuntimeRequest" | "status">,
): BackgroundTaskState {
  if (shell.pendingRuntimeRequest !== null) return "needs_input";
  if (shell.activityRunStatus != null) return "running";
  switch (shell.status) {
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "stopped";
    case "completed":
    case "idle":
      return "succeeded";
    default:
      return "running";
  }
}

function endingNotification(task: BackgroundTask): OrchestrationV2Notification | null {
  const source = {
    kind: "handoff" as const,
    backgroundTaskId: task.id,
    ...(task.childThreadId === null ? {} : { childThreadId: task.childThreadId }),
  };
  const detail = task.lastOutputLine === null ? {} : { detail: task.lastOutputLine };
  switch (task.state) {
    case "running":
      return null;
    case "needs_input":
      return {
        source,
        outcome: "updated",
        summary: `${task.name} needs your input`,
        ...detail,
      };
    case "succeeded":
      return { source, outcome: "completed", summary: `${task.name} finished`, ...detail };
    case "failed":
      return {
        source,
        outcome: "failed",
        summary:
          task.exitCode === null
            ? `${task.name} failed`
            : `${task.name} failed with exit code ${task.exitCode}`,
        ...detail,
      };
    case "stopped":
      return { source, outcome: "cancelled", summary: `${task.name} was stopped`, ...detail };
    case "lost":
      return {
        source,
        outcome: "unknown",
        summary: `${task.name} did not survive a server restart`,
        ...detail,
      };
  }
}

export class BackgroundTaskService extends Context.Service<
  BackgroundTaskService,
  {
    readonly start: (
      input: BackgroundTaskStartInput,
      actor: DispatchActor,
    ) => Effect.Effect<BackgroundTask, BackgroundTaskError>;
    readonly stop: (
      input: BackgroundTaskRefInput,
      actor: DispatchActor,
    ) => Effect.Effect<BackgroundTask, BackgroundTaskError>;
    /** Forgets a finished task and deletes its log. */
    readonly remove: (
      input: BackgroundTaskRefInput,
      actor: DispatchActor,
    ) => Effect.Effect<void, BackgroundTaskError>;
    readonly list: (
      input: BackgroundTaskListInput,
    ) => Effect.Effect<BackgroundTaskListResult, BackgroundTaskError>;
    readonly readLog: (
      input: BackgroundTaskLogInput,
    ) => Effect.Effect<BackgroundTaskLogResult, BackgroundTaskError>;
    /** The current list, then changes to it. */
    readonly stream: Stream.Stream<BackgroundTaskStreamItem, BackgroundTaskError>;
  }
>()("t3pp/backgroundTasks/BackgroundTaskService") {}

interface RunningProcess {
  readonly stopRequested: { value: boolean };
  readonly kill: Effect.Effect<void>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const audit = yield* AuditTrail.AuditTrail;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcess.Platform;
  const randomId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const scope = yield* Effect.scope;
  const changes = yield* PubSub.sliding<BackgroundTaskStreamItem>(256);
  const processes = new Map<BackgroundTaskId, RunningProcess>();
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const logDir = (id: BackgroundTaskId) => path.join(config.stateDir, "background-tasks", id);

  const save = Effect.fn("BackgroundTaskService.save")(function* (task: BackgroundTask) {
    yield* sql`
      INSERT INTO background_tasks ${sql.insert({
        id: task.id,
        thread_id: task.threadId,
        state: task.state,
        started_at: task.startedAt,
        task_json: encodeTask(task),
      })}
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, task_json = excluded.task_json
    `;
  });

  const read = Effect.fn("BackgroundTaskService.read")(function* (id: BackgroundTaskId) {
    const rows = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM background_tasks WHERE id = ${id}
    `;
    return rows[0] === undefined ? Option.none() : decodeTask(rows[0].taskJson);
  });

  const readAll = Effect.fn("BackgroundTaskService.readAll")(function* (threadId?: ThreadId) {
    const rows = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM background_tasks
      ${threadId === undefined ? sql`` : sql`WHERE thread_id = ${threadId}`}
      ORDER BY started_at DESC
      LIMIT ${BACKGROUND_TASK_LIST_MAX}
    `;
    return rows.flatMap((row) => Option.toArray(decodeTask(row.taskJson)));
  });

  const publish = (item: BackgroundTaskStreamItem) => PubSub.publish(changes, item);

  const postCard = Effect.fn("BackgroundTaskService.postCard")(function* (task: BackgroundTask) {
    const notification = endingNotification(task);
    if (notification === null) return;
    const id = yield* randomId;
    const wakes = task.resumeAgent && !isBackgroundTaskLive(task.state);
    yield* orchestrator
      .dispatch({
        type: "thread.handoff-card.post",
        commandId: CommandId.make(`command:background-task-card:${id}`),
        threadId: task.threadId,
        notification,
        ...(wakes
          ? {
              wake: {
                messageId: MessageId.make(`message:background-task-card:${id}`),
                text: [
                  `Background task "${task.name}" ended: ${notification.summary}.`,
                  `Read its log with background_task_log (task ${task.id}).`,
                ].join(" "),
              },
            }
          : {}),
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not post a background task card", { id: task.id, cause }),
        ),
      );
  });

  const prune = Effect.fn("BackgroundTaskService.prune")(function* () {
    const stale = yield* sql<{ readonly id: BackgroundTaskId }>`
      SELECT id FROM background_tasks
      WHERE state NOT IN ('running', 'needs_input')
      ORDER BY started_at DESC
      LIMIT -1 OFFSET ${FINISHED_TASKS_KEPT}
    `;
    for (const { id } of stale) {
      yield* sql`DELETE FROM background_tasks WHERE id = ${id}`;
      yield* fileSystem.remove(logDir(id), { recursive: true, force: true }).pipe(Effect.ignore);
      yield* publish({ type: "remove", id });
    }
  });

  /** The one way a task's state changes, so the card and the tray cannot disagree. */
  const transition = Effect.fn("BackgroundTaskService.transition")(function* (
    task: BackgroundTask,
    next: {
      readonly state: BackgroundTaskState;
      readonly exitCode?: number | null;
      readonly lastOutputLine?: string | null;
    },
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const updated: BackgroundTask = {
      ...task,
      ...next,
      endedAt: isBackgroundTaskLive(next.state) ? null : now,
      updatedAt: now,
    };
    yield* save(updated);
    yield* publish({ type: "upsert", task: updated });
    if (next.state !== task.state) {
      yield* postCard(updated);
      yield* audit.record({
        actor: "system",
        domain: "background-task",
        action: `background-task.${next.state}`,
        outcome: next.state === "failed" ? "failed" : "succeeded",
        threadId: task.threadId,
        target: { kind: "background-task", id: task.id, label: task.name },
      });
    }
    if (!isBackgroundTaskLive(next.state)) yield* prune();
    return updated;
  });

  const supervise = Effect.fn("BackgroundTaskService.supervise")(function* (
    initial: BackgroundTask,
    command: string,
    cwd: string,
  ) {
    const stopRequested = { value: false };
    let latestLine = initial.lastOutputLine;
    let publishedLine = latestLine;
    let publishedAt = 0;
    const log = yield* makeBoundedLog({ dir: logDir(initial.id) });
    const decoder = new TextDecoder();
    const shell = platform === "win32" ? "cmd.exe" : (process.env.SHELL ?? "/bin/sh");
    const code = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(shell, platform === "win32" ? ["/c", command] : ["-c", command], {
            cwd,
            stdin: "ignore",
            // Its own process group, so stopping a dev server takes its children with it.
            detached: platform !== "win32",
          }),
        );
        processes.set(initial.id, {
          stopRequested,
          kill: child.kill({ forceKillAfter: STOP_GRACE }).pipe(Effect.ignore),
        });
        yield* child.all.pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* log.append(chunk);
              const line = lastOutputLine(decoder.decode(chunk, { stream: true }));
              if (line === null) return;
              latestLine = line;
              const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
              if (line === publishedLine || nowMs - publishedAt < LINE_PUBLISH_INTERVAL_MS) return;
              publishedLine = line;
              publishedAt = nowMs;
              yield* publish({
                type: "upsert",
                task: { ...initial, lastOutputLine: line },
              });
            }),
          ),
          Effect.ignore,
        );
        return yield* child.exitCode;
      }),
    ).pipe(
      Effect.map((exit) => Number(exit)),
      Effect.catchCause((cause) =>
        Effect.logWarning("A background task could not run", { id: initial.id, cause }).pipe(
          Effect.as(null),
        ),
      ),
      Effect.ensuring(Effect.sync(() => processes.delete(initial.id))),
    );
    const latest = Option.getOrElse(yield* read(initial.id), () => initial);
    yield* transition(latest, {
      state: stopRequested.value ? "stopped" : code === 0 ? "succeeded" : "failed",
      exitCode: code,
      lastOutputLine: latestLine,
    });
  });

  const requireTask = Effect.fn("BackgroundTaskService.requireTask")(function* (
    id: BackgroundTaskId,
  ) {
    const task = yield* read(id).pipe(
      Effect.mapError(() => failed("The background task could not be read.")),
    );
    return Option.isSome(task) ? task.value : yield* notFound(id);
  });

  const threadShell = (threadId: ThreadId) =>
    orchestrator
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => failed("The conversation could not be read.")));

  const start: BackgroundTaskService["Service"]["start"] = Effect.fn("BackgroundTaskService.start")(
    function* (input, actor) {
      const shell = yield* threadShell(input.threadId);
      if (shell === null || shell.deletedAt !== null) {
        return yield* failed("That conversation no longer exists.");
      }
      if (shell.capabilityMode === "chat" && input.childThreadId === undefined) {
        return yield* new BackgroundTaskError({
          reason: "chat-mode",
          detail: "A Chat conversation cannot run commands.",
        });
      }
      if ((input.command === undefined) === (input.childThreadId === undefined)) {
        return yield* new BackgroundTaskError({
          reason: "invalid",
          detail: "A background task runs either a command or a nested session.",
        });
      }
      const project = yield* projects
        .get(shell.projectId)
        .pipe(Effect.mapError(() => failed("The conversation's project could not be read.")));
      const cwd = shell.worktreePath ?? Option.getOrUndefined(project)?.workspaceRoot ?? undefined;
      if (input.command !== undefined && cwd === undefined) {
        return yield* failed("The conversation has no folder to run in.");
      }
      const id = BackgroundTaskId.make(yield* randomId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const childShell =
        input.childThreadId === undefined ? null : yield* threadShell(input.childThreadId);
      const task: BackgroundTask = {
        id,
        threadId: input.threadId,
        kind: input.kind ?? (input.childThreadId === undefined ? "command" : "nested_session"),
        name:
          input.name ??
          childShell?.title ??
          input.command?.split("\n")[0]?.slice(0, 80) ??
          "Background task",
        command: input.command ?? null,
        cwd: cwd ?? null,
        childThreadId: input.childThreadId ?? null,
        state: "running",
        exitCode: null,
        lastOutputLine: null,
        resumeAgent: input.resumeAgent ?? false,
        startedAt: now,
        endedAt: null,
        updatedAt: now,
      };
      yield* save(task).pipe(
        Effect.mapError(() => failed("The background task could not be recorded.")),
      );
      yield* publish({ type: "upsert", task });
      yield* audit.record({
        actor: actor.kind,
        ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
        domain: "background-task",
        action: "background-task.start",
        outcome: "succeeded",
        threadId: input.threadId,
        target: { kind: "background-task", id, label: task.name },
        ...(input.command === undefined ? {} : { request: input.command }),
      });
      if (input.command !== undefined && cwd !== undefined) {
        yield* supervise(task, input.command, cwd).pipe(
          Effect.provide(context),
          Effect.catchCause((cause) =>
            Effect.logWarning("A background task ended badly", { id, cause }),
          ),
          Effect.forkIn(scope),
        );
      }
      return task;
    },
  );

  const stop: BackgroundTaskService["Service"]["stop"] = Effect.fn("BackgroundTaskService.stop")(
    function* (input, actor) {
      const task = yield* requireTask(input.id);
      if (!isBackgroundTaskLive(task.state)) return task;
      yield* audit.record({
        actor: actor.kind,
        ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
        domain: "background-task",
        action: "background-task.stop",
        outcome: "succeeded",
        threadId: task.threadId,
        target: { kind: "background-task", id: task.id, label: task.name },
      });
      const running = processes.get(task.id);
      if (running !== undefined) {
        running.stopRequested.value = true;
        yield* running.kill;
        return task;
      }
      if (task.childThreadId !== null) {
        yield* orchestrator
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`command:background-task-stop:${yield* randomId}`),
            threadId: task.childThreadId,
          })
          .pipe(Effect.catchCause(() => Effect.void));
      }
      return yield* transition(task, { state: "stopped" }).pipe(
        Effect.mapError(() => failed("The background task could not be stopped.")),
      );
    },
  );

  const remove: BackgroundTaskService["Service"]["remove"] = Effect.fn(
    "BackgroundTaskService.remove",
  )(function* (input, actor) {
    const task = yield* requireTask(input.id);
    if (isBackgroundTaskLive(task.state)) {
      return yield* new BackgroundTaskError({
        reason: "invalid",
        detail: "Stop this task before removing it.",
      });
    }
    yield* sql`DELETE FROM background_tasks WHERE id = ${input.id}`.pipe(
      Effect.mapError(() => failed("The background task could not be removed.")),
    );
    yield* fileSystem
      .remove(logDir(input.id), { recursive: true, force: true })
      .pipe(Effect.ignore);
    yield* publish({ type: "remove", id: input.id });
    yield* audit.record({
      actor: actor.kind,
      domain: "background-task",
      action: "background-task.remove",
      outcome: "succeeded",
      threadId: task.threadId,
      target: { kind: "background-task", id: task.id, label: task.name },
    });
  });

  const list: BackgroundTaskService["Service"]["list"] = (input) =>
    readAll(input.threadId).pipe(
      Effect.map((tasks) => ({ tasks })),
      Effect.mapError(() => failed("Background tasks could not be read.")),
    );

  const readLog: BackgroundTaskService["Service"]["readLog"] = Effect.fn(
    "BackgroundTaskService.readLog",
  )(function* (input) {
    const task = yield* requireTask(input.id);
    if (task.command === null) {
      return { id: input.id, text: "", truncated: false, logPath: null };
    }
    const dir = logDir(input.id);
    const { text, truncated } = yield* readBoundedLogTail({
      dir,
      tailBytes: Math.min(
        input.tailBytes ?? BACKGROUND_TASK_LOG_PAGE_MAX_BYTES,
        BACKGROUND_TASK_LOG_PAGE_MAX_BYTES,
      ),
    }).pipe(
      Effect.provide(context),
      Effect.mapError(() => failed("The background task's log could not be read.")),
    );
    return { id: input.id, text, truncated, logPath: path.join(dir, "output.log") };
  });

  const stream: BackgroundTaskService["Service"]["stream"] = Stream.unwrap(
    Effect.gen(function* () {
      const tasks = yield* readAll().pipe(
        Effect.mapError(() => failed("Background tasks could not be read.")),
      );
      return Stream.concat(
        Stream.make({ type: "snapshot" as const, tasks }),
        Stream.fromPubSub(changes),
      );
    }),
  );

  const followNestedSession = Effect.fn("BackgroundTaskService.followNestedSession")(function* (
    threadId: ThreadId,
  ) {
    const rows = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM background_tasks
      WHERE json_extract(task_json, '$.childThreadId') = ${threadId}
    `;
    const tasks = rows.flatMap((row) => Option.toArray(decodeTask(row.taskJson)));
    if (tasks.length === 0) return;
    const shell = yield* orchestrator.getThreadShell(threadId);
    if (shell === null) return;
    const state = nestedSessionTaskState(shell);
    for (const task of tasks) {
      if (task.state !== "stopped" && task.state !== state) yield* transition(task, { state });
    }
  });

  const stopThreadTasks = Effect.fn("BackgroundTaskService.stopThreadTasks")(function* (
    threadId: ThreadId,
  ) {
    const tasks = yield* readAll(threadId);
    yield* Effect.forEach(
      tasks.filter((task) => isBackgroundTaskLive(task.state)),
      (task) => {
        const running = processes.get(task.id);
        if (running === undefined) return transition(task, { state: "stopped" });
        running.stopRequested.value = true;
        return running.kill;
      },
      { discard: true },
    );
  });

  const onEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.archived":
      case "thread.deleted":
        return stopThreadTasks(event.threadId);
      case "run.updated":
      case "runtime-request.updated":
        return followNestedSession(event.threadId);
      default:
        return Effect.void;
    }
  };

  // Before the service is reachable: a process from the last run cannot be a task started now.
  const markLost = Effect.gen(function* () {
    const live = yield* sql<{ readonly taskJson: string }>`
      SELECT task_json AS "taskJson" FROM background_tasks
      WHERE state IN ('running', 'needs_input')
        AND json_extract(task_json, '$.childThreadId') IS NULL
    `;
    const now = DateTime.formatIso(yield* DateTime.now);
    const lost = live
      .flatMap((row) => Option.toArray(decodeTask(row.taskJson)))
      .map((task): BackgroundTask => ({ ...task, state: "lost", endedAt: now, updatedAt: now }));
    yield* Effect.forEach(lost, save, { discard: true });
    return lost;
  });
  const lostTasks = yield* markLost.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not settle background tasks after a restart", { cause }).pipe(
        Effect.as([]),
      ),
    ),
  );

  yield* forkParked(
    Effect.forEach(lostTasks, postCard, { discard: true }).pipe(
      Effect.andThen(
        Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          onEvent(event).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not follow a background task", { cause }),
            ),
          ),
        ),
      ),
      Effect.ignoreCause,
    ),
  );

  return BackgroundTaskService.of({ start, stop, remove, list, readLog, stream });
});

export const layer: Layer.Layer<
  BackgroundTaskService,
  never,
  | SqlClient.SqlClient
  | Orchestrator.OrchestratorV2
  | ProjectStore.ProjectStoreV2
  | AuditTrail.AuditTrail
  | ServerConfig.ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
> = Layer.effect(BackgroundTaskService, make).pipe(Layer.orDie);
