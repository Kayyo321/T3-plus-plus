import type {
  EnvironmentId,
  OrchestrationV2ThreadForkSourcePoint,
  ThreadForkPreview,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";

function carriedSummary(preview: ThreadForkPreview): string {
  const messages = `${preview.carriedMessages} ${preview.carriedMessages === 1 ? "message" : "messages"}`;
  const tokens = `about ${Math.round(preview.estimatedTokens / 100) / 10}k tokens`;
  return `${messages}, ${tokens}, through turn ${preview.turn}.`;
}

function strategySummary(preview: ThreadForkPreview): string {
  if (preview.cutsTurn) {
    return "This cuts its turn short, so the agent starts fresh with a replay of that history.";
  }
  return preview.strategy === "native"
    ? "The same agent continues from this point with its full memory."
    : "The agent starts fresh with a replay of that history, trimmed if it is very long.";
}

export function ForkPreviewDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const previewFork = useAtomCommand(threadEnvironment.previewFork, { reportFailure: false });
  const [preview, setPreview] = useState<ThreadForkPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const { environmentId, threadId, sourcePoint } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server what this fork would carry when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void previewFork({ environmentId, input: { threadId, sourcePoint } }).then((result) => {
      if (cancelled) return;
      if (AsyncResult.isSuccess(result)) setPreview(result.value);
      else setFailure("This point cannot be forked.");
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, previewFork, sourcePoint, threadId]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Fork from here</DialogTitle>
          <DialogDescription>
            A new conversation that remembers where it came from.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {preview === null ? (
            failure === null ? (
              <Spinner size="sm" />
            ) : (
              <p className="text-sm text-destructive">{failure}</p>
            )
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <p>Carries {carriedSummary(preview)}</p>
              <p className="text-muted-foreground">{strategySummary(preview)}</p>
              {preview.lastMessage === null ? null : (
                <p className="line-clamp-3 rounded-md border p-2 text-xs text-muted-foreground">
                  {preview.lastMessage}
                </p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button disabled={preview === null} onClick={props.onConfirm}>
            Fork
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
