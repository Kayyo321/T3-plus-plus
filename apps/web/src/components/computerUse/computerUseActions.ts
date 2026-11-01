import {
  type AtomCommand,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseTarget, ScopedThreadRef } from "@t3tools/contracts";

import { readThreadPreviewState } from "../../previewStateStore";
import { rightPanelHostRef, useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";

async function run<W, A, E>(
  command: AtomCommand<W, A, E>,
  input: W,
  failureTitle: string,
): Promise<void> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: failureTitle,
      description: failure instanceof Error ? failure.message : "The environment did not answer.",
    }),
  );
}

const threadInput = (threadRef: ScopedThreadRef) => ({
  environmentId: threadRef.environmentId,
  input: { threadId: threadRef.threadId },
});

export const startComputerUse = (threadRef: ScopedThreadRef, target: ComputerUseTarget) =>
  run(
    serverEnvironment.startComputerUse,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, target },
    },
    "Could not turn on computer use",
  );

export const stopComputerUse = (threadRef: ScopedThreadRef) =>
  run(serverEnvironment.stopComputerUse, threadInput(threadRef), "Could not stop computer use");

export const takeOverComputerUse = (threadRef: ScopedThreadRef) =>
  run(serverEnvironment.takeOverComputerUse, threadInput(threadRef), "Could not take over");

export const handBackComputerUse = (threadRef: ScopedThreadRef) =>
  run(serverEnvironment.resumeComputerUse, threadInput(threadRef), "Could not hand back");

export const answerComputerUseApproval = (
  threadRef: ScopedThreadRef,
  approvalId: string,
  approved: boolean,
) =>
  run(
    serverEnvironment.answerComputerUseApproval,
    {
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, approvalId, approved },
    },
    "Could not answer that step",
  );

export const showComputerUseSteps = (threadRef: ScopedThreadRef) =>
  useRightPanelStore.getState().openComputerUse(threadRef, threadRef.threadId);

/** Opens the tab the agent is driving. The panel's host owns browser tabs for a side chat. */
export function revealComputerUseBrowser(threadRef: ScopedThreadRef): void {
  const host = rightPanelHostRef(threadRef);
  const tabId = readThreadPreviewState(host).activeTabId;
  const panels = useRightPanelStore.getState();
  if (tabId === null) panels.open(host, "preview");
  else panels.openBrowser(host, tabId);
}
