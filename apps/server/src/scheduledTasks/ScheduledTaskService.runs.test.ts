import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  type MessageId,
  RunId,
  ScheduledTaskUpsertInput,
  type ScheduledTaskRunPolicy,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

interface FakeRun {
  readonly id: RunId;
  readonly startedAtMs: number;
  status: string;
  tools: number;
  pendingRequest: boolean;
  reply: string;
}

const NOW = Date.parse("2026-06-10T12:00:00.000Z");

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const makeHarness = () => {
  const runs = new Map<string, FakeRun>();
  const prompts: string[] = [];
  const interrupted: string[] = [];
  let launches = 0;

  const startRun = (messageId: MessageId, prompt: string, startedAtMs: number) => {
    launches += 1;
    const threadId = ThreadId.make(`thread-${launches}`);
    prompts.push(prompt);
    runs.set(messageId, {
      id: RunId.make(`run-${launches}`),
      startedAtMs,
      status: "running",
      tools: 0,
      pendingRequest: false,
      reply: `Finished pass ${launches}.`,
    });
    return threadId;
  };

  const findByMessage = (messageId: unknown) => runs.get(String(messageId));
  const findByRun = (runId: unknown) => [...runs.values()].find((run) => run.id === runId);

  const projectRun = (run: FakeRun) => ({
    id: run.id,
    status: run.status,
    workStartedAt: undefined,
    startedAt: DateTime.makeUnsafe(run.startedAtMs),
    requestedAt: DateTime.makeUnsafe(run.startedAtMs),
    completedAt: null,
    modelSelection: { model: "test-model" },
  });

  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => ({
                threadId: startRun(
                  input.initialMessage?.messageId as MessageId,
                  input.initialMessage?.text ?? "",
                  now,
                ),
                projection: undefined as never,
                resumed: false,
              })),
            ),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ projectId: "project-runs", deletedAt: null } as never),
          getThreadRecords: ((_threadId: ThreadId, _fields: unknown, filter: never) => {
            const { messageIds, runIds, turnItemRunId, messageRunIds } = (filter ?? {}) as Record<
              string,
              ReadonlyArray<unknown> | string | undefined
            >;
            const byMessage = Array.isArray(messageIds) ? findByMessage(messageIds[0]) : undefined;
            const byRun =
              (Array.isArray(runIds) ? findByRun(runIds[0]) : undefined) ??
              (typeof turnItemRunId === "string" ? findByRun(turnItemRunId) : undefined) ??
              (Array.isArray(messageRunIds) ? findByRun(messageRunIds[0]) : undefined);
            return Effect.succeed({
              messages:
                byMessage !== undefined
                  ? [{ runId: byMessage.id }]
                  : byRun !== undefined
                    ? [{ text: byRun.reply }]
                    : [],
              runs: byRun === undefined ? [] : [projectRun(byRun)],
              runtimeRequests: byRun?.pendingRequest ? [{ status: "pending" }] : [],
              turnItems: Array.from({ length: byRun?.tools ?? 0 }, () => ({})),
              attempts: [],
              providerTurns: [],
            } as never);
          }) as never,
          interruptThread: (input) =>
            Effect.sync(() => {
              interrupted.push(String(input.runId));
              const run = findByRun(input.runId);
              if (run !== undefined) run.status = "interrupted";
              return { type: "no_active_run" as const };
            }),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );

  return {
    layer,
    prompts,
    interrupted,
    activeRun: () => [...runs.values()].at(-1) as FakeRun,
    launches: () => launches,
  };
};

const taskInput = (schedule: unknown, policy?: ScheduledTaskRunPolicy) =>
  decodeInput({
    title: "Nightly review",
    prompt: "Review the code.",
    enabled: true,
    schedule,
    projectId: "project-runs",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...(policy === undefined ? {} : { policy }),
  });

const withHarness = <A, E>(
  body: (
    harness: ReturnType<typeof makeHarness>,
    service: ScheduledTaskService.ScheduledTaskService["Service"],
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body(harness, service);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  );

it.effect("records a run from dispatch to its summary", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }),
      );
      yield* service.runNow({ id: task.id });
      yield* service.runDueWork;
      const started = (yield* service.listRuns({ id: task.id })).runs[0];
      expect(started?.outcome).toBe("running");
      expect(started?.finishedAt).toBeNull();

      harness.activeRun().tools = 3;
      harness.activeRun().status = "completed";
      yield* service.runDueWork;
      const { runs, hasMore } = yield* service.listRuns({ id: task.id });
      expect(hasMore).toBe(false);
      expect(runs[0]).toMatchObject({
        outcome: "succeeded",
        trigger: "manual",
        summary: "Finished pass 1.",
        toolCalls: 3,
      });
      expect(runs[0]?.finishedAt).not.toBeNull();
      expect((yield* service.list()).tasks[0]?.latestRun?.outcome).toBe("succeeded");
    }),
  ),
);

