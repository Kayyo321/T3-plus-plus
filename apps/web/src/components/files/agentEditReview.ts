import {
  diffAcceptRejectHunk,
  type FileDiffMetadata,
  parseDiffFromFile,
  parsePatchFiles,
} from "@pierre/diffs";
import { create } from "zustand";

/** Past this size a live diff would cost more per edit than review is worth. */
const MAX_REVIEW_CHARS = 512_000;
const MAX_REMOVED_PREVIEW_LINES = 8;

export interface ReviewHunk {
  readonly index: number;
  /** The 1-based line the review controls sit under. */
  readonly anchorLine: number;
  readonly addedLines: ReadonlyArray<number>;
  readonly additions: number;
  readonly deletions: number;
  readonly removedPreview: ReadonlyArray<string>;
}

export interface EditReview {
  readonly diff: FileDiffMetadata;
  readonly hunks: ReadonlyArray<ReviewHunk>;
}

/** Each contiguous change is one hunk: zero context keeps nearby edits separately decidable. */
export function deriveEditReview(
  name: string,
  baseline: string,
  contents: string,
): EditReview | null {
  if (baseline === contents) return null;
  if (baseline.length + contents.length > MAX_REVIEW_CHARS) return null;
  const diff = parseDiffFromFile({ name, contents: baseline }, { name, contents }, { context: 0 });
  return {
    diff,
    hunks: diff.hunks.map((hunk, index) => ({
      index,
      anchorLine: Math.max(1, hunk.additionStart + Math.max(hunk.additionCount - 1, 0)),
      addedLines: Array.from(
        { length: hunk.additionCount },
        (_, line) => hunk.additionStart + line,
      ),
      additions: hunk.additionCount,
      deletions: hunk.deletionCount,
      removedPreview: diff.deletionLines
        .slice(hunk.deletionLineIndex, hunk.deletionLineIndex + hunk.deletionCount)
        .slice(0, MAX_REMOVED_PREVIEW_LINES),
    })),
  };
}

/** Accepting moves the baseline forward, so the hunk stops being a difference. */
export function acceptHunk(review: EditReview, index: number): string {
  return diffAcceptRejectHunk(review.diff, index, "accept").deletionLines.join("");
}

/** Reverting moves the file back, leaving every other hunk as it stands. */
export function revertHunk(review: EditReview, index: number): string {
  return diffAcceptRejectHunk(review.diff, index, "reject").additionLines.join("");
}

function matchesPath(file: FileDiffMetadata, relativePath: string): boolean {
  return file.name === relativePath || file.name.endsWith(`/${relativePath}`);
}

/**
 * The file as it was before a patch, for a file the agent finished editing before it was opened.
 * Null when the file has moved on from the patch, since a wrong baseline would misreport edits.
 */
export function baselineBeforePatch(
  contents: string,
  patch: string,
  relativePath: string,
): string | null {
  const file = parsePatchFiles(patch)
    .flatMap((parsed) => parsed.files)
    .find((entry) => matchesPath(entry, relativePath));
  if (!file) return null;
  const lines = contents.split(/(?<=\n)/);
  const changes: { at: number; additions: number; start: number; removed: string[] }[] = [];
  for (const hunk of file.hunks) {
    let at = hunk.additionCount === 0 ? hunk.additionStart : hunk.additionStart - 1;
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        at += block.lines;
        continue;
      }
      changes.push({
        at,
        additions: block.additions,
        start: block.additionLineIndex,
        removed: file.deletionLines.slice(
          block.deletionLineIndex,
          block.deletionLineIndex + block.deletions,
        ),
      });
      at += block.additions;
    }
  }
  for (const change of changes.toReversed()) {
    const added = file.additionLines.slice(change.start, change.start + change.additions);
    const current = lines.slice(change.at, change.at + change.additions);
    if (added.some((line, index) => line.trimEnd() !== current[index]?.trimEnd())) return null;
    lines.splice(change.at, change.additions, ...change.removed);
  }
  return lines.join("");
}

interface EditReviewStoreState {
  /** What each open file last looked like before unreviewed changes, by file key. */
  readonly baselines: Readonly<Record<string, string>>;
  /** The newest checkpoint already reviewed, so accepting it does not reseed the same edits. */
  readonly reviewedTurns: Readonly<Record<string, number>>;
}

/** In memory on purpose: a baseline is a whole file, and a reload can reseed from the checkpoint. */
export const useEditReviewStore = create<EditReviewStoreState>(() => ({
  baselines: {},
  reviewedTurns: {},
}));

export function setEditBaseline(key: string, baseline: string | null): void {
  useEditReviewStore.setState((state) => {
    if (baseline !== null) return { baselines: { ...state.baselines, [key]: baseline } };
    if (!(key in state.baselines)) return state;
    const { [key]: _removed, ...baselines } = state.baselines;
    return { baselines };
  });
}

/** Keeps the earliest baseline, so edits made across several tool calls review as one change. */
export function noteExternalChange(key: string, previousContents: string): void {
  if (key in useEditReviewStore.getState().baselines) return;
  setEditBaseline(key, previousContents);
}

export function markTurnReviewed(key: string, turnCount: number): void {
  useEditReviewStore.setState((state) => ({
    reviewedTurns: { ...state.reviewedTurns, [key]: turnCount },
  }));
}
