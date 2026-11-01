import type { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { registerThreadBranchCommands } from "../../shortcuts/threadBranchCommands";
import type { ChatMessage } from "../../types";
import { openNestedSessionDialog } from "./ChatOverlayHosts";

/** Gives the keyboard and the palette this conversation's rewind, fork, and nested session. */
export function ThreadBranchCommandsHost(props: {
  readonly threadKey: string;
  readonly threadId: ThreadId;
  readonly latestRunId: RunId | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly onRewind: (turnCount: number, messageId: MessageId) => void;
  readonly onFork: (input: {
    readonly sourceThreadId: ThreadId;
    readonly runId: RunId;
  }) => Promise<void>;
  readonly onRunInBackground: () => void;
}) {
  const rewind = useStableCallback(() => {
    const users = props.messages.filter((message) => message.role === "user");
    const last = users.at(-1);
    if (last !== undefined) props.onRewind(users.length - 1, last.id);
  });
  const fork = useStableCallback(() => {
    if (props.latestRunId === null) return;
    void props.onFork({ sourceThreadId: props.threadId, runId: props.latestRunId });
  });
  const nested = useStableCallback(() => openNestedSessionDialog(props.threadKey));
  const background = useStableCallback(() => props.onRunInBackground());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shortcut dispatcher lives outside React and needs this conversation's handlers while it is open
  useEffect(
    () =>
      registerThreadBranchCommands({
        "thread.rewind": rewind,
        "thread.fork": fork,
        "thread.newNestedSession": nested,
        "thread.runInBackground": background,
      }),
    [background, fork, nested, rewind],
  );
  return null;
}
