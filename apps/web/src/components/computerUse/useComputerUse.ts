import { useAtomValue } from "@effect/atom-react";
import {
  AuthPreviewOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { usePreviewAvailable } from "../../browser/previewRuntime";
import { useThreadPreviewState } from "../../previewStateStore";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { rightPanelHostRef } from "../../rightPanelStore";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  computerUseBannerModel,
  computerUseStartModel,
  type ComputerUsePermissions,
} from "./computerUse.logic";

/** Never disabled by the setting: a session outlives it, and Stop must stay reachable. */
export function useComputerUseSnapshot(threadRef: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    threadRef === null
      ? null
      : serverEnvironment.computerUseLive({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  ).data;
}

function useComputerUsePermissions(environmentId: EnvironmentId): ComputerUsePermissions {
  return {
    start: useAtomValue(serverEnvironment.startComputerUse.permissionAtom(environmentId)),
    stop: useAtomValue(serverEnvironment.stopComputerUse.permissionAtom(environmentId)),
    takeOver: useAtomValue(serverEnvironment.takeOverComputerUse.permissionAtom(environmentId)),
    resume: useAtomValue(serverEnvironment.resumeComputerUse.permissionAtom(environmentId)),
    answerApproval: useAtomValue(
      serverEnvironment.answerComputerUseApproval.permissionAtom(environmentId),
    ),
  };
}

/** Null while nothing is running. */
export function useComputerUseBanner(threadRef: ScopedThreadRef) {
  const snapshot = useComputerUseSnapshot(threadRef);
  const permissions = useComputerUsePermissions(threadRef.environmentId);
  const previewAvailable = usePreviewAvailable(threadRef.environmentId);
  const canOperatePreview = useEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope);
  const hasBrowserTab = useThreadPreviewState(rightPanelHostRef(threadRef)).activeTabId !== null;
  return computerUseBannerModel(
    snapshot?.state ?? null,
    permissions,
    // A viewer who cannot open a tab has nothing to reveal until one exists.
    previewAvailable && (hasBrowserTab || canOperatePreview),
  );
}

/** What this client may do about computer use in a conversation, whatever its state. */
export function useComputerUseControls(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId ?? ("" as EnvironmentId);
  const snapshot = useComputerUseSnapshot(threadRef);
  const permissions = useComputerUsePermissions(environmentId);
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const thread = useQuietThreadShell(threadRef);
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const settingEnabled = settings?.computerUseEnabled === true;
  const support = useEnvironmentQuery(
    threadRef !== null && settingEnabled
      ? serverEnvironment.computerUseSupport({ environmentId, input: {} })
      : null,
  );
  const instanceId = thread?.runtime?.providerInstanceId ?? thread?.modelSelection?.instanceId;
  const provider = providers.find((entry) => entry.instanceId === instanceId) ?? null;
  const capabilityMode = thread?.capabilityMode;
  const status = snapshot?.state.status ?? "off";
  return {
    settingEnabled,
    capabilityMode,
    canStart: permissions.start,
    canStop: permissions.stop,
    status,
    start:
      thread === null || snapshot === null
        ? null
        : computerUseStartModel({
            settingEnabled,
            capabilityMode,
            status,
            canStart: permissions.start,
            driver: provider?.driver ?? null,
            providerName:
              provider === null
                ? null
                : provider.displayName?.trim() || formatProviderDriverKindLabel(provider.driver),
            virtualDisplay: support.data?.virtualDisplay ?? null,
          }),
  };
}
