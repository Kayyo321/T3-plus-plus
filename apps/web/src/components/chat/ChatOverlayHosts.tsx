import type {
  DeviceServiceState,
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadForkSourcePoint,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useRightPanelStore } from "~/rightPanelStore";
import { DeviceSetup } from "../device/DeviceSetup";
import { PullRequestThreadDialog } from "../PullRequestThreadDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { WizardPopup } from "../ui/wizard";
import { ForkPreviewDialog } from "./ForkPreviewDialog";
import { NestedSessionDialog } from "./NestedSessionDialog";
import { RewindDialog, type RewindChoice } from "./RewindDialog";
import { registerThreadOverlay } from "./threadOverlayRetention";

/**
 * Open state for overlays the chat view hosts. It lives in atoms rather than
 * ChatView state so opening or closing one renders only its host, not the
 * whole chat chrome. Each entry carries the thread it was opened for; a host
 * shows only its own thread's entry, and leaving that thread's route drops it.
 */
type ThreadOverlayAtom<T> = Atom.Writable<{ readonly threadKey: string; readonly value: T } | null>;

function makeThreadOverlayAtom<T>(label: string): ThreadOverlayAtom<T> {
  const atom = Atom.make<{ readonly threadKey: string; readonly value: T } | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`chat:${label}`),
  );
  registerThreadOverlay((threadKey) => {
    const entry = appAtomRegistry.get(atom);
    if (entry !== null && entry.threadKey !== threadKey) closeThreadOverlay(atom);
  });
  return atom;
}

function closeThreadOverlay<T>(atom: ThreadOverlayAtom<T>): void {
  appAtomRegistry.set(atom, null);
}

function useThreadOverlay<T>(atom: ThreadOverlayAtom<T>, threadKey: string | null): T | null {
  const entry = useAtomValue(atom);
  return threadKey !== null && entry?.threadKey === threadKey ? entry.value : null;
}

const pullRequestThreadDialogAtom = makeThreadOverlayAtom<{
  readonly initialReference: string | null;
  readonly key: number;
}>("pull-request-thread-dialog");

export function openPullRequestThreadDialog(threadKey: string, reference?: string): void {
  appAtomRegistry.set(pullRequestThreadDialogAtom, {
    threadKey,
    value: { initialReference: reference ?? null, key: Date.now() },
  });
}

export function PullRequestThreadDialogHost(props: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
  }) => Promise<void> | void;
}) {
  const state = useThreadOverlay(pullRequestThreadDialogAtom, props.threadKey);
  if (state === null) return null;
  return (
    <PullRequestThreadDialog
      key={state.key}
      open
      environmentId={props.environmentId}
      threadId={props.threadId}
      cwd={props.cwd}
      initialReference={state.initialReference}
      onOpenChange={(open) => {
        if (!open) closeThreadOverlay(pullRequestThreadDialogAtom);
      }}
      onPrepared={props.onPrepared}
    />
  );
}

const deviceSetupDialogAtom = makeThreadOverlayAtom<true>("device-setup-dialog");

export function openDeviceSetupDialog(threadKey: string): void {
  appAtomRegistry.set(deviceSetupDialogAtom, { threadKey, value: true });
}

export function DeviceSetupDialogHost(props: {
  readonly threadKey: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly state: DeviceServiceState;
}) {
  const open = useThreadOverlay(deviceSetupDialogAtom, props.threadKey) !== null;
  const { threadRef } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(deviceSetupDialogAtom);
      }}
    >
      <WizardPopup>
        {threadRef ? (
          <DeviceSetup
            environmentId={threadRef.environmentId}
            state={props.state}
            onComplete={() => {
              useRightPanelStore.getState().open(threadRef, "device");
              closeThreadOverlay(deviceSetupDialogAtom);
            }}
          />
        ) : null}
      </WizardPopup>
    </Dialog>
  );
}

const branchRestoreConfirmAtom = makeThreadOverlayAtom<true>("branch-restore-confirm");

export function openBranchRestoreConfirm(threadKey: string): void {
  appAtomRegistry.set(branchRestoreConfirmAtom, { threadKey, value: true });
}

export function BranchRestoreConfirmHost(props: {
  readonly threadKey: string | null;
  readonly threadBranch: string;
  readonly canWriteSourceControl: boolean;
  readonly onConfirm: () => void;
}) {
  const open = useThreadOverlay(branchRestoreConfirmAtom, props.threadKey) !== null;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeThreadOverlay(branchRestoreConfirmAtom);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Switch to <code className="font-medium">{props.threadBranch}</code>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            You have uncommitted changes. They'll carry over to the other branch, or block the
            switch if they conflict.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="default"
            disabled={!props.canWriteSourceControl}
            onClick={() => {
              closeThreadOverlay(branchRestoreConfirmAtom);
              props.onConfirm();
            }}
          >
            Switch branch
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

interface PendingRevert {
  readonly turnCount: number;
  readonly messageId: MessageId;
}

const revertConfirmAtom = makeThreadOverlayAtom<PendingRevert>("revert-confirm");

export function openRevertConfirm(threadKey: string, pending: PendingRevert): void {
  appAtomRegistry.set(revertConfirmAtom, { threadKey, value: pending });
}

export function RevertConfirmHost(props: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onConfirm: (turnCount: number, messageId: MessageId, choice: RewindChoice) => void;
}) {
  const pending = useThreadOverlay(revertConfirmAtom, props.threadKey);
  if (pending === null) return null;
  return (
    <RewindDialog
      environmentId={props.environmentId}
      threadId={props.threadId}
      target={{ type: "message", messageId: pending.messageId }}
      restoresPrompt
      onCancel={() => closeThreadOverlay(revertConfirmAtom)}
      onConfirm={(choice) => {
        closeThreadOverlay(revertConfirmAtom);
        props.onConfirm(pending.turnCount, pending.messageId, choice);
      }}
    />
  );
}

type PendingFork = {
  readonly sourceThreadId: ThreadId;
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
};

const forkPreviewAtom = makeThreadOverlayAtom<PendingFork>("fork-preview");

export function openForkPreview(threadKey: string, pending: PendingFork): void {
  appAtomRegistry.set(forkPreviewAtom, { threadKey, value: pending });
}

export function ForkPreviewHost(props: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly onConfirm: (pending: PendingFork) => void;
}) {
  const pending = useThreadOverlay(forkPreviewAtom, props.threadKey);
  if (pending === null) return null;
  return (
    <ForkPreviewDialog
      environmentId={props.environmentId}
      threadId={pending.sourceThreadId}
      sourcePoint={pending.sourcePoint}
      onCancel={() => closeThreadOverlay(forkPreviewAtom)}
      onConfirm={() => {
        closeThreadOverlay(forkPreviewAtom);
        props.onConfirm(pending);
      }}
    />
  );
}

const nestedSessionAtom = makeThreadOverlayAtom<{ readonly messageId?: MessageId }>(
  "nested-session-dialog",
);

export function openNestedSessionDialog(threadKey: string, messageId?: MessageId): void {
  appAtomRegistry.set(nestedSessionAtom, {
    threadKey,
    value: messageId === undefined ? {} : { messageId },
  });
}

export function NestedSessionDialogHost(props: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const pending = useThreadOverlay(nestedSessionAtom, props.threadKey);
  if (pending === null) return null;
  return (
    <NestedSessionDialog
      environmentId={props.environmentId}
      threadId={props.threadId}
      messageId={pending.messageId}
      onClose={() => closeThreadOverlay(nestedSessionAtom)}
    />
  );
}
