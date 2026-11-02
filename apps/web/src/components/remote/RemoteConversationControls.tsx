import {
  type OrchestrationV2ThreadProjection,
  type ProviderInteractionMode,
  REMOTE_CONTROL_PROVIDERS_ROUTE,
  RemoteControlProviders,
  type RemoteControlView,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { deriveProviderInstanceEntries } from "~/providerInstances";

import { ComposerEffortColumn, describeComposerEffort } from "../chat/ComposerModelEffort";
import { ComposerFooterModeControls } from "../chat/ComposerFooterControls";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { resolveCompatibleRuntimeMode, runtimeModeConfig } from "../chat/runtimeModeConfig";
import type { TraitsSelectionInput } from "../chat/TraitsPicker";

const decodeProviders = Schema.decodeUnknownOption(Schema.toCodecJson(RemoteControlProviders));

function useRemoteProviders(url: string, enabled: boolean) {
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the owner's model list when this device gains the permission, and ignores the answer after cleanup
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void fetch(url)
      .then((response) => response.json())
      .then((json: unknown) => {
        const decoded = Option.getOrNull(decodeProviders(json));
        if (live && decoded !== null) setProviders(decoded.providers);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, url]);
  return providers;
}

export const remoteProvidersUrl = (routeFor: (route: string) => string) =>
  routeFor(REMOTE_CONTROL_PROVIDERS_ROUTE);

/** The app composer's own model picker and mode chips, fed by what this device may change. */
export function RemoteComposerControls({
  view,
  projection,
  providersUrl,
  onModel,
  onMode,
}: {
  readonly view: RemoteControlView;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly providersUrl: string;
  readonly onModel: (modelSelection: RemoteControlView["modelSelection"]) => void;
  readonly onMode: (body: {
    readonly interactionMode?: ProviderInteractionMode;
    readonly runtimeMode?: RuntimeMode;
  }) => void;
}) {
  const canChangeModel = view.permissions.includes("model");
  const canChangeMode = view.permissions.includes("mode");
  const providers = useRemoteProviders(providersUrl, canChangeModel);
  const entries = deriveProviderInstanceEntries(providers);
  const modelOptionsByInstance = new Map(entries.map((entry) => [entry.instanceId, entry.models]));
  const { modelSelection } = view;
  const activeEntry = entries.find((entry) => entry.instanceId === modelSelection.instanceId);
  const started = projection.visibleTurnItems.length > 0;
  const { interactionMode, runtimeMode } = projection.thread;
  const runtime = resolveCompatibleRuntimeMode(
    runtimeMode,
    activeEntry?.snapshot.supportedRuntimeModes,
  );
  const traits: TraitsSelectionInput | null =
    activeEntry === undefined
      ? null
      : {
          provider: activeEntry.driverKind,
          instanceId: activeEntry.instanceId,
          models: activeEntry.models,
          model: modelSelection.model,
          modelOptions: modelSelection.options ?? null,
          planModeEnabled: interactionMode === "plan",
          onModelOptionsChange: (options) =>
            onModel(
              createModelSelection(modelSelection.instanceId, modelSelection.model, options ?? []),
            ),
        };
  const effort = describeComposerEffort(traits, "label", "sm");
  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      {canChangeModel && activeEntry !== undefined ? (
        <ProviderModelPicker
          environmentId={null}
          activeInstanceId={modelSelection.instanceId}
          model={modelSelection.model}
          // A started conversation keeps its provider, as in the app without a handoff.
          lockedProvider={started ? activeEntry.driverKind : null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptionsByInstance}
          size="sm"
          popupAlign="start"
          triggerSuffix={effort.suffix}
          triggerDetail={effort.detail}
          effortColumn={<ComposerEffortColumn traits={traits} />}
          onInstanceModelChange={(instanceId, model) =>
            onModel(createModelSelection(instanceId, model))
          }
        />
      ) : null}
      {canChangeMode && view.capabilityMode === "code" ? (
        <ComposerFooterModeControls
          showInteractionModeToggle
          interactionMode={interactionMode}
          runtimeMode={runtime.mode}
          runtimeModeOptions={runtime.modes.map((mode) => ({ mode, ...runtimeModeConfig[mode] }))}
          size="sm"
          accessDisplay="icon"
          onToggleInteractionMode={() =>
            onMode({ interactionMode: interactionMode === "plan" ? "default" : "plan" })
          }
          onRuntimeModeChange={(mode) => onMode({ runtimeMode: mode })}
        />
      ) : null}
    </div>
  );
}