it.effect("a run's own report wins over its last message and can stay quiet", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { notify: "changes" }),
      );
      const { threadId } = yield* service.runNow({ id: task.id });
      expect(harness.prompts[0]).toContain("report_scheduled_run");
      yield* service.reportRun(threadId as ThreadId, {
        verdict: "nothing_changed",
        summary: "No new pull requests.",
      });
      harness.activeRun().status = "completed";
      yield* service.runDueWork;
      expect((yield* service.listRuns({ id: task.id })).runs[0]).toMatchObject({
        outcome: "nothing_changed",
        summary: "No new pull requests.",
      });
    }),
  ),
);

it.effect("refuses a report from a conversation with no run in progress", () =>
  withHarness((_harness, service) =>
    service
      .reportRun(ThreadId.make("thread-elsewhere"), { verdict: "done", summary: "All done." })
      .pipe(
        Effect.flip,
        Effect.map((error) => expect(error.message).toContain("no scheduled run")),
      ),
  ),
);

it.effect("stops a run at its time budget", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput(
          { type: "interval", everyMs: 3_600_000 },
          { budget: { maxDurationMinutes: 10 } },
        ),
      );
      yield* service.runNow({ id: task.id });
      yield* TestClock.adjust("9 minutes");
      yield* service.runDueWork;
      expect(harness.interrupted).toEqual([]);

      yield* TestClock.adjust("2 minutes");
      yield* service.runDueWork;
      expect(harness.interrupted).toEqual(["run-1"]);
      expect((yield* service.listRuns({ id: task.id })).runs[0]).toMatchObject({
        outcome: "budget_exceeded",
        error: "Stopped after the 10-minute limit.",
      });
    }),
  ),
);

it.effect("stops a run at its tool budget and at the default when none is set", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const limited = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { budget: { maxToolCalls: 5 } }),
      );
      yield* service.runNow({ id: limited.task.id });
      harness.activeRun().tools = 5;
      yield* service.runDueWork;
      expect((yield* service.listRuns({ id: limited.task.id })).runs[0]?.outcome).toBe(
        "budget_exceeded",
      );

      const unlimited = yield* service.upsert({
        ...(yield* taskInput({ type: "interval", everyMs: 86_400_000 })),
        title: "No policy",
      });
      yield* service.runNow({ id: unlimited.task.id });
      yield* TestClock.adjust("61 minutes");
      yield* service.runDueWork;
      expect((yield* service.listRuns({ id: unlimited.task.id })).runs[0]?.outcome).toBe(
        "budget_exceeded",
      );
    }),
  ),
);

it.effect("cannot enforce a cost limit on a model with no known price", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { budget: { maxCostUsd: 1 } }),
      );
      yield* service.runNow({ id: task.id });
      yield* service.runDueWork;
      expect(harness.interrupted).toEqual([]);
      expect((yield* service.listRuns({ id: task.id })).runs[0]?.costUsd).toBeNull();
    }),
  ),
);

it.effect("parks a run that needs an answer, and its time does not count", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput(
          { type: "interval", everyMs: 86_400_000 },
          { budget: { maxDurationMinutes: 10 } },
        ),
      );
      yield* service.runNow({ id: task.id });
      harness.activeRun().pendingRequest = true;
      yield* service.runDueWork;
      expect((yield* service.listRuns({ id: task.id })).runs[0]?.outcome).toBe("needs_input");

      yield* TestClock.adjust("2 hours");
      yield* service.runDueWork;
      expect(harness.interrupted).toEqual([]);

      harness.activeRun().pendingRequest = false;
      yield* service.runDueWork;
      expect((yield* service.listRuns({ id: task.id })).runs[0]?.outcome).toBe("running");
      expect(harness.interrupted).toEqual([]);
    }),
  ),
);

it.effect("fails safe when a task says never to wait", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { onPrompt: "fail" }),
      );
      yield* service.runNow({ id: task.id });
      harness.activeRun().pendingRequest = true;
      yield* service.runDueWork;
      expect(harness.interrupted).toEqual(["run-1"]);
      expect((yield* service.listRuns({ id: task.id })).runs[0]?.outcome).toBe("failed");
    }),
  ),
);

const repeater = { repeater: { doneWhen: "all tests pass", maxIterations: 3 } };

it.effect("a repeater stops when a run reports its condition is met", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 60_000 }, repeater),
      );
      const { threadId } = yield* service.runNow({ id: task.id });
      expect(harness.prompts[0]).toContain("Stop when: all tests pass");
      yield* service.reportRun(threadId as ThreadId, { verdict: "done", summary: "Green." });
      harness.activeRun().status = "completed";
      yield* service.runDueWork;

      const { tasks } = yield* service.list();
      expect(tasks[0]).toMatchObject({ enabled: false, nextRunAt: null });
      expect(tasks[0]?.latestRun?.outcome).toBe("done");
    }),
  ),
);

