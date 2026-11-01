import { gitGraphRiskLabels } from "@t3tools/client-runtime/git-graph";
import type {
  EnvironmentId,
  GitGraphAction,
  GitGraphRow,
  GitGraphSummary,
} from "@t3tools/contracts";
import { ChevronDownIcon, CopyIcon, MessageSquareIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useEnvironmentQuery } from "~/state/query";
import { gitGraphEnvironment } from "~/state/vcs";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";

/** The selected node: what it is, where it came from, and everything you can do from it. */
export function GitGraphDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly row: GitGraphRow;
  readonly summary: GitGraphSummary | null;
  readonly readOnly: boolean;
  readonly onAction: (action: GitGraphAction) => void;
  readonly onOpenConversation: (threadId: GitGraphRow["conversation"]) => void;
  readonly onClose: () => void;
}) {
  const { environmentId, cwd, row, summary, readOnly, onAction, onOpenConversation, onClose } =
    props;
  const query = useEnvironmentQuery(
    row.kind === "checkpoint"
      ? null
      : gitGraphEnvironment.commitDetail({ environmentId, input: { cwd, sha: row.sha } }),
  );
  const detail = query.data;
  const error = query.error;
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);

  const branches = row.refs.filter((ref) => ref.kind === "branch" || ref.kind === "head");
  const remotes = row.refs.filter((ref) => ref.kind === "remote");
  const isCheckpoint = row.kind === "checkpoint";
  const currentBranch = summary?.branch ?? null;
  const isHead = row.sha === summary?.headSha;
  const target = isHead ? row.parents[0] : row.sha;
  const mergeTarget = branches[0]?.name ?? remotes[0]?.name ?? row.sha;
  const conversation = row.conversation ?? detail?.conversation ?? null;
  const rollbackLead = isHead ? "Undo last commit" : `Go back to ${row.sha.slice(0, 7)}`;
  const risk = summary?.risks.find((entry) => entry.sha === row.sha) ?? detail?.risk ?? null;

  return (
    <div className="flex max-h-[45%] shrink-0 flex-col border-t border-border">
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          className="font-mono text-2xs text-muted-foreground hover:text-foreground"
          aria-label="Copy the full id"
          onClick={() => void writeTextToClipboard(row.sha)}
        >
          {row.sha.slice(0, 10)} <CopyIcon className="inline size-3" />
        </button>
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
          {row.authorName}
        </span>
        <Button size="icon-micro" variant="ghost" aria-label="Close details" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-2 pb-2 text-xs">
        {error === null ? null : <p className="text-destructive-foreground">{error}</p>}
        {query.isPending && detail === null ? <Spinner /> : null}
        {detail === null ? null : (
          <>
            <p className="whitespace-pre-wrap">{detail.message}</p>
            {risk === null
              ? null
              : gitGraphRiskLabels(risk).map((label) => (
                  <p key={label} className="mt-1 text-warning-foreground">
                    {label}
                  </p>
                ))}
            <ul className="mt-2 font-mono text-2xs">
              {detail.files.slice(0, 20).map((file) => (
                <li key={file.path} className="flex gap-2">
                  <span className="w-3 shrink-0 text-muted-foreground">{file.status}</span>
                  <span className="min-w-0 flex-1 truncate">{file.path}</span>
                  <span className="shrink-0 text-diff-addition-foreground">+{file.additions}</span>
                  <span className="shrink-0 text-diff-deletion-foreground">-{file.deletions}</span>
                </li>
              ))}
              {detail.files.length > 20 ? (
                <li className="text-muted-foreground">
                  and {detail.files.length - 20} more{detail.filesTruncated ? "+" : ""}
                </li>
              ) : null}
            </ul>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-t border-border/60 p-1">
        {conversation === null ? null : (
          <Button size="compact" variant="ghost" onClick={() => onOpenConversation(conversation)}>
            <MessageSquareIcon />
            {conversation.turn === null ? "Conversation" : `Turn ${conversation.turn}`}
          </Button>
        )}
        {readOnly ? null : (
          <>
            {isCheckpoint ? (
              <Button
                size="compact"
                variant="ghost"
                onClick={() =>
                  onAction({ type: "rollbackToCheckpoint", checkpointRef: row.checkpointRef! })
                }
              >
                Put my files back here
              </Button>
            ) : (
              <>
                {branches
                  .filter((ref) => ref.name !== currentBranch)
                  .slice(0, 1)
                  .map((ref) => (
                    <Button
                      key={ref.name}
                      size="compact"
                      variant="ghost"
                      onClick={() => onAction({ type: "branchCheckout", name: ref.name })}
                    >
                      Check out {ref.name}
                    </Button>
                  ))}
                <Button size="compact" variant="ghost" onClick={() => setNewBranch("")}>
                  New branch
                </Button>
                {isHead && row.parents.length === 0 ? null : (
                  <Menu>
                    <MenuTrigger render={<Button size="compact" variant="ghost" />}>
                      {isHead ? "Undo" : "Go back here"}
                      <ChevronDownIcon />
                    </MenuTrigger>
                    <MenuPopup>
                      <MenuItem
                        onClick={() =>
                          onAction({ type: "rollback", target: target!, mode: "mixed" })
                        }
                      >
                        {rollbackLead}, keep my changes
                      </MenuItem>
                      <MenuItem
                        onClick={() =>
                          onAction({ type: "rollback", target: target!, mode: "soft" })
                        }
                      >
                        {rollbackLead}, keep my changes staged
                      </MenuItem>
                      <MenuItem
                        variant="destructive"
                        onClick={() =>
                          onAction({ type: "rollback", target: target!, mode: "hard" })
                        }
                      >
                        {rollbackLead} and throw away the changes
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                )}
                <Menu>
                  <MenuTrigger render={<Button size="compact" variant="ghost" />}>
                    More
                    <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup>
                    {isHead ? null : (
                      <MenuItem onClick={() => onAction({ type: "merge", ref: mergeTarget })}>
                        Merge into {currentBranch ?? "HEAD"}
                      </MenuItem>
                    )}
                    {isHead ? null : (
                      <MenuItem onClick={() => onAction({ type: "rebase", onto: mergeTarget })}>
                        Rebase {currentBranch ?? "HEAD"} onto this
                      </MenuItem>
                    )}
                    {isHead || row.parents.length > 1 ? null : (
                      <MenuItem onClick={() => onAction({ type: "cherryPick", sha: row.sha })}>
                        Copy this commit to {currentBranch ?? "HEAD"}
                      </MenuItem>
                    )}
                    {branches.map((ref) => (
                      <MenuItem
                        key={`rename:${ref.name}`}
                        onClick={() => setRenaming({ from: ref.name, to: ref.name })}
                      >
                        Rename {ref.name}
                      </MenuItem>
                    ))}
                    {branches
                      .filter((ref) => ref.name !== currentBranch)
                      .map((ref) => (
                        <MenuItem
                          key={`delete:${ref.name}`}
                          variant="destructive"
                          onClick={() => onAction({ type: "branchDelete", name: ref.name })}
                        >
                          Delete {ref.name}
                        </MenuItem>
                      ))}
                  </MenuPopup>
                </Menu>
              </>
            )}
          </>
        )}
      </div>
      {newBranch === null ? null : (
        <form
          className="flex gap-1 border-t border-border/60 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            onAction({
              type: "branchCreate",
              name: newBranch.trim(),
              startPoint: row.sha,
              checkout: true,
            });
            setNewBranch(null);
          }}
        >
          <Input
            autoFocus
            size="sm"
            aria-label="New branch name"
            placeholder="Branch name"
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
          />
          <Button type="submit" size="compact" disabled={newBranch.trim().length === 0}>
            Create
          </Button>
        </form>
      )}
      {renaming === null ? null : (
        <form
          className="flex gap-1 border-t border-border/60 p-1"
          onSubmit={(event) => {
            event.preventDefault();
            onAction({ type: "branchRename", from: renaming.from, to: renaming.to.trim() });
            setRenaming(null);
          }}
        >
          <Input
            autoFocus
            size="sm"
            aria-label="New name"
            value={renaming.to}
            onChange={(event) => setRenaming({ ...renaming, to: event.target.value })}
          />
          <Button type="submit" size="compact" disabled={renaming.to.trim().length === 0}>
            Rename
          </Button>
        </form>
      )}
    </div>
  );
}
