// @effect-diagnostics nodeBuiltinImport:off - Reads and edits the real worktree a checkpoint restores.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointRef,
  CommandId,
  MessageId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const DRIVER = ProviderDriverKind.make("claudeAgent");
const INSTANCE = ProviderInstanceId.make("claudeAgent");
const MODEL = { instanceId: INSTANCE, model: "claude-test" };
const PROJECT = ProjectId.make("project:branching");

const NO_ROLLBACK: OrchestrationV2ProviderCapabilities = {
  ...ClaudeProviderCapabilitiesV2,
  threads: { ...ClaudeProviderCapabilitiesV2.threads, canRollbackThread: false },
  checkpointing: {
    ...ClaudeProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
  },
};

/** Each turn writes `turn-<ordinal>.txt`, which is what a checkpoint has to bring back. */
function makeAdapter(input: {
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly rollbacks: Array<number>;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: INSTANCE,
    driver: DRIVER,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const cwd = sessionInput.runtimePolicy.cwd ?? process.cwd();
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: DRIVER,
          providerInstanceId: INSTANCE,
          status: "ready",
          cwd,
          model: MODEL.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: INSTANCE,
          driver: DRIVER,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver: DRIVER,
                providerInstanceId: INSTANCE,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: DRIVER,
                  nativeId: `native:${threadInput.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                contextUsage: null,
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              if (sessionInput.runtimePolicy.cwd !== undefined) {
                NodeFS.writeFileSync(
                  NodePath.join(cwd, `turn-${turnInput.runOrdinal}.txt`),
                  "written by the agent",
                );
              }
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              const providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  driver: DRIVER,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: DRIVER,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: DRIVER,
                  turnItem: {
                    id: TurnItemId.make(`turn-item:${turnInput.threadId}:${turnInput.runOrdinal}`),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: `Reply to turn ${turnInput.runOrdinal}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: DRIVER,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ];
              for (const event of providerEvents) yield* PubSub.publish(events, event);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("not read in this test"),
          rollbackThread: (rollbackInput) =>
            Effect.sync(() => {
              input.rollbacks.push(rollbackInput.target.appRunOrdinal);
              return {
                providerThread: rollbackInput.providerThread,
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              };
            }),
          forkThread: () => Effect.die("not forked natively in this test"),
        };
        return runtime;
      }),
  };
}

const layerFor = (
  name: string,
  capabilities: OrchestrationV2ProviderCapabilities,
  rollbacks: Array<number>,
) =>
  ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([makeAdapter({ capabilities, rollbacks })]),
    { runEffectWorker: true },
  );

const createThread = (threadId: ThreadId, worktreePath: string | null) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: PROJECT,
      title: "Source",
      modelSelection: MODEL,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: worktreePath === null ? null : "main",
      worktreePath,
      createdBy: "user",
      creationSource: "web",
    });
  });

