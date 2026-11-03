import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  MessageId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import { CommandPolicyV2 } from "./CommandPolicy.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadBranchService from "./ThreadBranchService.ts";

const ACTOR = { kind: "user", createdBy: "user", creationSource: "web" } as const;
const THREAD = ThreadId.make("thread:branching");
const SCOPE = CheckpointScopeId.make("scope:branching");
const SNAPSHOT = CheckpointRef.make("refs/t3/orchestration-v2/rewinds/scope/tail");

const run = (ordinal: number, status: OrchestrationV2Run["status"] = "completed") =>
  ({ id: RunId.make(`run:${ordinal}`), ordinal, status, userMessageId: null }) as never;

const checkpoint = (appRunOrdinal: number | null): OrchestrationV2Checkpoint =>
  ({
    id: CheckpointId.make(`checkpoint:${appRunOrdinal}`),
    scopeId: SCOPE,
    appRunOrdinal,
    ordinalWithinScope: appRunOrdinal ?? 0,
    status: "ready",
    ref: CheckpointRef.make(`refs/t3/checkpoint/${appRunOrdinal}`),
  }) as never;

describe("checkpointForTarget", () => {
  const checkpoints = [checkpoint(null), checkpoint(1), checkpoint(2), checkpoint(3)];
  const runs = [run(1), run(2, "rolled_back"), run(3)];
  const target = { type: "message", messageId: MessageId.make("message:m") } as const;

  it("returns a user message to before its turn, skipping rolled-back turns", () => {
    const found = ThreadBranchService.checkpointForTarget({
      target,
      checkpoints,
      runs,
      message: { role: "user", runId: RunId.make("run:3") },
    });
    assert.equal(found?.appRunOrdinal, 1);
  });

  it("returns an assistant message to the end of its turn", () => {
    const found = ThreadBranchService.checkpointForTarget({
      target,
      checkpoints,
      runs,
      message: { role: "assistant", runId: RunId.make("run:3") },
    });
    assert.equal(found?.appRunOrdinal, 3);
  });

  it("falls back to the baseline before the first turn", () => {
    const found = ThreadBranchService.checkpointForTarget({
      target,
      checkpoints,
      runs,
      message: { role: "user", runId: RunId.make("run:1") },
    });
    assert.equal(found?.appRunOrdinal, null);
  });

  it("finds a turn with no file snapshot, even once a later baseline cleared its ordinal", () => {
    const missing = (ordinalWithinScope: number, appRunOrdinal: number | null) =>
      ({ ...checkpoint(appRunOrdinal), ordinalWithinScope, status: "missing" }) as never;
    const found = ThreadBranchService.checkpointForTarget({
      target,
      checkpoints: [missing(0, null), missing(1, null), missing(2, 2)],
      runs: [run(1), run(2)],
      message: { role: "user", runId: RunId.make("run:2") },
    });
    assert.equal(found?.ordinalWithinScope, 1);
  });

  it("never returns to a stale checkpoint", () => {
    const stale = { ...checkpoint(1), status: "stale" } as never;
    const found = ThreadBranchService.checkpointForTarget({
      target,
      checkpoints: [checkpoint(null), stale],
      runs: [run(1), run(2)],
      message: { role: "user", runId: RunId.make("run:2") },
    });
    assert.equal(found?.ordinalWithinScope, 0);
  });
});

const harness = (
  dispatched: Array<OrchestrationV2ServerCommand>,
  deletedRefs: Array<string>,
  status: OrchestrationV2Checkpoint["status"] = "ready",
) =>
  ThreadBranchService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command: OrchestrationV2ServerCommand) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 7 } as never;
            }),
        }),
        Layer.mock(ProjectionStoreV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: THREAD },
              runs: [run(1), run(2)],
              messages: [],
              checkpoints: [checkpoint(1), checkpoint(2)].map((row) => ({ ...row, status })),
              checkpointScopes: [{ id: SCOPE, cwd: "/work" }],
              providerThreads: [],
            }) as never,
        }),
        Layer.mock(CheckpointServiceV2)({
          snapshotWorkspace: () => Effect.succeed(SNAPSHOT),
          listChanges: (input) =>
            Effect.succeed(
              input.from === checkpoint(2).ref
                ? [{ path: "edited-by-hand.txt", additions: 1, deletions: 0 }]
                : [],
            ),
          deleteRef: (input) =>
            Effect.sync(() => {
              deletedRefs.push(input.ref);
            }),
        }),
        Layer.mock(CommandPolicyV2)({}),
        Layer.mock(ProviderAdapterRegistryV2)({}),
        Layer.mock(ProjectStore.ProjectStoreV2)({}),
        Layer.mock(GitWorkflowService.GitWorkflowService)({}),
        Layer.mock(AuditTrail.AuditTrail)({ record: () => Effect.void }),
        NodeServices.layer,
      ),
    ),
  );

const input = (outsideChanges?: "stash" | "discard") =>
  ({
    commandId: CommandId.make("command:rewind"),
    threadId: THREAD,
    target: { type: "checkpoint", checkpointId: checkpoint(1).id },
    mode: "files",
    tailThreadId: ThreadId.make("thread:tail"),
    ...(outsideChanges === undefined ? {} : { outsideChanges }),
  }) as const;

describe("rewinding over changes made outside the agent", () => {
  it.effect("refuses until the user chooses, and leaves no snapshot behind", () => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const deletedRefs: Array<string> = [];
    return Effect.gen(function* () {
      const service = yield* ThreadBranchService.ThreadBranchService;
      const error = yield* service.rewind(input(), ACTOR).pipe(Effect.flip);
      assert.equal(error.reason, "outside-changes");
      assert.deepEqual(dispatched, []);
      assert.deepEqual(deletedRefs, [SNAPSHOT]);
    }).pipe(Effect.provide(harness(dispatched, deletedRefs)));
  });

  it.effect("stashes exactly the outside paths when asked, and keeps the snapshot", () => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return Effect.gen(function* () {
      const service = yield* ThreadBranchService.ThreadBranchService;
      const result = yield* service.rewind(input("stash"), ACTOR);
      assert.equal(result.stashedPaths, 1);
      const command = dispatched[0];
      assert.equal(command?.type, "checkpoint.rollback");
      if (command?.type !== "checkpoint.rollback") return;
      assert.isTrue(command.filesOnly);
      assert.deepEqual(command.keepTail, {
        targetThreadId: ThreadId.make("thread:tail"),
        snapshotRef: SNAPSHOT,
        stashPaths: ["edited-by-hand.txt"],
      });
    }).pipe(Effect.provide(harness(dispatched, [])));
  });
});

describe("rewinding where there are no file snapshots", () => {
  it.effect("rewinds the conversation and leaves files out of it", () => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return Effect.gen(function* () {
      const service = yield* ThreadBranchService.ThreadBranchService;
      yield* service.rewind({ ...input(), mode: "conversation" }, ACTOR);
      const command = dispatched[0];
      assert.equal(command?.type, "checkpoint.rollback");
      if (command?.type !== "checkpoint.rollback") return;
      assert.isFalse(command.restoreFiles);
    }).pipe(Effect.provide(harness(dispatched, [], "missing")));
  });

  it.effect.each(["files", "both"] as const)("refuses to restore %s", (mode) => {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    return Effect.gen(function* () {
      const service = yield* ThreadBranchService.ThreadBranchService;
      const error = yield* service.rewind({ ...input(), mode }, ACTOR).pipe(Effect.flip);
      assert.equal(error.reason, "target-invalid");
      assert.deepEqual(dispatched, []);
    }).pipe(Effect.provide(harness(dispatched, [], "missing")));
  });
});
