import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_ORCHESTRATOR_GRANTS,
  EnvironmentId,
  type ModelSelection,
  type OrchestratorApproval,
  type OrchestrationV2DomainEvent,
  type OrchestratorSnapshot,
  ProjectId,
  ThreadId,
  RunId,
  MessageId,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
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

type TestShell = {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: "idle" | "running" | "waiting" | "completed";
  readonly activeRunId: RunId | null;
  readonly deletedAt: null | string;
  readonly latestVisibleMessage: {
    readonly id: MessageId;
    readonly role: "user" | "assistant";
    readonly text: string;
    readonly updatedAt: DateTime.Utc;
  } | null;
};

const shell = (overrides: Partial<TestShell> & { readonly id: ThreadId }): TestShell => ({
  title: "Work",
  status: "idle",
  activeRunId: null,
  deletedAt: null,
  latestVisibleMessage: null,
  ...overrides,
});

const harness = (options: { readonly holdSends?: boolean } = {}) =>
  Effect.gen(function* () {
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([provider()]);
    const sends = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const created = yield* Ref.make(0);
    const deleted = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const active = yield* Ref.make<{ id: ThreadId; activeRunId: RunId } | null>(null);
    const activeMessage = yield* Ref.make<MessageId | null>(null);
    const ownerMessages = yield* Ref.make<ReadonlyArray<OwnerMessage>>([]);
    const shells = yield* Ref.make(new Map<ThreadId, TestShell | null>());
    const failSends = yield* Ref.make(false);
    // Open unless a test holds the sends, to show that choosing the brain does not wait on them.
    const gate = yield* Deferred.make<void>();
    if (options.holdSends !== true) yield* Deferred.succeed(gate, undefined);
    // The orchestrator's domain events; a test offers the ones it needs.
    const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    // Completes after every send attempt, whether it was recorded or failed.
    const attempted = yield* Deferred.make<void>();
    const dependencies = Layer.mergeAll(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Ref.get(providers),
        streamChanges: Stream.never,
        refreshInstance: () => Ref.get(providers),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId: ThreadId) =>
          Ref.get(shells).pipe(
            Effect.flatMap((known) =>
              known.has(threadId)
                ? Effect.succeed(known.get(threadId) as never)
                : Ref.get(active).pipe(Effect.map((own) => own as never)),
            ),
          ),
        getThreadRecords: (_threadId: ThreadId, fields: ReadonlyArray<string>) =>
          fields.includes("messages")
            ? Ref.get(ownerMessages).pipe(Effect.map((messages) => ({ messages }) as never))
            : Ref.get(activeMessage).pipe(
                Effect.map((id) => ({ runs: id === null ? [] : [{ userMessageId: id }] }) as never),
              ),
        streamDomainEvents: Stream.fromQueue(domainEvents),
        sendToThread: (input) =>
          Deferred.await(gate).pipe(
            Effect.andThen(Ref.get(failSends)),
            Effect.flatMap((fail) =>
              fail
                ? Effect.die("send failed")
                : Ref.update(sends, (current) => [...current, input]).pipe(Effect.as({} as never)),
            ),
            Effect.ensuring(Deferred.succeed(attempted, undefined)),
          ),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) =>
          (command.type === "thread.delete"
            ? Ref.update(deleted, (threadIds) => [...threadIds, command.threadId])
            : Ref.update(created, (count) => count + 1)
          ).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        ensureScratchProject: Effect.succeed({ projectId }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
      }),
    );
    const layer = OrchestratorAgent.layer.pipe(
      Layer.provideMerge(AuditTrail.layer),
      Layer.provideMerge(OrchestratorTurnContext.layer),
      Layer.provide(dependencies),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(NodeServices.layer),
    );
    return {
      providers,
      sends,
      created,
      deleted,
      active,
      activeMessage,
      ownerMessages,
      shells,
      failSends,
      gate,
      attempted,
      domainEvents,
      layer,
    };
  });

type OwnerMessage = {
  readonly id: MessageId;
  readonly createdBy: "user" | "system";
  readonly createdAt: DateTime.Utc;
};

const sendInput = { commandId: CommandId.make("command-1"), text: "hello" };

