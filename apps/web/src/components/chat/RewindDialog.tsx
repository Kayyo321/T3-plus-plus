import type {
  EnvironmentId,
  OrchestrationV2RewindMode,
  ThreadId,
  ThreadRewindOutsideChanges,
  ThreadRewindPreview,
  ThreadRewindTarget,
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
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";

export interface RewindChoice {
  readonly mode: OrchestrationV2RewindMode;
  readonly outsideChanges: ThreadRewindOutsideChanges | undefined;
}

const MODE_LABELS: Record<OrchestrationV2RewindMode, string> = {
  conversation: "Conversation only",
  files: "Files only",
  both: "Conversation and files",
};

function modeDetail(mode: OrchestrationV2RewindMode, preview: ThreadRewindPreview): string {
  const turns = `${preview.discardedTurns} ${preview.discardedTurns === 1 ? "turn" : "turns"}`;
  const files = `${preview.filesChangedCount} ${preview.filesChangedCount === 1 ? "file" : "files"}`;
  switch (mode) {
    case "conversation":
      return `Drops ${turns}. Files stay as they are.`;
    case "files":
      return `Restores ${files}. The conversation stays as it is.`;
    case "both":
      return `Drops ${turns} and restores ${files}.`;
  }
}

function PathList(props: { readonly paths: ReadonlyArray<string>; readonly total: number }) {
  return (
    <ul className="max-h-28 overflow-y-auto rounded-md border p-2 font-mono text-xs">
      {props.paths.map((path) => (
        <li key={path} className="truncate">
          {path}
        </li>
      ))}
      {props.total > props.paths.length ? (
        <li className="text-muted-foreground">and {props.total - props.paths.length} more</li>
      ) : null}
    </ul>
  );
}

export function RewindDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly target: ThreadRewindTarget;
  /** The message returns to the composer when the conversation rewinds. */
  readonly restoresPrompt: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (choice: RewindChoice) => void;
}) {
  const previewRewind = useAtomCommand(threadEnvironment.previewRewind, { reportFailure: false });
  const [preview, setPreview] = useState<ThreadRewindPreview | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<OrchestrationV2RewindMode | null>(null);
  const [outsideChanges, setOutsideChanges] = useState<ThreadRewindOutsideChanges>("stash");
  const { environmentId, threadId, target } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the workspace on the server each time the dialog opens, so what it shows is current
  useEffect(() => {
    let cancelled = false;
    void previewRewind({ environmentId, input: { threadId, target } }).then((result) => {
      if (cancelled) return;
      if (AsyncResult.isSuccess(result)) setPreview(result.value);
      else setFailure("This point cannot be rewound to.");
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, previewRewind, target, threadId]);

  const available = preview?.modes.filter((mode) => mode.available) ?? [];
  const mode = selected ?? available[0]?.mode ?? null;
  const restoresFiles = mode === "files" || mode === "both";
  const hasOutsideChanges = restoresFiles && (preview?.outsideChangesCount ?? 0) > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {preview === null
              ? "Rewind"
              : preview.turn === 0
                ? "Rewind to before the first turn"
                : `Rewind to turn ${preview.turn}`}
          </DialogTitle>
          <DialogDescription>
            What this discards stays on an archived branch you can reopen or fork.
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
            <div className="flex flex-col gap-4">
              <RadioGroup
                value={mode ?? ""}
                onValueChange={(value) => setSelected(value as OrchestrationV2RewindMode)}
              >
                {preview.modes.map((option) => (
                  <Label key={option.mode} className="items-start">
                    <Radio value={option.mode} disabled={!option.available} />
                    <span className="flex flex-col gap-0.5">
                      <span>{MODE_LABELS[option.mode]}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {option.unavailableReason ?? modeDetail(option.mode, preview)}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              {preview.conversationRollback === "fresh_session" &&
              (mode === "conversation" || mode === "both") ? (
                <p className="text-xs text-muted-foreground">
                  This agent restarts on rewind, so it forgets the earlier turns too.
                </p>
              ) : null}
              {restoresFiles && preview.filesChanged.length > 0 ? (
                <PathList
                  paths={preview.filesChanged.map((change) => change.path)}
                  total={preview.filesChangedCount}
                />
              ) : null}
              {hasOutsideChanges ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    {preview.outsideChangesCount}{" "}
                    {preview.outsideChangesCount === 1 ? "file was" : "files were"} changed outside
                    the agent since its last turn.
                  </p>
                  <PathList
                    paths={preview.outsideChanges.map((change) => change.path)}
                    total={preview.outsideChangesCount}
                  />
                  <RadioGroup
                    value={outsideChanges}
                    onValueChange={(value) =>
                      setOutsideChanges(value as ThreadRewindOutsideChanges)
                    }
                  >
                    <Label>
                      <Radio value="stash" />
                      Stash them first
                    </Label>
                    <Label>
                      <Radio value="discard" />
                      Keep them only on the archived branch
                    </Label>
                  </RadioGroup>
                </div>
              ) : null}
              {props.restoresPrompt && mode !== "files" ? (
                <p className="text-xs text-muted-foreground">
                  Your prompt and attachments return to the composer.
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button
            disabled={mode === null}
            onClick={() => {
              if (mode === null) return;
              props.onConfirm({
                mode,
                outsideChanges: hasOutsideChanges ? outsideChanges : undefined,
              });
            }}
          >
            Rewind
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
