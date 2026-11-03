import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type AuditEntryInput,
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_SUPERVISION_THRESHOLDS,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  ProviderInstanceId,
  OrchestratorMcpFailure,
  type ServerSettings as ServerSettingsValue,
  type SupervisionMode,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Tool, Toolkit } from "effect/ai";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestratorAgent from "./OrchestratorAgent.ts";
import * as SupervisionMonitor from "./SupervisionMonitor.ts";

const project = ProjectId.make("project");
const settingsLayer = (settings: Partial<ServerSettingsValue> = {}) =>
  Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...settings }),
    streamChanges: Stream.never,
  });

it.effect.each(["scheduled", "background", "teamwork"] as const)(
  "supervises %s work by default, pauses without a brain, and honors cooldown, cap, and let-it-run",
  (source) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("unattended");
      const old = DateTime.subtract(yield* DateTime.now, { minutes: 20 });
      const at = DateTime.formatIso(old);
      if (source === "scheduled") {
        yield* sql`INSERT INTO scheduled_task_runs (run_id, task_id, trigger, started_at, outcome, project_id, thread_id) VALUES ('scheduled', 'task', 'manual', ${at}, 'running', 'project', ${threadId})`;
      } else if (source === "teamwork") {
        yield* sql`INSERT INTO teamwork_runs (id, parent_thread_id, run_json) VALUES ('team', 'parent', ${JSON.stringify({ status: "running", members: [{ threadId }] })})`;
      } else {
        const task = {
          id: "background",
          threadId,
          kind: "command",
          name: "Tests",
          command: "test",
          cwd: "/project",
          childThreadId: null,
          state: "running",
          exitCode: null,
          lastOutputLine: null,
          resumeAgent: false,
          startedAt: at,
          updatedAt: at,
          endedAt: null,
        };
        yield* sql`INSERT INTO background_tasks (id, thread_id, state, started_at, task_json) VALUES ('background', ${threadId}, 'running', ${at}, ${JSON.stringify(task)})`;
      }
      let available = false;
      const reviews: string[] = [];
      let escalations = 0;
      let reviewContext: { threadId: ThreadId; runId: RunId } | null = null;
      const layer = SupervisionMonitor.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({
                  id,
                  projectId: project,
                  lineage: { relationshipToParent: null },
                  deletedAt: null,
                  title: "Unattended",
                  activeRunId: source === "background" ? null : RunId.make("active"),
                  latestRunStartedAt: old,
                  updatedAt: old,
                  pendingRuntimeRequest: null,
                  lastVisitedAt: null,
                } as never),
              getThreadRecords: () => Effect.succeed({ turnItems: [], attempts: [] } as never),
              dispatch: () => Effect.succeed({} as never),
            }),
            Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
            settingsLayer(),
            Layer.mock(OrchestratorAgent.OrchestratorAgent)({
              snapshot: Effect.sync(
                () =>
                  ({
                    supervision: { status: available ? "active" : "paused" },
                    thresholds: { ...DEFAULT_SUPERVISION_THRESHOLDS, nudgeCap: 1 },
                  }) as never,
              ),
              setWatching: () => Effect.void,
              setSupervisionThreadModes: () => Effect.void,
              checkOrchestrator: Effect.void,
              governTool: (_name, _params, run) => run,
              supervisionReview: Effect.sync(() => reviewContext),
              review: (prompt) =>
                Effect.sync(() => {
                  reviews.push(prompt);
                }),
              directive: () =>
                Effect.sync(() => {
                  escalations += 1;
                  return escalations;
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const monitor = yield* SupervisionMonitor.SupervisionMonitor;
        yield* monitor.tick;
        assert.equal(reviews.length, 0);
        assert.equal((yield* monitor.threadState(threadId)).effectiveMode, "modest");
        available = true;
        yield* monitor.tick;
        assert.equal(reviews.length, 1);
        if (source === "background") assert.include(reviews[0]!, "background_task_log");
        yield* monitor.tick;
        assert.equal(escalations, 0);
        reviewContext = { threadId, runId: (yield* monitor.threadState(threadId)).runId! };
        let nudges = 0;
        const toolkit = Toolkit.make(
          Tool.make("t3_thread_send", {
            parameters: Schema.Struct({ threadId: ThreadId }),
            success: Schema.Struct({ sent: Schema.Number }),
            failure: OrchestratorMcpFailure,
            failureMode: "return",
          }),
        );
        const callNudge = Effect.gen(function* () {
          const tools = yield* toolkit;
          const result = yield* tools
            .handle("t3_thread_send", { threadId })
            .pipe(Stream.unwrap, Stream.runCollect);
          return result.at(-1)?.result;
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(
              McpToolAccess.toLayer(toolkit, {
                t3_thread_send: McpToolAccess.reads(() => Effect.sync(() => ({ sent: ++nudges }))),
              }),
            ),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, {
            environmentId: EnvironmentId.make("local"),
            requestNamespace: "brain",
            thread: {
              threadId: ThreadId.make("brain"),
              providerSessionId: "brain",
              providerInstanceId: ProviderInstanceId.make("claude"),
            },
            client: undefined,
            capabilities: new Set(["editor"] as const),
            issuedAt: 0,
          }),
        );
        const concurrent = yield* Effect.all([callNudge, callNudge], { concurrency: "unbounded" });
        assert.equal(
          concurrent.filter((result) => result !== undefined && "sent" in result).length,
          1,
        );
        assert.equal(
          concurrent.filter(
            (result) =>
              result !== undefined && "code" in result && result.code === "capability_denied",
          ).length,
          1,
        );
        const refused = yield* monitor
          .governIntervention(
            threadId,
            Effect.sync(() => {
              nudges += 1;
            }),
          )
          .pipe(Effect.flip);
        assert.include(refused.message, "cooldown");
        assert.equal(nudges, 1);
        assert.equal((yield* monitor.threadState(threadId)).nudges, 1);
        yield* TestClock.adjust("11 minutes");
        yield* monitor.tick;
        assert.equal(escalations, 1);
        assert.equal(reviews.length, 1);
        if (source === "scheduled") yield* sql`UPDATE scheduled_task_runs SET finished_at = ${at}`;
        else if (source === "background")
          yield* sql`UPDATE background_tasks SET state = 'succeeded'`;
        else
          yield* sql`UPDATE teamwork_runs SET run_json = json_set(run_json, '$.status', 'completed')`;
        assert.equal((yield* monitor.status).length, 0);
        yield* monitor.setThreadMode({ threadId, mode: "off" });
        yield* TestClock.adjust("11 minutes");
        yield* monitor.tick;
        assert.equal(reviews.length, 1);
        assert.equal(escalations, 1);
        const stopped = yield* monitor
          .governIntervention(
            threadId,
            Effect.sync(() => {
              nudges += 1;
            }),
          )
          .pipe(Effect.flip);
        assert.include(stopped.message, "let it run");
        assert.equal(nudges, 1);
        assert.equal((yield* monitor.threadState(threadId)).effectiveMode, "off");
        const afterOff = yield* callNudge;
        assert.isTrue(
          afterOff !== undefined && "code" in afterOff && afterOff.code === "capability_denied",
        );
        reviewContext = null;
        assert.deepStrictEqual(yield* callNudge, { sent: 2 });
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer)))),
);