it.effect("refuses to send while blocked, and starts nothing elsewhere", () =>
  Effect.gen(function* () {
    const { attempted, providers, sends, created, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      // The greeting is the first send; the cases below count only what follows.
      yield* Ref.set(sends, []);
      yield* Ref.set(created, 0);
      yield* Ref.set(providers, [
        provider({ auth: { status: "unauthenticated" } } as Partial<ServerProvider>),
      ]);
      const failure = yield* agent.send(sendInput).pipe(Effect.flip);
      assert.equal(failure.reason, "blocked");
      const reviewFailure = yield* agent.review("Check stalled work").pipe(Effect.flip);
      assert.equal(reviewFailure.reason, "blocked");
      assert.equal(reviewFailure.detail, failure.detail);
      assert.include(failure.message, "signed out");
      assert.deepStrictEqual(yield* Ref.get(sends), []);
      assert.equal(yield* Ref.get(created), 0);
      const snapshot = yield* agent.snapshot;
      assert.equal(snapshot.availability.status, "blocked");
      assert.equal(snapshot.supervision.status, "paused");
      assert.deepStrictEqual(snapshot.needsAttention, {
        status: "needs_attention",
        reason: failure.message,
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("clearing deletes the conversation and starts the next message on a new one", () =>
  Effect.gen(function* () {
    const { attempted, created, deleted, shells, sends, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      const { threadId } = yield* agent.send(sendInput);
      yield* Ref.update(shells, (known) => new Map(known).set(threadId, shell({ id: threadId })));
      yield* agent.react({ messageId: "item-1", emoji: "👍" });
      yield* agent.markRead({ through: "2026-11-02T12:00:00.000Z" as never });
      const fiber = yield* agent
        .governTool("t3_project_delete", { projectId: "p" }, Effect.void)
        .pipe(Effect.exit, Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.lengthOf((yield* agent.snapshot).pendingApprovals, 1);

      yield* agent.clearConversation;

      assert.deepStrictEqual(yield* Ref.get(deleted), [threadId]);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(fiber)));
      const cleared = yield* agent.snapshot;
      assert.equal(cleared.threadId, null);
      assert.deepStrictEqual(cleared.reactions, {});
      assert.equal(cleared.ownerReadAt, null);
      assert.lengthOf(cleared.pendingApprovals, 0);
      assert.deepStrictEqual(cleared.brain, brain);

      yield* Ref.set(sends, []);
      const beforeNext = yield* Ref.get(created);
      const next = yield* agent.send({ ...sendInput, commandId: CommandId.make("command-2") });
      assert.notEqual(next.threadId, threadId);
      assert.equal(yield* Ref.get(created), beforeNext + 1);

      yield* Ref.set(deleted, []);
      yield* Ref.update(shells, (known) => new Map(known).set(next.threadId, null));
      yield* agent.clearConversation;
      assert.equal((yield* agent.snapshot).threadId, null);
      assert.deepStrictEqual(yield* Ref.get(deleted), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses a model that is not available rather than remembering it", () =>
  Effect.gen(function* () {
    const { providers, layer } = yield* harness();
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
    const { layer } = yield* harness();
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
    const { layer } = yield* harness();
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
    const { layer } = yield* harness();
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

it.effect("attributes only active supervision turns to their persisted review context", () =>
  Effect.gen(function* () {
    const { attempted, layer, sends, active, activeMessage } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      const context = { threadId: ThreadId.make("reviewed"), runId: RunId.make("reviewed-run") };
      yield* agent.review("Check progress", context);
      const message = (yield* Ref.get(sends)).at(-1)!;
      yield* Ref.set(active, { id: message.threadId, activeRunId: RunId.make("brain-run") });
      yield* Ref.set(activeMessage, message.messageId);
      assert.deepStrictEqual(yield* agent.supervisionReview, context);
      yield* Ref.set(activeMessage, "owner-message" as MessageId);
      assert.equal(yield* agent.supervisionReview, null);
      yield* Ref.set(activeMessage, "orchestrator-review-unknown" as MessageId);
      assert.include(
        (yield* agent.supervisionReview.pipe(Effect.flip)).message,
        "no target context",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("pushes which thread a review is on as its run starts and ends", () =>
  Effect.gen(function* () {
    const { attempted, layer, sends, active, activeMessage, domainEvents } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      const reviewed = ThreadId.make("reviewed");
      yield* agent.review("Check progress", { threadId: reviewed, runId: RunId.make("run") });
      const message = (yield* Ref.get(sends)).at(-1)!;
      const pushed = yield* Queue.unbounded<OrchestratorSnapshot>();
      yield* agent.changes.pipe(
        Stream.runForEach((snapshot) => Queue.offer(pushed, snapshot)),
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal((yield* Queue.take(pushed)).supervisionReviewing, null);
      const runUpdated = (status: string) =>
        ({ type: "run.updated", threadId: message.threadId, payload: { status } }) as never;

      yield* Ref.set(active, { id: message.threadId, activeRunId: RunId.make("brain-run") });
      yield* Ref.set(activeMessage, message.messageId);
      yield* Queue.offer(domainEvents, runUpdated("running"));
      assert.equal((yield* Queue.take(pushed)).supervisionReviewing, reviewed);

      yield* Ref.set(active, null);
      yield* Queue.offer(domainEvents, runUpdated("completed"));
      assert.equal((yield* Queue.take(pushed)).supervisionReviewing, null);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "greets the owner once, when the first brain is chosen, without waiting on the greeting",
  () =>
    Effect.gen(function* () {
      const { sends, attempted, gate, layer } = yield* harness({ holdSends: true });
      yield* Effect.gen(function* () {
        const agent = yield* OrchestratorAgent.OrchestratorAgent;
        // The greeting is held at the gate, so choosing the brain has already returned.
        yield* agent.setBrain({ brain });
        assert.deepStrictEqual(yield* Ref.get(sends), []);
        yield* Deferred.succeed(gate, undefined);
        yield* Deferred.await(attempted);
        const [greeting] = yield* Ref.get(sends);
        assert.equal(greeting?.createdBy, "system");
        assert.isTrue(greeting?.messageId.startsWith("orchestrator-wake-") === true);
        yield* agent.setBrain({ brain: { ...brain, model: "haiku" } });
        assert.equal((yield* Ref.get(sends)).length, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("a failed greeting does not fail choosing the brain", () =>
  Effect.gen(function* () {
    const { sends, failSends, attempted, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* Ref.set(failSends, true);
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      assert.deepStrictEqual((yield* agent.snapshot).brain, brain);
      assert.deepStrictEqual(yield* Ref.get(sends), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("toggles the owner's reaction, replaces it with another emoji, and queues a note", () =>
  Effect.gen(function* () {
    const { attempted, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      const turns = yield* OrchestratorTurnContext.OrchestratorTurnContext;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      const threadId = (yield* agent.snapshot).threadId!;
      const messageId = "turn-item:message:owner-1";
      const reacted = { messageId, emoji: "👍", excerpt: "Shipped the fix" };

      yield* agent.react(reacted);
      assert.deepStrictEqual((yield* agent.snapshot).reactions, {
        [messageId]: [{ emoji: "👍", by: "owner" }],
      });
      assert.deepStrictEqual(yield* turns.takeNotes(threadId), [
        'The owner reacted 👍 to your message: "Shipped the fix"',
      ]);

      yield* agent.react({ ...reacted, emoji: "🎉" });
      assert.deepStrictEqual((yield* agent.snapshot).reactions, {
        [messageId]: [{ emoji: "🎉", by: "owner" }],
      });
      yield* turns.takeNotes(threadId);

      yield* agent.react({ ...reacted, emoji: "🎉" });
      assert.deepStrictEqual((yield* agent.snapshot).reactions, {});
      assert.deepStrictEqual(yield* turns.takeNotes(threadId), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("keeps the newest 200 reacted messages", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      for (let index = 0; index <= 200; index += 1) {
        yield* agent.react({ messageId: `message-${index}`, emoji: "👍" });
      }
      const keys = Object.keys((yield* agent.snapshot).reactions ?? {});
      assert.equal(keys.length, 200);
      assert.equal(keys[0], "message-1");
      assert.equal(keys.at(-1), "message-200");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reacts to the owner's latest message, and toggles as the owner does", () =>
  Effect.gen(function* () {
    const { attempted, ownerMessages, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      yield* Ref.set(ownerMessages, [
        {
          id: MessageId.make("owner-old"),
          createdBy: "user",
          createdAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
        },
        {
          id: MessageId.make("greeting"),
          createdBy: "system",
          createdAt: DateTime.makeUnsafe("2026-08-01T10:05:00.000Z"),
        },
        {
          id: MessageId.make("owner-new"),
          createdBy: "user",
          createdAt: DateTime.makeUnsafe("2026-08-01T10:03:00.000Z"),
        },
      ]);
      const key = "turn-item:message:owner-new";
      assert.deepStrictEqual(yield* agent.reactToOwner("👍"), { emoji: "👍", reacted: true });
      assert.deepStrictEqual((yield* agent.snapshot).reactions, {
        [key]: [{ emoji: "👍", by: "orchestrator" }],
      });
      assert.deepStrictEqual(yield* agent.reactToOwner("👍"), { emoji: "👍", reacted: false });
      assert.deepStrictEqual((yield* agent.snapshot).reactions, {});

      yield* Ref.set(ownerMessages, []);
      const failure = yield* agent.reactToOwner("👍").pipe(Effect.flip);
      assert.equal(failure.code, "invalid_request");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("moves the owner's read position forward and never back", () =>
  Effect.gen(function* () {
    const { layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      assert.isNull((yield* agent.snapshot).ownerReadAt);
      yield* agent.markRead({ through: "2026-08-01T10:00:00.000Z" });
      yield* agent.markRead({ through: "2026-08-01T09:00:00.000Z" });
      assert.equal((yield* agent.snapshot).ownerReadAt, "2026-08-01T10:00:00.000Z");
      yield* agent.markRead({ through: "2026-08-01T11:00:00.000Z" });
      assert.equal((yield* agent.snapshot).ownerReadAt, "2026-08-01T11:00:00.000Z");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("wakes the orchestrator once per pass, naming each followed thread that ended", () =>
  Effect.gen(function* () {
    const { sends, shells, attempted, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      yield* Ref.set(sends, []);
      const work = ThreadId.make("work");
      const other = ThreadId.make("other");
      const gone = ThreadId.make("gone");
      const setShell = (threadId: ThreadId, value: TestShell | null) =>
        Ref.update(shells, (known) => new Map(known).set(threadId, value));
      yield* setShell(
        work,
        shell({ id: work, title: "Work", status: "running", activeRunId: RunId.make("run-1") }),
      );
      yield* setShell(
        other,
        shell({ id: other, title: "Other", status: "running", activeRunId: RunId.make("run-2") }),
      );
      yield* setShell(
        gone,
        shell({ id: gone, title: "Gone", status: "running", activeRunId: RunId.make("run-3") }),
      );
      yield* agent.governTool(
        "t3_thread_launch",
        { title: "Work" },
        Effect.succeed({ threadId: work, runId: RunId.make("run-1") }),
      );
      yield* agent.governTool(
        "t3_thread_launch",
        { title: "Other" },
        Effect.succeed({ threadId: other, runId: RunId.make("run-2") }),
      );
      yield* agent.governTool(
        "t3_thread_launch",
        { title: "Gone" },
        Effect.succeed({ threadId: gone, runId: RunId.make("run-3") }),
      );

      yield* agent.checkOrchestrator;
      assert.equal((yield* Ref.get(sends)).length, 0);

      yield* setShell(gone, null);
      yield* setShell(
        work,
        shell({ id: work, title: "Work", status: "completed", activeRunId: null }),
      );
      yield* setShell(
        other,
        shell({ id: other, title: "Other", status: "completed", activeRunId: null }),
      );
      yield* agent.checkOrchestrator;
      const woken = yield* Ref.get(sends);
      assert.equal(woken.length, 1);
      assert.isTrue(woken[0]?.messageId.startsWith("orchestrator-wake-") === true);
      const text = woken[0]?.text ?? "";
      assert.include(text, "[Work](");
      assert.include(text, "[Other](");
      assert.notInclude(text, "Gone");
      assert.include(text, "has finished its run (completed)");

      yield* agent.checkOrchestrator;
      assert.equal((yield* Ref.get(sends)).length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("leaves followed work for later while the brain or its own run is busy", () =>
  Effect.gen(function* () {
    const { attempted, sends, shells, providers, active, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      yield* Ref.set(sends, []);
      const work = ThreadId.make("work");
      yield* Ref.update(shells, (known) =>
        new Map(known).set(work, shell({ id: work, status: "completed", activeRunId: null })),
      );
      yield* agent.governTool(
        "t3_thread_launch",
        { title: "Work" },
        Effect.succeed({ threadId: work, runId: RunId.make("run-1") }),
      );

      yield* Ref.set(providers, [
        provider({ auth: { status: "unauthenticated" } } as Partial<ServerProvider>),
      ]);
      yield* agent.checkOrchestrator;
      assert.deepStrictEqual(yield* Ref.get(sends), []);

      yield* Ref.set(providers, [provider()]);
      const threadId = (yield* agent.snapshot).threadId!;
      yield* Ref.set(active, { id: threadId, activeRunId: RunId.make("brain-run") });
      yield* agent.checkOrchestrator;
      assert.deepStrictEqual(yield* Ref.get(sends), []);

      yield* Ref.set(active, null);
      yield* agent.checkOrchestrator;
      assert.equal((yield* Ref.get(sends)).length, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "pushes the orchestrator's latest reply when it changes, and keeps it through a silent one",
  () =>
    Effect.gen(function* () {
      const { shells, attempted, layer } = yield* harness();
      yield* Effect.gen(function* () {
        const agent = yield* OrchestratorAgent.OrchestratorAgent;
        yield* agent.setBrain({ brain });
        yield* Deferred.await(attempted);
        const threadId = (yield* agent.snapshot).threadId!;
        const setLatest = (role: "user" | "assistant", text: string, at: string) =>
          Ref.update(shells, (known) =>
            new Map(known).set(
              threadId,
              shell({
                id: threadId,
                latestVisibleMessage: {
                  id: MessageId.make(`message-${at}`),
                  role,
                  text,
                  updatedAt: DateTime.makeUnsafe(at),
                },
              }),
            ),
          );
        const pushed = yield* Queue.unbounded<OrchestratorSnapshot>();
        yield* agent.changes.pipe(
          Stream.runForEach((snapshot) => Queue.offer(pushed, snapshot)),
          Effect.forkChild({ startImmediately: true }),
        );
        // Lets the subscriber take what was pushed, then returns the snapshots it received.
        const received = Effect.gen(function* () {
          yield* Effect.yieldNow;
          const count = yield* Queue.size(pushed);
          const snapshots: Array<OrchestratorSnapshot> = [];
          for (let index = 0; index < count; index += 1) snapshots.push(yield* Queue.take(pushed));
          return snapshots;
        });
        // The snapshot a new subscriber starts with.
        assert.equal((yield* received).length, 1);

        yield* setLatest("assistant", "(silent)", "2026-08-01T09:00:00.000Z");
        yield* agent.checkOrchestrator;
        assert.equal((yield* received).length, 0);
        assert.isNull((yield* agent.snapshot).latestMessageAt);

        yield* setLatest("assistant", "Done with the fix.", "2026-08-01T10:00:00.000Z");
        yield* agent.checkOrchestrator;
        const replies = yield* received;
        assert.equal(replies.length, 1);
        assert.equal(replies[0]?.latestMessageAt, "2026-08-01T10:00:00.000Z");
        assert.equal((yield* agent.snapshot).latestMessageAt, "2026-08-01T10:00:00.000Z");

        // A silent reply after a real one keeps the real reply's time: nothing is pushed.
        yield* setLatest("assistant", "(silent)", "2026-08-01T11:00:00.000Z");
        yield* agent.checkOrchestrator;
        assert.equal((yield* received).length, 0);
        assert.equal((yield* agent.snapshot).latestMessageAt, "2026-08-01T10:00:00.000Z");

        yield* agent.checkOrchestrator;
        assert.equal((yield* received).length, 0);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("pushes a settled run's reply without waiting for a tick", () =>
  Effect.gen(function* () {
    const { shells, domainEvents, attempted, layer } = yield* harness();
    yield* Effect.gen(function* () {
      const agent = yield* OrchestratorAgent.OrchestratorAgent;
      yield* agent.setBrain({ brain });
      yield* Deferred.await(attempted);
      const threadId = (yield* agent.snapshot).threadId!;
      const pushed = yield* Queue.unbounded<OrchestratorSnapshot>();
      yield* agent.changes.pipe(
        Stream.runForEach((snapshot) => Queue.offer(pushed, snapshot)),
        Effect.forkChild({ startImmediately: true }),
      );
      // The snapshot a new subscriber starts with.
      yield* Queue.take(pushed);
      yield* Ref.update(shells, (known) =>
        new Map(known).set(
          threadId,
          shell({
            id: threadId,
            latestVisibleMessage: {
              id: MessageId.make("reply-1"),
              role: "assistant",
              text: "Done.",
              updatedAt: DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"),
            },
          }),
        ),
      );
      const runUpdated = (on: ThreadId, status: string) =>
        ({ type: "run.updated", threadId: on, payload: { status } }) as never;

      // A run still going pushes nothing.
      yield* Queue.offer(domainEvents, runUpdated(threadId, "running"));
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(pushed), 0);

      // The run settling pushes the reply straight away: no tick ran.
      yield* Queue.offer(domainEvents, runUpdated(threadId, "completed"));
      const settled = yield* Queue.take(pushed);
      assert.equal(settled.latestMessageAt, "2026-08-01T10:00:00.000Z");

      // A run settling on another thread changes nothing here.
      yield* Queue.offer(domainEvents, runUpdated(ThreadId.make("elsewhere"), "completed"));
      yield* Effect.yieldNow;
      assert.equal(yield* Queue.size(pushed), 0);
    }).pipe(Effect.provide(layer));
  }),
);
