import type {
  EnvironmentId,
  GitGraphAction,
  GitGraphChangedFile,
  GitGraphHunk,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { gitGraphEnvironment } from "~/state/vcs";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { commandError } from "./useGitGraph";

const isStaged = (file: GitGraphChangedFile) => file.staged !== " " && file.staged !== "?";
const isUnstaged = (file: GitGraphChangedFile) => file.unstaged !== " ";

function HunkView(props: {
  readonly hunk: GitGraphHunk;
  readonly onToggle: () => void;
  readonly busy: boolean;
}) {
  const { hunk, onToggle, busy } = props;
  return (
    <div className="border-t border-border/60">
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-2 py-0.5">
        <span className="truncate font-mono text-3xs text-muted-foreground">{hunk.header}</span>
        <Button size="compact" variant="ghost" disabled={busy} onClick={onToggle}>
          {hunk.staged ? "Unstage" : "Stage"} hunk
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto px-2 py-1 font-mono text-2xs leading-4">
        {hunk.lines.map((line, index) => (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- diff lines repeat and never reorder.
            key={index}
            className={cn(
              line.startsWith("+") && "text-diff-addition-foreground",
              line.startsWith("-") && "text-diff-deletion-foreground",
            )}
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

function FileRow(props: {
  readonly file: GitGraphChangedFile;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
}) {
  const { file, open, busy, onOpen, onToggle } = props;
  const stagedSide = isStaged(file);
  return (
    <div className="flex h-7 items-center gap-2 px-2 text-xs">
      <span className="w-6 shrink-0 font-mono text-3xs text-muted-foreground">
        {file.staged.trim() || "·"}
        {file.unstaged.trim() || "·"}
      </span>
      <button
        type="button"
        aria-expanded={open}
        className="min-w-0 flex-1 truncate text-left font-mono text-2xs hover:underline"
        onClick={onOpen}
      >
        {file.path}
      </button>
      <Button size="compact" variant="ghost" disabled={busy} onClick={onToggle}>
        {stagedSide && !isUnstaged(file) ? "Unstage" : "Stage"}
      </Button>
    </div>
  );
}

/** Stage by file or hunk, then commit with a message you wrote or one a model drafted. */
export function GitGraphChangesView(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadId: ThreadId;
  readonly run: (action: GitGraphAction) => Promise<boolean>;
}) {
  const { environmentId, cwd, threadId, run } = props;
  const draft = useAtomCommand(gitGraphEnvironment.draftMessage, { reportFailure: false });
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const query = useEnvironmentQuery(
    gitGraphEnvironment.changes({
      environmentId,
      input: { cwd, ...(openPath === null ? {} : { path: openPath }) },
    }),
  );
  const changes = query.data;
  const error = draftError ?? query.error;

  const perform = async (action: GitGraphAction) => {
    setBusy(true);
    const ok = await run(action);
    query.refresh();
    setBusy(false);
    return ok;
  };

  const draftMessage = async () => {
    setDrafting(true);
    setDraftError(null);
    const result = await draft({ environmentId, input: { cwd, threadId } });
    setDrafting(false);
    if (result._tag === "Failure") setDraftError(commandError(result));
    else if (result.value.message === null) setDraftError("Stage something first.");
    else setMessage(result.value.message);
  };

  const files = changes?.files ?? [];
  const stagedCount = files.filter(isStaged).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {changes === null ? (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        ) : files.length === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">No uncommitted changes.</p>
        ) : null}
        {files.map((file) => (
          <div key={file.path}>
            <FileRow
              file={file}
              open={openPath === file.path}
              busy={busy}
              onOpen={() => setOpenPath(openPath === file.path ? null : file.path)}
              onToggle={() =>
                void perform({
                  type: isStaged(file) && !isUnstaged(file) ? "unstage" : "stage",
                  paths: [file.path],
                })
              }
            />
            {openPath === file.path
              ? changes?.hunks.map((hunk) => (
                  <HunkView
                    key={hunk.id}
                    hunk={hunk}
                    busy={busy}
                    onToggle={() =>
                      void perform({
                        type: hunk.staged ? "unstageHunk" : "stageHunk",
                        path: file.path,
                        hunkId: hunk.id,
                      })
                    }
                  />
                ))
              : null}
          </div>
        ))}
        {changes?.filesTruncated ? (
          <p className="p-2 text-xs text-muted-foreground">More files changed than are shown.</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-t border-border p-2">
        {error === null ? null : <p className="text-xs text-destructive-foreground">{error}</p>}
        <Textarea
          aria-label="Commit message"
          placeholder="Commit message"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            size="compact"
            variant="ghost"
            disabled={drafting || stagedCount === 0}
            onClick={() => void draftMessage()}
          >
            {drafting ? <Spinner /> : null}
            Draft a message
          </Button>
          <Button
            size="compact"
            disabled={busy || stagedCount === 0 || message.trim().length === 0}
            onClick={() => {
              void perform({ type: "commit", message: message.trim() }).then((ok) => {
                if (ok) setMessage("");
              });
            }}
          >
            Commit {stagedCount === 0 ? "" : `${stagedCount} staged`}
          </Button>
        </div>
      </div>
    </div>
  );
}
