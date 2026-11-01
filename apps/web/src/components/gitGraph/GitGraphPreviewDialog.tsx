import type { GitGraphPreview } from "@t3tools/contracts";
import { useState } from "react";

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
import { Checkbox } from "../ui/checkbox";
import { Label } from "../ui/label";

function PreviewList(props: {
  readonly title: string;
  readonly items: ReadonlyArray<string>;
  readonly total: number;
}) {
  if (props.items.length === 0) return null;
  return (
    <section className="min-h-0">
      <h3 className="mb-1 font-mono text-2xs text-muted-foreground">
        {props.title} ({props.total})
      </h3>
      <ul className="max-h-32 overflow-y-auto font-mono text-xs">
        {props.items.map((item) => (
          <li key={item} className="truncate">
            {item}
          </li>
        ))}
        {props.total > props.items.length ? (
          <li className="text-muted-foreground">and {props.total - props.items.length} more</li>
        ) : null}
      </ul>
    </section>
  );
}

/** What an action will do, in plain words, before it does it. */
export function GitGraphPreviewDialog(props: {
  readonly preview: GitGraphPreview;
  readonly confirmLabel: string;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { preview, confirmLabel, pending, onCancel, onConfirm } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const blocked = !preview.canProceed || (preview.requiresAcknowledgement && !acknowledged);
  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{preview.title}</AlertDialogTitle>
          <AlertDialogDescription>{preview.summary}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-6 pb-4 text-sm">
          {preview.warnings.map((warning) => (
            <p key={warning} className="text-warning-foreground">
              {warning}
            </p>
          ))}
          <PreviewList
            title="Conflicts"
            items={preview.conflicts}
            total={preview.conflicts.length}
          />
          <PreviewList
            title="Commits"
            items={preview.commits.map((commit) => `${commit.sha.slice(0, 7)} ${commit.subject}`)}
            total={preview.commitsTotal}
          />
          <PreviewList title="Files" items={preview.files} total={preview.filesTotal} />
          {preview.recoveryNote === null ? null : (
            <p className="text-muted-foreground">{preview.recoveryNote}</p>
          )}
          {preview.requiresAcknowledgement ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id="git-graph-acknowledge"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <Label htmlFor="git-graph-acknowledge">Delete it anyway</Label>
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant={preview.discardsChanges || preview.rewritesHistory ? "destructive" : "default"}
            disabled={blocked || pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
