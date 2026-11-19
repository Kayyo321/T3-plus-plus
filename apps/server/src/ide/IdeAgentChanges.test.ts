import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointRef,
  CheckpointScopeId,
  RunId,
  ThreadId,
  threadLane,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as IdeAgentChanges from "./IdeAgentChanges.ts";

const threadId = ThreadId.make("thread:ide-margin");
const otherThreadId = ThreadId.make("thread:ide-margin-other");
const runId = RunId.make("run:ide-margin");
const scopeId = CheckpointScopeId.make("scope:ide-margin");
const afterRef = CheckpointRef.make("refs/t3/test/ide-margin-after");

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerVcs = VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess));
const layerStore = CheckpointStore.layer.pipe(
  Layer.provide(layerVcs),
  Layer.provide(NodeServices.layer),
);
const layerTest = Layer.mergeAll(layerStore, layerVcs, layerVcsProcess).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);

const layerAgentChanges = (cwd: string) =>
  IdeAgentChanges.layer.pipe(
    Layer.provide(CheckpointDiffQuery.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getCheckpointContext: () =>
          Effect.succeed({
            runs: [{ id: runId, ordinal: 1, status: "completed" }],
            checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd }],
            checkpoints: [
              {
                scopeId,
                runId,
                ordinalWithinScope: 1,
                appRunOrdinal: 1,
                status: "ready",
                ref: afterRef,
              },
            ],
          }),
        getThreadShell: () => Effect.succeed({ title: "Fix login" } as OrchestrationV2ThreadShell),
        streamDomainEvents: Stream.never,
      }),
    ),
  );

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

it.effect("marks the latest turn where it sits now, and reverts and reapplies one hunk", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess.VcsProcess;
    const store = yield* CheckpointStore.CheckpointStore;
    const cwd = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-margin-" }));
    const git = (args: ReadonlyArray<string>) =>
      vcs.run({ operation: "IdeAgentChanges.test.git", command: "git", cwd, args });
    const app = path.join(cwd, "app.ts");
    yield* git(["init"]);
    yield* git(["config", "user.email", "test@test.com"]);
    yield* git(["config", "user.name", "Test"]);
    yield* fs.writeFileString(app, `${lines(20).join("\n")}\n`);
    yield* git(["add", "."]);
    yield* git(["commit", "-m", "initial"]);
    yield* store.captureCheckpoint({
      cwd,
      checkpointRef: yield* checkpointRefForScopeOrdinal({ scopeId, ordinalWithinScope: 0 }),
    });

    // The agent's turn: one line replaced, one added further down, one new file.
    const agentLines = lines(20);
    agentLines[1] = "line 2 by agent";
    agentLines.splice(15, 0, "added by agent");
    yield* fs.writeFileString(app, `${agentLines.join("\n")}\n`);
    yield* fs.writeFileString(path.join(cwd, "new.ts"), "export {};\n");
    yield* store.captureCheckpoint({ cwd, checkpointRef: afterRef });
    // The user then adds a line above everything.
    yield* fs.writeFileString(app, `// header\n${agentLines.join("\n")}\n`);

    const agent = yield* IdeAgentChanges.IdeAgentChanges.pipe(
      Effect.provide(layerAgentChanges(cwd)),
    );
    const unbound = yield* agent.changes({ folder: cwd });
    assert.deepEqual(unbound, { version: "none", thread: null, files: [] });

    yield* agent.bind(cwd, threadId);
    const feed = yield* agent.changes({ folder: cwd });
    assert.deepEqual(feed.thread, {
      id: threadId,
      title: "Fix login",
      initial: "F",
      lane: threadLane(threadId),
      turn: 1,
    });
    const appFile = feed.files.find((file) => file.path === app);
    assert.deepEqual(
      appFile?.hunks.map((hunk) => hunk.changes),
      [[{ kind: "modified", line: 3, count: 1 }], [{ kind: "added", line: 17, count: 1 }]],
    );
    const created = feed.files.find((file) => file.path === path.join(cwd, "new.ts"));
    assert.deepEqual(created?.hunks[0]?.changes, [{ kind: "added", line: 1, count: 1 }]);

    const revert = {
      folder: cwd,
      threadId,
      turn: 1,
      path: app,
      hunkId: appFile!.hunks[0]!.id,
      action: "revert",
    } as const;
    const refused = yield* agent
      .applyHunk({ ...revert, threadId: otherThreadId })
      .pipe(Effect.flip);
    assert.strictEqual(refused.reason, "change_unavailable");

    yield* agent.applyHunk(revert);
    const reverted = lines(20);
    reverted.splice(15, 0, "added by agent");
    assert.strictEqual(yield* fs.readFileString(app), `// header\n${reverted.join("\n")}\n`);
    const afterRevert = yield* agent.changes({ folder: cwd });
    assert.deepEqual(
      afterRevert.files.find((file) => file.path === app)?.hunks.map((hunk) => hunk.id),
      [appFile!.hunks[1]!.id],
    );

    const removeCreated = { ...revert, path: created!.path, hunkId: created!.hunks[0]!.id };
    yield* agent.applyHunk(removeCreated);
    assert.isFalse(yield* fs.exists(created!.path));
    yield* agent.applyHunk({ ...removeCreated, action: "reapply" });
    assert.strictEqual(yield* fs.readFileString(created!.path), "export {};\n");

    yield* agent.applyHunk({ ...revert, action: "reapply" });
    assert.strictEqual(yield* fs.readFileString(app), `// header\n${agentLines.join("\n")}\n`);
  }).pipe(Effect.provide(layerTest)),
);
