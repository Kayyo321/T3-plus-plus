import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_ORCHESTRATOR_GRANTS,
  type ModelSelection,
  type OrchestratorApproval,
  ProjectId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestratorAgent from "./OrchestratorAgent.ts";
import * as OrchestratorTurnContext from "./OrchestratorTurnContext.ts";

const instanceId = ProviderInstanceId.make("claude");
const brain: ModelSelection = { instanceId, model: "haiku" };
const projectId = ProjectId.make("project-scratch");

const provider = (overrides: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [{ slug: "haiku", name: "Haiku" }],
    ...overrides,
  }) as ServerProvider;

const harness = Effect.gen(function* () {
  const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider()]);
  const sends = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
    [],
  );
  const created = yield* Ref.make(0);
  const dependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Ref.get(providers),
      streamChanges: Stream.never,
      refreshInstance: () => Ref.get(providers),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(null),
      sendToThread: (input) =>
        Ref.update(sends, (current) => [...current, input]).pipe(Effect.andThen(Effect.never)),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: () => Ref.update(created, (count) => count + 1).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.succeed({ projectId }),
    }),
    OrchestratorTurnContext.layer,
  );
  const layer = OrchestratorAgent.layer.pipe(
    Layer.provideMerge(AuditTrail.layer),
    Layer.provide(dependencies),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(NodeServices.layer),
  );
  return { providers, sends, created, layer };
});

const sendInput = { commandId: CommandId.make("command-1"), text: "hello" };

it.effect("refuses to send while blocked, and starts nothing elsewhere", () =>
  Effect.gen(function* () {
    const { providers, sends, created, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Ref.set(providers, [
        provider({ auth: { status: "unauthenticated" } } as Partial<ServerProvider>),
      ]);
      const failure = yield* agent.send(sendInput).pipe(Effect.flip);
      assert.equal(failure.reason, "blocked");
      assert.include(failure.message, "signed out");
      assert.deepStrictEqual(yield* Ref.get(sends), []);
      assert.equal(yield* Ref.get(created), 0);
      const snapshot = yield* agent.snapshot;
      assert.equal(snapshot.availability.status, "blocked");
      assert.equal(snapshot.supervision.status, "paused");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses a model that is not available rather than remembering it", () =>
  Effect.gen(function* () {
    const { providers, layer } = yield* harness;
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* Ref.set(providers, [provider({ enabled: false })]);
      const failure = yield* agent.setBrain({ brain }).pipe(Effect.flip);
      assert.equal(failure.reason, "blocked");
      assert.equal((yield* agent.snapshot).brain, null);
    }).pipe(Effect.provide(layer));
  }),
);

const governed = <A, E>(
  tool: string,
  run: Effect.Effect<A, E>,
): Effect.Effect<
  { readonly approval: OrchestratorApproval | undefined; readonly exit: Exit.Exit<A, unknown> },
  never,
  OrchestratorAgent.OrchestratorAgent
> =>
  Effect.gen(function* () {
    const agent = yield* OrchestratorAgent.OrchestratorAgent;
    const fiber = yield* agent
      .governTool(tool, { threadId: "t" }, run)
      .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
    yield* Effect.yieldNow;
    const [approval] = (yield* agent.snapshot.pipe(Effect.orDie)).pendingApprovals;
    if (approval !== undefined)
      yield* agent.answerApproval({ id: approval.id, allow: false }).pipe(Effect.orDie);
    return { approval, exit: yield* Fiber.join(fiber) };
  });

it.effect("asks before an external change, and a no leaves it undone and audited", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const ran = yield* Ref.make(false);
      const { approval, exit } = yield* governed("t3_thread_transfer", Ref.set(ran, true));
      assert.equal(approval?.effect, "external");
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(yield* Ref.get(ran));
      const audit = yield* AuditTrail.AuditTrail;
      const { entries } = yield* audit.list({ actor: "orchestrator" });
      assert.equal(entries[0]?.action, "t3_thread_transfer");
      assert.equal(entries[0]?.outcome, "denied");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses a tool nobody classified, and the secret tool", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      for (const tool of ["request_secret", "a_tool_added_tomorrow"]) {
        const { exit } = yield* governed(tool, Effect.void);
        assert.isTrue(Exit.isFailure(exit));
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("honours an off domain and records what ran", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness;
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      const allowed = yield* governed("t3_thread_read", Effect.succeed("ok"));
      assert.isTrue(Exit.isSuccess(allowed.exit));
      yield* agent.setGrants({
        ...DEFAULT_ORCHESTRATOR_GRANTS,
        domains: { ...DEFAULT_ORCHESTRATOR_GRANTS.domains, conversations: "off" },
      });
      const refused = yield* governed("t3_thread_read", Effect.succeed("ok"));
      assert.isTrue(Exit.isFailure(refused.exit));
      const { entries } = yield* (yield* AuditTrail.AuditTrail).list({ actor: "orchestrator" });
      assert.deepStrictEqual(
        entries.slice(0, 2).map((entry) => entry.outcome),
        ["denied", "succeeded"],
      );
    }).pipe(Effect.provide(layer));
  }),
);
