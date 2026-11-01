import type { ReviewHunk } from "./agentEditReview";
import { Button } from "../ui/button";

/** The review row under one change, inside the editor. */
export function EditReviewAnnotation(props: {
  hunk: ReviewHunk;
  onAccept: (index: number) => void;
  onRevert: (index: number) => void;
}) {
  const { hunk, onAccept, onRevert } = props;
  return (
    <div
      data-edit-review-hunk={hunk.index}
      className="flex flex-col gap-1 border-y border-border/60 bg-card px-3 py-1 font-sans text-xs"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-muted-foreground">
          Changed: +{hunk.additions} −{hunk.deletions}
        </span>
        <Button size="xs" variant="ghost" onClick={() => onRevert(hunk.index)}>
          Revert
        </Button>
        <Button size="xs" variant="outline" onClick={() => onAccept(hunk.index)}>
          Accept
        </Button>
      </div>
      {hunk.removedPreview.length > 0 ? (
        <pre className="overflow-x-auto font-mono text-2xs text-muted-foreground line-through">
          {hunk.removedPreview.join("")}
        </pre>
      ) : null}
    </div>
  );
}

export function EditReviewBar(props: {
  hunkCount: number;
  onAcceptAll: () => void;
  onRevertAll: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-xs">
      <span className="min-w-0 flex-1 text-muted-foreground">
        {props.hunkCount === 1 ? "1 change to review" : `${props.hunkCount} changes to review`}
      </span>
      <Button size="xs" variant="ghost" onClick={props.onRevertAll}>
        Revert all
      </Button>
      <Button size="xs" variant="outline" onClick={props.onAcceptAll}>
        Accept all
      </Button>
    </div>
  );
}