const sendTurn = (threadId: ThreadId, label: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${label}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${label}`),
      text: `Prompt ${label}`,
      attachments: [],
      modelSelection: MODEL,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    return yield* waitForIdle(threadId);
  });

// Projections commit with their events, so each later event is the only time to re-read.
const waitForProjection = Effect.fn("ThreadBranchTest.waitForProjection")(function* (
  threadId: ThreadId,
  ready: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const afterSequence = yield* eventSink.latestSequence();
  const current = yield* orchestrator.getThreadProjection(threadId);
  if (ready(current)) return current;
  const [settled] = yield* eventSink.stream({ afterSequence }).pipe(
    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    Stream.filter(ready),
    Stream.take(1),
    Stream.runCollect,
  );
  return settled ?? (yield* Effect.die("The event stream ended before the thread settled."));
});

const waitForIdle = (threadId: ThreadId) =>
  waitForProjection(threadId, (projection) =>
    projection.runs.every((run) => ["completed", "rolled_back", "cancelled"].includes(run.status)),
  );

const checkpointFor = (threadId: ThreadId, appRunOrdinal: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const checkpoint = projection.checkpoints.find(
      (candidate) => candidate.appRunOrdinal === appRunOrdinal,
    );
    assert.isDefined(checkpoint);
    return checkpoint!;
  });

const threeTurnThread = (name: string) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const threadId = ThreadId.make(`thread:${name}`);
    yield* createThread(threadId, cwd);
    yield* sendTurn(threadId, "one");
    yield* sendTurn(threadId, "two");
    yield* sendTurn(threadId, "three");
    return { cwd, threadId };
  });

const snapshotRef = (cwd: string, name: string) => {
  const ref = CheckpointRef.make(`refs/t3/orchestration-v2/rewinds/test/${name}`);
  NodeChildProcess.spawnSync("git", ["add", "-A"], { cwd });
  const tree = NodeChildProcess.spawnSync("git", ["write-tree"], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
  const commit = NodeChildProcess.spawnSync("git", ["commit-tree", tree, "-m", "snapshot"], {
    cwd,
    encoding: "utf8",
  }).stdout.trim();
  NodeChildProcess.spawnSync("git", ["update-ref", ref, commit], { cwd });
  NodeChildProcess.spawnSync("git", ["reset"], { cwd });
  return ref;
};

const rewind = (input: {
  readonly threadId: ThreadId;
  readonly turn: number;
  readonly mode: "conversation" | "files" | "both";
  readonly tail: ThreadId;
  readonly snapshot: CheckpointRef | null;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const checkpoint = yield* checkpointFor(input.threadId, input.turn);
    yield* orchestrator.dispatch({
      type: "checkpoint.rollback",
      commandId: CommandId.make(`rewind:${input.tail}`),
      threadId: input.threadId,
      scopeId: checkpoint.scopeId,
      checkpointId: checkpoint.id,
      restoreFiles: input.mode !== "conversation",
      ...(input.mode === "files" ? { filesOnly: true } : {}),
      keepTail: { targetThreadId: input.tail, snapshotRef: input.snapshot },
    });
    return yield* waitForProjection(input.threadId, (projection) =>
      input.mode === "files"
        ? projection.thread.filesRewound !== undefined
        : projection.runs.every((run) => run.ordinal <= input.turn || run.status === "rolled_back"),
    );
  });

const visibleMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const snapshot = yield* orchestrator.getThreadSnapshot(threadId);
    return snapshot.projection.visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
    );
  });

describe("rewind", () => {
  it.live("conversation only drops later turns, keeps files, and keeps a reopenable branch", () => {
    const rollbacks: Array<number> = [];
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { cwd, threadId } = yield* threeTurnThread("rewind-conversation");
      const tail = ThreadId.make("tail:conversation");

      const after = yield* rewind({
        threadId,
        turn: 1,
        mode: "conversation",
        tail,
        snapshot: null,
      });

      assert.deepEqual(rollbacks, [1]);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["completed", "rolled_back", "rolled_back"],
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(cwd, "turn-3.txt")));
      assert.deepEqual(yield* visibleMessages(threadId), ["Prompt one", "Reply to turn 1"]);

      const branch = yield* orchestrator.getThreadProjection(tail);
      assert.isNotNull(branch.thread.archivedAt);
      assert.equal(branch.thread.rewindTail?.mode, "conversation");
      assert.equal(branch.thread.rewindTail?.discardedRunIds.length, 2);
      assert.deepEqual(yield* visibleMessages(tail), [
        "Prompt one",
        "Reply to turn 1",
        "Prompt two",
        "Reply to turn 2",
        "Prompt three",
        "Reply to turn 3",
      ]);

      yield* orchestrator.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.make("reopen:conversation"),
        threadId: tail,
      });
      assert.isNull((yield* orchestrator.getThreadProjection(tail)).thread.archivedAt);

      const fork = ThreadId.make("fork-of-tail:conversation");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork:conversation-tail"),
        sourceThreadId: tail,
        targetThreadId: fork,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      });
      assert.lengthOf((yield* visibleMessages(fork)).slice(0, 6), 6);
    }).pipe(
      Effect.provide(layerFor("rewind-conversation", ClaudeProviderCapabilitiesV2, rollbacks)),
    );
  });

  it.live("files only restores files and leaves the conversation and provider alone", () => {
    const rollbacks: Array<number> = [];
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { cwd, threadId } = yield* threeTurnThread("rewind-files");
      const tail = ThreadId.make("tail:files");
      const snapshot = snapshotRef(cwd, "files");

      const after = yield* rewind({ threadId, turn: 1, mode: "files", tail, snapshot });

      assert.deepEqual(rollbacks, []);
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["completed", "completed", "completed"],
      );
      assert.isTrue(NodeFS.existsSync(NodePath.join(cwd, "turn-1.txt")));
      assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "turn-2.txt")));
      assert.equal(after.thread.filesRewound?.appRunOrdinal, 1);

      const branch = yield* orchestrator.getThreadProjection(tail);
      assert.equal(branch.thread.rewindTail?.snapshotRef, snapshot);
      assert.deepEqual(branch.thread.rewindTail?.discardedRunIds, []);
    }).pipe(Effect.provide(layerFor("rewind-files", ClaudeProviderCapabilitiesV2, rollbacks)));
  });

  it.live("both restores files and rolls the conversation back", () => {
    const rollbacks: Array<number> = [];
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { cwd, threadId } = yield* threeTurnThread("rewind-both");
      const tail = ThreadId.make("tail:both");
      const before = NodeFS.readFileSync(NodePath.join(cwd, "turn-3.txt"), "utf8");

      const after = yield* rewind({
        threadId,
        turn: 2,
        mode: "both",
        tail,
        snapshot: snapshotRef(cwd, "both"),
      });

      assert.deepEqual(rollbacks, [2]);
      assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "turn-3.txt")));
      assert.isTrue(NodeFS.existsSync(NodePath.join(cwd, "turn-2.txt")));
      assert.deepEqual(
        after.runs.map((run) => run.status),
        ["completed", "completed", "rolled_back"],
      );
      assert.equal(before, "written by the agent");
      const branch = yield* orchestrator.getThreadProjection(tail);
      assert.equal(branch.thread.rewindTail?.mode, "both");
      const stale = (yield* orchestrator.getThreadProjection(threadId)).checkpoints.find(
        (checkpoint) => checkpoint.appRunOrdinal === 3,
      );
      assert.equal(stale?.status, "stale");
    }).pipe(Effect.provide(layerFor("rewind-both", ClaudeProviderCapabilitiesV2, rollbacks)));
  });

  it.live("a second rewind does not revive the turns an earlier one took", () => {
    const rollbacks: Array<number> = [];
    return Effect.gen(function* () {
      const { threadId } = yield* threeTurnThread("rewind-twice");
      yield* rewind({
        threadId,
        turn: 2,
        mode: "conversation",
        tail: ThreadId.make("tail:first"),
        snapshot: null,
      });
      yield* sendTurn(threadId, "four");
      yield* rewind({
        threadId,
        turn: 2,
        mode: "conversation",
        tail: ThreadId.make("tail:second"),
        snapshot: null,
      });
      const shown = yield* visibleMessages(ThreadId.make("tail:second"));
      assert.notInclude(shown, "Prompt three");
      assert.include(shown, "Prompt four");
    }).pipe(Effect.provide(layerFor("rewind-twice", ClaudeProviderCapabilitiesV2, rollbacks)));
  });

  it.live(
    "a provider that cannot roll back refuses before files move, and still allows files only",
    () => {
      const rollbacks: Array<number> = [];
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { cwd, threadId } = yield* threeTurnThread("rewind-unsupported");
        const checkpoint = yield* checkpointFor(threadId, 1);

        const refused = yield* orchestrator
          .dispatch({
            type: "checkpoint.rollback",
            commandId: CommandId.make("rewind:refused"),
            threadId,
            scopeId: checkpoint.scopeId,
            checkpointId: checkpoint.id,
            restoreFiles: true,
            keepTail: { targetThreadId: ThreadId.make("tail:refused"), snapshotRef: null },
          })
          .pipe(Effect.flip);
        assert.equal(refused._tag, "OrchestratorDispatchError");
        assert.isTrue(NodeFS.existsSync(NodePath.join(cwd, "turn-3.txt")));
        assert.isNull(yield* orchestrator.getThreadShell(ThreadId.make("tail:refused")));

        yield* rewind({
          threadId,
          turn: 1,
          mode: "files",
          tail: ThreadId.make("tail:files-only"),
          snapshot: null,
        });
        assert.isFalse(NodeFS.existsSync(NodePath.join(cwd, "turn-3.txt")));
        assert.deepEqual(rollbacks, []);
      }).pipe(Effect.provide(layerFor("rewind-unsupported", NO_ROLLBACK, rollbacks)));
    },
  );
});

describe("fork from a message", () => {
  it.live("a user message forks before it; a later assistant row cuts its turn", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:message-fork");
      yield* createThread(threadId, null);
      yield* sendTurn(threadId, "one");
      yield* sendTurn(threadId, "two");

      const beforeTwo = ThreadId.make("fork:before-two");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork:before-two"),
        sourceThreadId: threadId,
        targetThreadId: beforeTwo,
        sourcePoint: { type: "message", messageId: MessageId.make(`message:${threadId}:two`) },
        createdBy: "user",
        creationSource: "web",
      });
      assert.deepEqual(yield* visibleMessages(beforeTwo), ["Prompt one", "Reply to turn 1"]);

      const refused = yield* orchestrator
        .dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork:before-one"),
          sourceThreadId: threadId,
          targetThreadId: ThreadId.make("fork:before-one"),
          sourcePoint: { type: "message", messageId: MessageId.make(`message:${threadId}:one`) },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
    }).pipe(Effect.provide(layerFor("message-fork", ClaudeProviderCapabilitiesV2, []))),
  );
});

describe("nested sessions", () => {
  const nest = (parent: ThreadId, child: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(`nest:${child}`),
        sourceThreadId: parent,
        targetThreadId: child,
        sourcePoint: { type: "latest_stable" },
        nested: { inherit: "none" },
        createdBy: "user",
        creationSource: "web",
      });
    });

  it.live("stops at two levels and keeps the lineage older clients can read", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("thread:nesting-root");
      const first = ThreadId.make("thread:nesting-one");
      const second = ThreadId.make("thread:nesting-two");
      yield* createThread(root, null);

      yield* nest(root, first);
      yield* nest(first, second);
      const refused = yield* nest(second, ThreadId.make("thread:nesting-three")).pipe(Effect.flip);

      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.match(String(refused.cause), /2 levels deep/);
      const child = yield* orchestrator.getThreadProjection(first);
      assert.deepEqual(child.thread.lineage, {
        parentThreadId: root,
        relationshipToParent: "fork",
        rootThreadId: root,
        nestedSession: true,
      });
      assert.isNull(child.thread.forkedFrom);
      assert.deepEqual(child.contextTransfers, []);
    }).pipe(Effect.provide(layerFor("nesting-depth", ClaudeProviderCapabilitiesV2, []))),
  );

  it.live("delivers a chosen seed with the first prompt, and a report lands as a card", () => {
    const capabilities = AcpProviderCapabilitiesV2;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const root = ThreadId.make("thread:seed-root");
      const child = ThreadId.make("thread:seed-child");
      yield* createThread(root, null);
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("nest:seeded"),
        sourceThreadId: root,
        targetThreadId: child,
        sourcePoint: { type: "latest_stable" },
        nested: { inherit: "seed", contextSeed: "The parent decided on Postgres." },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* sendTurn(child, "seeded");
      const handoff = projection.contextHandoffs[0];
      assert.equal(handoff?.summaryText, "The parent decided on Postgres.");
      assert.equal(projection.contextTransfers[0]?.status, "consumed");

      yield* orchestrator.dispatch({
        type: "thread.handoff-card.post",
        commandId: CommandId.make("card:seeded"),
        threadId: root,
        notification: {
          source: { kind: "handoff", childThreadId: child },
          outcome: "completed",
          summary: "Migration finished",
        },
      });
      const parent = yield* orchestrator.getThreadSnapshot(root);
      const card = parent.projection.visibleTurnItems.find(
        ({ item }) => item.type === "notification",
      );
      assert.equal(
        card?.item.type === "notification" ? card.item.summary : null,
        "Migration finished",
      );
      assert.deepEqual(parent.projection.runs, []);
    }).pipe(Effect.provide(layerFor("nesting-seed", capabilities, [])));
  });
});
