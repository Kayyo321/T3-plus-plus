import {
  backgroundTaskTransitions,
  orderBackgroundTasks,
} from "@t3tools/client-runtime/state/background-tasks";
import {
  type BackgroundTask,
  type BackgroundTaskLogResult,
  type BackgroundTaskState,
  type EnvironmentId,
  isBackgroundTaskLive,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { FileTextIcon, SquareIcon, TerminalIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

const EMPTY_TASKS: ReadonlyArray<BackgroundTask> = [];
const STATE_LABELS: Record<BackgroundTaskState, string> = {
  running: "Running",
  needs_input: "Needs input",
  succeeded: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  lost: "Lost on restart",
};

function formatElapsed(startedAt: string, endedAt: string | null, now: number): string {
  const end = endedAt === null ? now : Date.parse(endedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Ticks only while something is running; a finished tray costs nothing. */
function useElapsedClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a clock is outside React; it runs only while a task is live
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

function BackgroundTaskLogDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly task: BackgroundTask;
  readonly onClose: () => void;
}) {
  const readLog = useAtomCommand(serverEnvironment.readBackgroundTaskLog, { reportFailure: false });
  const [log, setLog] = useState<BackgroundTaskLogResult | null>(null);
  const { environmentId, task } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the end of the log file when the dialog opens
  useEffect(() => {
    let cancelled = false;
    void readLog({ environmentId, input: { id: task.id } }).then((result) => {
      if (!cancelled && result._tag === "Success") setLog(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, readLog, task.id]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{task.name}</DialogTitle>
          <DialogDescription>
            {log?.truncated === true ? "The end of its log." : (task.command ?? "Log")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap font-mono text-xs">
            {log?.text ?? ""}
          </pre>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function BackgroundTaskRow(props: {
  readonly task: BackgroundTask;
  readonly now: number;
  readonly onStop: () => void;
  readonly onRemove: () => void;
  readonly onOpenLog: () => void;
}) {
  const { task } = props;
  const live = isBackgroundTaskLive(task.state);
  const tone =
    task.state === "failed" || task.state === "lost"
      ? "text-destructive"
      : task.state === "needs_input"
        ? "text-warning"
        : "text-muted-foreground";
  return (
    <li className="flex h-6 min-w-0 items-center gap-2 text-xs">
      <TerminalIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="max-w-48 shrink-0 truncate font-medium">{task.name}</span>
      <span className={`shrink-0 ${tone}`}>{STATE_LABELS[task.state]}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatElapsed(task.startedAt, task.endedAt, props.now)}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
        {task.lastOutputLine}
      </span>
      {task.command === null ? null : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Open the log of ${task.name}`}
          onClick={props.onOpenLog}
        >
          <FileTextIcon className="size-3" />
        </Button>
      )}
      {live ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Stop ${task.name}`}
          onClick={props.onStop}
        >
          <SquareIcon className="size-3" />
        </Button>
      ) : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Remove ${task.name}`}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      )}
    </li>
  );
}

/** Work attached to this conversation. Hidden until there is some. */
export function BackgroundTaskTray(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.backgroundTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const tasks = query.data ?? EMPTY_TASKS;
  const stopTask = useAtomCommand(serverEnvironment.stopBackgroundTask);
  const removeTask = useAtomCommand(serverEnvironment.removeBackgroundTask);
  const [logTask, setLogTask] = useState<BackgroundTask | null>(null);
  const previous = useRef(tasks);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- raises a toast once per transition; the stream is the external source
  useEffect(() => {
    for (const task of backgroundTaskTransitions(previous.current, tasks)) {
      toastManager.add({
        type: task.state === "failed" || task.state === "lost" ? "error" : "info",
        title: `${task.name}: ${STATE_LABELS[task.state]}`,
      });
    }
    previous.current = tasks;
  }, [tasks]);

  const visible = orderBackgroundTasks(tasks.filter((task) => task.threadId === props.threadId));
  const now = useElapsedClock(visible.some((task) => isBackgroundTaskLive(task.state)));
  if (visible.length === 0) return null;
  const target = { environmentId: props.environmentId };
  return (
    <>
      <ul aria-label="Background tasks" className="m-0 flex list-none flex-col gap-0.5 px-1 pb-1">
        {visible.map((task) => (
          <BackgroundTaskRow
            key={task.id}
            task={task}
            now={now}
            onStop={() => void stopTask({ ...target, input: { id: task.id } })}
            onRemove={() => void removeTask({ ...target, input: { id: task.id } })}
            onOpenLog={() => setLogTask(task)}
          />
        ))}
      </ul>
      {logTask === null ? null : (
        <BackgroundTaskLogDialog
          environmentId={props.environmentId}
          task={logTask}
          onClose={() => setLogTask(null)}
        />
      )}
    </>
  );
}

const startDialogAtom = Atom.make<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly command: string;
} | null>(null).pipe(Atom.keepAlive, Atom.withLabel("chat:background-task-start"));

export function openBackgroundTaskDialog(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly command?: string;
}) {
  appAtomRegistry.set(startDialogAtom, { ...input, command: input.command ?? "" });
}

export function BackgroundTaskDialogHost() {
  const request = useAtomValue(startDialogAtom);
  return request === null ? null : (
    <BackgroundTaskStartDialog
      key={`${request.threadId}:${request.command}`}
      environmentId={request.environmentId}
      threadId={request.threadId}
      initialCommand={request.command}
      onClose={() => appAtomRegistry.set(startDialogAtom, null)}
    />
  );
}

function BackgroundTaskStartDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly initialCommand: string;
  readonly onClose: () => void;
}) {
  const startTask = useAtomCommand(serverEnvironment.startBackgroundTask, {
    reportFailure: false,
  });
  const [command, setCommand] = useState(props.initialCommand);
  const [resumeAgent, setResumeAgent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const start = async () => {
    const result = await startTask({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, command: command.trim(), resumeAgent },
    });
    if (result._tag === "Failure") {
      setFailure("The task could not start.");
      return;
    }
    props.onClose();
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
          <DialogTitle>Run in background</DialogTitle>
          <DialogDescription>
            It keeps running while you chat, and leaves a card here when it ends. It cannot prompt
            for input.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Label className="flex-col items-stretch">
              Command
              <Input value={command} onChange={(event) => setCommand(event.target.value)} />
            </Label>
            <Label className="justify-between">
              Resume the agent when it ends
              <Switch checked={resumeAgent} onCheckedChange={setResumeAgent} />
            </Label>
            {failure === null ? null : <p className="text-sm text-destructive">{failure}</p>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button disabled={command.trim().length === 0} onClick={() => void start()}>
            Run
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
