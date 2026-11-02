import {
  chatModeEnforcementForDriver,
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  runtimeModeWithinWorkspace,
  workspaceSecretsReachDriver,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";
import * as ProjectStore from "./ProjectStore.ts";

export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export class ChatModeUnavailableError extends Schema.TaggedError<ChatModeUnavailableError>()(
  "ChatModeUnavailableError",
  { driver: Schema.String },
) {
  override get message(): string {
    return `Chat mode cannot be enforced on ${this.driver}. Choose another provider or switch this thread to Code.`;
  }
}

export class WorkspaceSecretsUnavailableError extends Schema.TaggedError<WorkspaceSecretsUnavailableError>()(
  "WorkspaceSecretsUnavailableError",
  { driver: Schema.String, workspaceName: Schema.String },
) {
  override get message(): string {
    return `Workspace ${this.workspaceName} holds secrets, and ${this.driver} shares a process across conversations, so it cannot receive them without exposing them to others. Choose another provider or detach the workspace.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([
  RuntimePolicyResolveError,
  ChatModeUnavailableError,
  WorkspaceSecretsUnavailableError,
]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3pp/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

// Chat threads never run with approvals off, whatever mode the draft stored.
function chatRuntimeMode(thread: OrchestrationV2AppThread, runtimeMode: RuntimeMode): RuntimeMode {
  return thread.capabilityMode === "chat" ? "approval-required" : runtimeMode;
}

export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: Effect.fn("RuntimePolicyV2.resolve")(function (input) {
    return Effect.succeed({
      runtimeMode: chatRuntimeMode(input.thread, input.thread.runtimeMode),
      interactionMode: input.thread.interactionMode,
      ...(input.thread.capabilityMode === undefined
        ? {}
        : { capabilityMode: input.thread.capabilityMode }),
      cwd: input.thread.worktreePath,
    });
  }),
});

function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const workspaces = yield* WorkspaceProcessEnvironment.WorkspaceProcessEnvironment;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        if (
          input.thread.capabilityMode === "chat" &&
          instance !== undefined &&
          chatModeEnforcementForDriver(instance.driverKind) === null
        ) {
          return yield* new ChatModeUnavailableError({ driver: instance.driverKind });
        }
        const workspace = Option.getOrUndefined(yield* workspaces.forThread(input.thread.id));
        if (
          workspace !== undefined &&
          workspace.secretNames.length > 0 &&
          instance !== undefined &&
          !workspaceSecretsReachDriver(instance.driverKind)
        ) {
          return yield* new WorkspaceSecretsUnavailableError({
            driver: instance.driverKind,
            workspaceName: workspace.workspaceName,
          });
        }
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const cwd =
          input.thread.worktreePath ??
          workspace?.workingRoot ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: providerRuntimeMode(
            chatRuntimeMode(
              input.thread,
              runtimeModeWithinWorkspace(input.thread.runtimeMode, workspace?.settings.runtimeMode),
            ),
            supportedRuntimeModes,
          ),
          interactionMode: input.thread.interactionMode,
          ...(input.thread.capabilityMode === undefined
            ? {}
            : { capabilityMode: input.thread.capabilityMode }),
          cwd,
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