interface ModeRow {
  readonly name: string;
  readonly global?: SupervisionMode;
  readonly project?: SupervisionMode;
  readonly thread?: SupervisionMode;
  readonly minutesSilent: number;
  readonly mode: SupervisionMode;
  readonly source: "project" | "thread" | "default";
  readonly reviews: number;
}

const MODE_ROWS: ReadonlyArray<ModeRow> = [
  { name: "default", minutesSilent: 20, mode: "modest", source: "default", reviews: 1 },
  { name: "modest stays patient", minutesSilent: 6, mode: "modest", source: "default", reviews: 0 },
  {
    name: "global off",
    global: "off",
    minutesSilent: 20,
    mode: "off",
    source: "default",
    reviews: 0,
  },
  {
    name: "thread beats global",
    global: "off",
    thread: "aggressive",
    minutesSilent: 6,
    mode: "aggressive",
    source: "thread",
    reviews: 1,
  },
  {
    name: "project off beats thread",
    project: "off",
    thread: "aggressive",
    minutesSilent: 20,
    mode: "off",
    source: "project",
    reviews: 0,
  },
  {
    name: "project beats thread and global",
    global: "off",
    project: "aggressive",
    thread: "off",
    minutesSilent: 6,
    mode: "aggressive",
    source: "project",
    reviews: 1,
  },
];