it.effect("a repeater stops at its iteration cap and says what it did not reach", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 60_000 }, repeater),
      );
      for (const pass of [1, 2, 3]) {
        yield* TestClock.adjust("1 minute");
        const { threadId } = yield* service.runNow({ id: task.id });
        expect(harness.prompts.at(-1)).toContain(`run ${pass} of at most 3`);
        yield* service.reportRun(threadId as ThreadId, { verdict: "continue", summary: "Red." });
        harness.activeRun().status = "completed";
        yield* service.runDueWork;
      }
      const { tasks } = yield* service.list();
      expect(tasks[0]?.enabled).toBe(false);
      expect(tasks[0]?.latestRun).toMatchObject({
        outcome: "iteration_limit",
        iteration: 3,
        error: "Stopped after 3 runs without meeting: all tests pass",
      });
      expect(harness.launches()).toBe(3);

      const resumed = yield* service.setEnabled({ id: task.id, enabled: true });
      expect(resumed.task.enabled).toBe(true);
      expect((yield* service.list()).tasks[0]?.repeaterIteration).toBeUndefined();
    }),
  ),
);

it.effect("a repeater stops on a failed pass instead of retrying it", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 60_000 }, repeater),
      );
      yield* service.runNow({ id: task.id });
      harness.activeRun().status = "failed";
      yield* service.runDueWork;
      expect((yield* service.list()).tasks[0]?.enabled).toBe(false);
    }),
  ),
);

it.effect("a one-time repeater runs its next pass as soon as the last one ends", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      yield* service.upsert(
        yield* taskInput({ type: "once", runAt: "2026-06-10T12:01:00.000Z" }, repeater),
      );
      yield* TestClock.adjust("2 minutes");
      yield* service.runDueWork;
      expect(harness.launches()).toBe(1);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBeNull();

      harness.activeRun().status = "completed";
      yield* service.runDueWork;
      expect((yield* service.list()).tasks[0]?.enabled).toBe(true);
      yield* service.runDueWork;
      expect(harness.launches()).toBe(2);
    }),
  ),
);

it.effect("a repeater never overlaps its own run", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      yield* service.upsert(yield* taskInput({ type: "interval", everyMs: 60_000 }, repeater));
      yield* TestClock.adjust("2 minutes");
      yield* service.runDueWork;
      yield* TestClock.adjust("2 minutes");
      yield* service.runDueWork;
      expect(harness.launches()).toBe(1);
    }),
  ),
);

const hoursLater = (hours: number) => TestClock.adjust(`${hours} hours`);

it.effect("skip records the missed run and moves on", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      const { task } = yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { missedRuns: "skip" }),
      );
      yield* hoursLater(5);
      yield* service.runDueWork;
      expect(harness.launches()).toBe(0);
      expect((yield* service.listRuns({ id: task.id })).runs[0]).toMatchObject({
        outcome: "skipped",
        threadId: null,
      });
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe("2026-06-10T18:00:00.000Z");
    }),
  ),
);

it.effect("run once on wake runs one time and rejoins the schedule", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { missedRuns: "run_once" }),
      );
      yield* hoursLater(5);
      yield* service.runDueWork;
      yield* service.runDueWork;
      expect(harness.launches()).toBe(1);
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe("2026-06-10T18:00:00.000Z");
    }),
  ),
);

it.effect("catch up replays each missed time, one at a time, then rejoins", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      yield* service.upsert(
        yield* taskInput({ type: "interval", everyMs: 3_600_000 }, { missedRuns: "catch_up" }),
      );
      // Due at 13:00, then 14:00, 15:00 and 16:00, all missed by 17:00.
      yield* hoursLater(5);
      for (const pass of [1, 2, 3, 4]) {
        yield* TestClock.adjust("1 second");
        yield* service.runDueWork;
        expect(harness.launches()).toBe(pass);
        // The next replay waits for this one.
        yield* service.runDueWork;
        expect(harness.launches()).toBe(pass);
        harness.activeRun().status = "completed";
        yield* service.runDueWork;
      }
      expect((yield* service.list()).tasks[0]?.nextRunAt).toBe("2026-06-10T17:00:00.000Z");
    }),
  ),
);

it.effect("a task without a policy keeps skipping missed clock times", () =>
  withHarness((harness, service) =>
    Effect.gen(function* () {
      yield* service.upsert(
        yield* taskInput({ type: "cron", expression: "0 13 * * *", timeZone: "UTC" }),
      );
      yield* hoursLater(5);
      yield* service.runDueWork;
      expect(harness.launches()).toBe(0);
    }),
  ),
);

it.effect("refuses a cron expression that never comes up", () =>
  withHarness((_harness, service) =>
    Effect.gen(function* () {
      const error = yield* service
        .upsert(yield* taskInput({ type: "cron", expression: "0 0 31 2 *" }))
        .pipe(Effect.flip);
      expect(error.message).toBe("This cron expression never comes up.");
    }),
  ),
);
