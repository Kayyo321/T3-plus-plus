import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadCapabilityMode,
} from "@t3tools/contracts";

import { capabilityModeSwitch } from "~/components/chat/capabilityMode.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { readEnvironmentScope } from "~/state/session";
import { threadEnvironment } from "~/state/threads";

export async function setThreadCapabilityMode(
  threadRef: ScopedThreadRef,
  capabilityMode: ThreadCapabilityMode,
): Promise<void> {
  const command = threadEnvironment.setCapabilityMode;
  const result = await runAtomCommand(
    appAtomRegistry,
    command,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, capabilityMode },
    },
    { label: command.label, reportFailure: false, reportDefect: true },
  );
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not change mode",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

/** The keyboard and palette route to the composer's control: same rule, reason as a toast. */
export function toggleThreadCapabilityMode(threadRef: ScopedThreadRef): void {
  const shell = readThreadShell(threadRef);
  if (!shell) return;
  const change = capabilityModeSwitch({
    mode: shell.capabilityMode ?? "code",
    runActive: shell.runtime?.activeRunId != null,
    canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
  });
  if (change.disabledReason !== null) {
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: change.label,
        description: change.disabledReason,
      }),
    );
    return;
  }
  void setThreadCapabilityMode(threadRef, change.target);
}