const runModeRow = (input: {
  readonly row: ModeRow;
  readonly lineage?: Record<string, unknown>;
  readonly test: (context: {
    readonly threadId: ThreadId;
    readonly monitor: SupervisionMonitor.SupervisionMonitor["Service"];
    readonly reviews: Array<string>;
    readonly audits: Array<AuditEntryInput>;
  }) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { row } = input;
    const threadId = ThreadId.make("interactive");
    const now = yield* DateTime.now;
    const silentSince = DateTime.subtract(now, { seconds: row.minutesSilent * 60 });
    // An ordinary conversation with a run in progress: nothing unattended about it.
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run', ${threadId}, 1, 'codex', 'running', ${DateTime.formatIso(silentSince)}, '{}')`;
    const reviews: Array<string> = [];
    const audits: Array<AuditEntryInput> = [];
    const layer = SupervisionMonitor.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) =>
              Effect.succeed({
                id,
                projectId: project,
                lineage: { relationshipToParent: null, ...input.lineage },
                deletedAt: null,
                title: "Interactive",
                activeRunId: RunId.make("run"),
                latestRunStartedAt: silentSince,
                updatedAt: silentSince,
                pendingRuntimeRequest: null,
                lastVisitedAt: null,
              } as never),
            getThreadRecords: () => Effect.succeed({ turnItems: [], attempts: [] } as never),
            dispatch: () => Effect.succeed({} as never),
          }),
          Layer.mock(AuditTrail.AuditTrail)({
            record: (entry) =>
              Effect.sync(() => {
                audits.push(entry);
              }),
          }),
          settingsLayer({
            ...(row.global === undefined ? {} : { supervisionMode: row.global }),
            ...(row.project === undefined
              ? {}
              : { projectSettingsOverrides: { [project]: { supervisionMode: row.project } } }),
          }),
          Layer.mock(OrchestratorAgent.OrchestratorAgent)({
            snapshot: Effect.succeed({
              supervision: { status: "active" },
              thresholds: DEFAULT_SUPERVISION_THRESHOLDS,
            } as never),
            setWatching: () => Effect.void,
            setSupervisionThreadModes: () => Effect.void,
            checkOrchestrator: Effect.void,
            review: (prompt) =>
              Effect.sync(() => {
                reviews.push(prompt);
              }),
            directive: () => Effect.succeed(0),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const monitor = yield* SupervisionMonitor.SupervisionMonitor;
      if (row.thread !== undefined) yield* monitor.setThreadMode({ threadId, mode: row.thread });
      reviews.length = 0;
      yield* input.test({ threadId, monitor, reviews, audits });
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.scoped,
    Effect.provide(Sqlite.layerMemory.pipe(Layer.provideMerge(NodeServices.layer))),
  );

it.effect.each(MODE_ROWS)("resolves the mode and reviews by it: $name", (row) =>
  runModeRow({
    row,
    test: ({ threadId, monitor, reviews }) =>
      Effect.gen(function* () {
        const state = yield* monitor.threadState(threadId);
        assert.equal(state.effectiveMode, row.mode);
        assert.equal(state.modeSource, row.source);
        yield* monitor.tick;
        assert.equal(reviews.length, row.reviews);
        assert.equal(
          reviews[0]?.includes("aggressive supervision") ?? row.mode === "aggressive",
          row.mode === "aggressive",
        );
      }),
  }),
);

it.effect("never reviews the orchestrator's own conversation", () =>
  runModeRow({
    row: MODE_ROWS[0]!,
    lineage: { orchestrator: true },
    test: ({ monitor, reviews }) =>
      Effect.gen(function* () {
        yield* monitor.tick;
        assert.equal(reviews.length, 0);
      }),
  }),
);

it.effect.each([
  { mode: "off", action: "thread.let-run" },
  { mode: "modest", action: "thread.watch" },
  { mode: "aggressive", action: "thread.watch-aggressive" },
  { mode: null, action: "thread.follow-default" },
] as const)("audits a thread set to $mode", ({ mode, action }) =>
  runModeRow({
    row: MODE_ROWS[0]!,
    test: ({ threadId, monitor, audits }) =>
      Effect.gen(function* () {
        yield* monitor.setThreadMode({ threadId, mode });
        assert.deepInclude(audits, {
          actor: "user",
          domain: "supervision",
          action,
          outcome: "succeeded",
          threadId,
        });
        assert.equal((yield* monitor.threadState(threadId)).mode, mode);
      }),
  }),
);

it.effect.each([
  { thread: "aggressive", minutesSilent: 4.75, atHalfTick: 1, atFullTick: 1 },
  { thread: "modest", minutesSilent: 9.75, atHalfTick: 0, atFullTick: 1 },
] as const)(
  "gives only $thread threads the half tick",
  ({ thread, minutesSilent, atHalfTick, atFullTick }) =>
    runModeRow({
      row: { ...MODE_ROWS[0]!, thread, minutesSilent },
      test: ({ reviews }) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("1 second");
          assert.equal(reviews.length, 0);
          yield* TestClock.adjust("29 seconds");
          assert.equal(reviews.length, atHalfTick);
          yield* TestClock.adjust("30 seconds");
          assert.equal(reviews.length, atFullTick);
        }),
    }),
);
