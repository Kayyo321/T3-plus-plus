import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadCapabilityMode,
  ThreadId,
  WorkspaceId,
} from "@t3tools/contracts";
import { noSecretMask } from "@t3tools/shared/secretRedaction";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
  readonly capabilityMode?: ThreadCapabilityMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    ...(input.capabilityMode === undefined ? {} : { capabilityMode: input.capabilityMode }),
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const piInstanceId = ProviderInstanceId.make("pi");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    driverKind: ProviderDriverKind.make(instanceId),
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerTest = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
      listInstances: Effect.succeed([]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeedSome({
          projectId,
          title: "Project",
          workspaceRoot: "/project-root",
          defaultModelSelection: null,
          defaultThreadEnvMode: null,
          autoPull: false,
          faviconPath: null,
          projectIcon: null,
          scripts: [],
          pinnedAt: null,
          archivedAt: null,
          createdAt: "2026-06-21T00:00:00.000Z",
          updatedAt: "2026-06-21T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
);

const workspaceLaunch = (
  secretNames: ReadonlyArray<string>,
): WorkspaceProcessEnvironment.WorkspaceLaunch => ({
  workspaceId: WorkspaceId.make("workspace-staging"),
  workspaceName: "staging",
  workingRoot: "/srv/staging",
  environment: Redacted.make({}),
  secretNames,
  mask: noSecretMask,
  settings: {},
  fingerprint: "",
});

const withWorkspace = (secretNames: ReadonlyArray<string>) =>
  Layer.fresh(layerTest).pipe(
    Layer.provide(
      Layer.succeed(WorkspaceProcessEnvironment.WorkspaceProcessEnvironment, {
        forThread: () => Effect.succeedSome(workspaceLaunch(secretNames)),
      }),
    ),
  );

const resolveOn = (driver: string) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicy.RuntimePolicyV2;
    const now = yield* DateTime.now;
    return yield* policy.resolve({
      thread: makeThread({ now, worktreePath: null, runtimeMode: "full-access" }),
      modelSelection: { instanceId: ProviderInstanceId.make(driver), model: "test-model" },
    });
  });

it.effect.each(["codex", "opencode", "cursor"])(
  "refuses to run %s, whose process other threads share, with workspace secrets",
  (driver) =>
    Effect.gen(function* () {
      const error = yield* resolveOn(driver).pipe(Effect.flip);
      assert.strictEqual(error._tag, "WorkspaceSecretsUnavailableError");
      assert.include(error.message, "staging");
    }).pipe(Effect.provide(withWorkspace(["DATABASE_URL"]))),
);

it.effect("runs a shared-process provider in a workspace that holds no secrets", () =>
  resolveOn("codex").pipe(
    Effect.map((policy) => assert.strictEqual(policy.cwd, "/srv/staging")),
    Effect.provide(withWorkspace([])),
  ),
);

it.effect("runs a per-session provider in the workspace's working root with its secrets", () =>
  resolveOn("claudeAgent").pipe(
    Effect.map((policy) => assert.strictEqual(policy.cwd, "/srv/staging")),
    Effect.provide(withWorkspace(["DATABASE_URL"])),
  ),
);

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );

  it.effect("carries Chat mode, and refuses a driver that cannot enforce it", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null, capabilityMode: "chat" });

      const enforced = yield* policy.resolve({ thread, modelSelection });
      assert.equal(enforced.capabilityMode, "chat");

      const refused = yield* policy
        .resolve({ thread, modelSelection: { instanceId: piInstanceId, model: "m" } })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "ChatModeUnavailableError");
    }),
  );

  it.effect("keeps a Chat thread on approval-required whatever mode it stores", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (capabilityMode: ThreadCapabilityMode) =>
        policy
          .resolve({
            thread: makeThread({
              now,
              worktreePath: null,
              runtimeMode: "full-access",
              capabilityMode,
            }),
            modelSelection,
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor("chat"), "approval-required");
      assert.equal(yield* modeFor("code"), "full-access");
    }),
  );
});
