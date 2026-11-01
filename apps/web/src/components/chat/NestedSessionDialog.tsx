import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  type EnvironmentId,
  type MessageId,
  type ModelSelection,
  type NestedSessionInherit,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { newThreadId, randomUUID } from "~/lib/utils";
import { useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

type InheritChoice = NestedSessionInherit["type"];

const INHERIT_OPTIONS: ReadonlyArray<{
  readonly value: InheritChoice;
  readonly label: string;
  readonly detail: string;
}> = [
  { value: "nothing", label: "Nothing", detail: "Starts clean." },
  { value: "summary", label: "A summary", detail: "A short digest of this conversation." },
  { value: "transcript", label: "The full transcript", detail: "Everything up to now." },
  { value: "selection", label: "Chosen files", detail: "Only the files you name." },
];

const SAME_MODEL = "same";

function encodeModel(selection: ModelSelection) {
  return JSON.stringify(selection);
}

export function NestedSessionDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId?: MessageId | undefined;
  readonly onClose: () => void;
}) {
  const startNestedSession = useAtomCommand(threadEnvironment.startNestedSession, {
    reportFailure: false,
  });
  const followNestedSession = useAtomCommand(serverEnvironment.startBackgroundTask, {
    reportFailure: false,
  });
  const providersByEnvironment = useEnvironmentProviders();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [inherit, setInherit] = useState<InheritChoice>("summary");
  const [ownWorktree, setOwnWorktree] = useState(false);
  const [track, setTrack] = useState(false);
  const [model, setModel] = useState(SAME_MODEL);
  const [message, setMessage] = useState("");
  const [paths, setPaths] = useState("");
  const [busy, setBusy] = useState(false);

  const models = (providersByEnvironment.get(props.environmentId) ?? []).flatMap((provider) =>
    provider.models.map((entry) => ({
      value: encodeModel({ instanceId: provider.instanceId, model: entry.slug }),
      label: `${provider.displayName ?? provider.instanceId} · ${entry.name}`,
    })),
  );

  const inheritInput = (): NestedSessionInherit => {
    if (inherit === "selection") {
      return {
        type: "selection",
        messageIds: props.messageId === undefined ? [] : [props.messageId],
        filePaths: paths
          .split("\n")
          .map((path) => path.trim())
          .filter((path) => path.length > 0),
      };
    }
    return { type: inherit };
  };

  const start = async () => {
    setBusy(true);
    const threadId = newThreadId();
    const result = await startNestedSession({
      environmentId: props.environmentId,
      input: {
        commandId: CommandId.make(randomUUID()),
        parentThreadId: props.threadId,
        threadId,
        ...(title.trim().length === 0 ? {} : { title: title.trim() }),
        inherit: inheritInput(),
        ...(ownWorktree ? { workspace: { type: "worktree" as const } } : {}),
        ...(model === SAME_MODEL ? {} : { modelSelection: JSON.parse(model) as ModelSelection }),
        ...(message.trim().length === 0 ? {} : { message: message.trim() }),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not start the nested session" });
      return;
    }
    if (track) {
      void followNestedSession({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, childThreadId: threadId },
      });
    }
    props.onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New nested session</DialogTitle>
          <DialogDescription>
            A conversation of its own under this one. You can open it and talk to it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Label className="flex-col items-stretch">
              Title
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </Label>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">What it starts with</span>
              <RadioGroup
                value={inherit}
                onValueChange={(value) => setInherit(value as InheritChoice)}
              >
                {INHERIT_OPTIONS.map((option) => (
                  <Label key={option.value} className="items-start">
                    <Radio value={option.value} />
                    <span className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        {option.detail}
                      </span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
              {inherit === "selection" ? (
                <Textarea
                  aria-label="Files, one per line"
                  placeholder="src/index.ts"
                  value={paths}
                  onChange={(event) => setPaths(event.target.value)}
                />
              ) : null}
            </div>
            <Label className="flex-col items-stretch">
              Model
              <Select
                value={model}
                onValueChange={(value) => setModel(value ?? SAME_MODEL)}
                items={[{ value: SAME_MODEL, label: "Same as this conversation" }, ...models]}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={SAME_MODEL}>Same as this conversation</SelectItem>
                  {models.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Label>
            <Label className="justify-between">
              Its own worktree
              <Switch checked={ownWorktree} onCheckedChange={setOwnWorktree} />
            </Label>
            <Label className="justify-between">
              Follow it in the background tray
              <Switch checked={track} onCheckedChange={setTrack} />
            </Label>
            <Label className="flex-col items-stretch">
              First message
              <Textarea value={message} onChange={(event) => setMessage(event.target.value)} />
            </Label>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void start()}>
            Start
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
