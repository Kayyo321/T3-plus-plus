import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DEFAULT_SUPERVISION_THRESHOLDS, EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as OrchestratorAgent from "./OrchestratorAgent.ts";
import * as SupervisionMonitor from "./SupervisionMonitor.ts";

it.effect.each(["scheduled", "background", "teamwork"] as const)(
  "supervises %s work by default, pauses without a brain, and honors cooldown, cap, and let-it-run",
  (source) => Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("unattended");
    const old = DateTime.subtract(yield* DateTime.now, { minutes: 20 });
    const at = DateTime.formatIso(old);
    if (source === "scheduled") {
      yield* sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, project_id, thread_id) VALUES ('scheduled', 'task', 'manual', ${at}, 'running', 'project', ${threadId})`;
    } else if (source === "teamwork") {
      yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json) VALUES ('team', 'parent', ${JSON.stringify({ status: "running", members: [{ threadId }] })})`;
    } else {
      const task = { id: "background", threadId, kind: "command", name: "Tests", command: "test", cwd: "/project", childThreadId: null, state: "running", exitCode: null, lastOutputLine: null, resumeAgent: false, startedAt: at, updatedAt: at, endedAt: null };
      yield* sql`INSERT INTO background_tasks (id, thread_id, state, started_at, task_json) VALUES ('background', ${threadId}, 'running', ${at}, ${JSON.stringify(task)})`;
    }
    let available = false;
    const reviews: string[] = [];
    let escalations = 0;
    const layer = SupervisionMonitor.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(EnvironmentId.make("local")) }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed({ id: threadId, title: "Unattended", activeRunId: source === "background" ? null : RunId.make("active"), latestRunStartedAt: old, updatedAt: old, pendingRuntimeRequest: null, lastVisitedAt: null } as never),
        getThreadRecords: () => Effect.succeed({ turnItems: [], attempts: [] } as never),
        dispatch: () => Effect.succeed({} as never),
      }),
      Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
      Layer.mock(OrchestratorAgent.OrchestratorAgent)({
        snapshot: Effect.sync(() => ({ supervision: { status: available ? "active" : "paused" }, thresholds: { ...DEFAULT_SUPERVISION_THRESHOLDS, nudgeCap: 1 } }) as never),
        setWatching: () => Effect.void,
        review: (prompt) => Effect.sync(() => { reviews.push(prompt); }),
        directive: () => Effect.sync(() => { escalations += 1; return escalations; }),
      }),
    )));
    yield* Effect.gen(function* () {
      const monitor = yield* SupervisionMonitor.SupervisionMonitor;
      yield* monitor.tick;
      assert.equal(reviews.length, 0);
      assert.equal((yield* monitor.threadState(threadId)).mode, "on");
      assert.equal((yield* monitor.threadState(ThreadId.make("interactive"))).mode, "off");
      available = true;
      yield* monitor.tick;
      assert.equal(reviews.length, 1);
      if (source === "background") assert.include(reviews[0]!, "background_task_log");
      yield* monitor.tick;
      assert.equal(escalations, 0);
      yield* TestClock.adjust("11 minutes");
      yield* monitor.tick;
      assert.equal(escalations, 1);
      assert.equal(reviews.length, 1);
      yield* monitor.setThreadMode({ threadId, mode: "off" });
      yield* TestClock.adjust("11 minutes");
      yield* monitor.tick;
      assert.equal(reviews.length, 1);
      assert.equal(escalations, 1);
      assert.equal((yield* monitor.threadState(threadId)).mode, "off");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);
