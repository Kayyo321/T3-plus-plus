import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useDeferredValue, useEffect, useRef } from "react";

import { useThreadCheckpointSummaries } from "~/state/entities";
import { useCheckpointDiff } from "~/state/queries";

import {
  acceptHunk,
  baselineBeforePatch,
  deriveEditReview,
  markTurnReviewed,
  noteExternalChange,
  revertHunk,
  setEditBaseline,
  useEditReviewStore,
} from "./agentEditReview";

/**
 * Tracks what changed under an open editor since it last matched a reviewed baseline. Changes that
 * did not come from this editor set the baseline; opening a file the latest turn touched seeds it
 * from that turn's checkpoint diff, so finished edits review the same way as live ones.
 */
export function useEditReview(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  /** The last contents this editor produced itself. */
  readonly localContents: string | null;
  readonly onChange: (contents: string) => void;
}) {
  const { enabled, environmentId, threadRef, cwd, relativePath, contents, localContents } = input;
  const key = `${environmentId}\u0000${cwd}\u0000${relativePath}`;
  const baseline = useEditReviewStore((state) => (enabled ? (state.baselines[key] ?? null) : null));
  const reviewedTurn = useEditReviewStore((state) => state.reviewedTurns[key] ?? 0);
  const checkpoints = useThreadCheckpointSummaries(enabled ? threadRef : null);
  const latest = checkpoints.at(-1);
  const latestTurn = latest?.checkpointTurnCount ?? 0;
  const seedTurn =
    enabled &&
    baseline === null &&
    latestTurn > reviewedTurn &&
    latest?.files.some((file) => file.path === relativePath)
      ? latestTurn
      : null;
  const seedDiff = useCheckpointDiff(
    {
      environmentId,
      threadId: threadRef.threadId,
      fromTurnCount: seedTurn === null ? null : seedTurn - 1,
      toTurnCount: seedTurn,
      ignoreWhitespace: false,
      cacheScope: seedTurn === null ? null : `turn:${latest?.runId}`,
    },
    { enabled: seedTurn !== null },
  );
  const seedPatch = seedTurn === null ? null : (seedDiff.data?.diff ?? null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copies a loaded checkpoint diff into the review store, which outlives this surface across tab switches
  useEffect(() => {
    if (seedTurn === null || seedPatch === null) return;
    markTurnReviewed(key, seedTurn);
    const seeded = baselineBeforePatch(contents, seedPatch, relativePath);
    if (seeded !== null && seeded !== contents) setEditBaseline(key, seeded);
  }, [contents, key, relativePath, seedPatch, seedTurn]);

  const previousContents = useRef(contents);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a file changing under the editor is an external event; its previous text becomes the baseline
  useEffect(() => {
    const previous = previousContents.current;
    previousContents.current = contents;
    if (enabled && previous !== contents && contents !== localContents) {
      noteExternalChange(key, previous);
      // These edits belong to the turn in progress, so its checkpoint must not reseed them later.
      markTurnReviewed(key, latestTurn + 1);
    }
  }, [contents, enabled, key, latestTurn, localContents]);

  const reviewed = useDeferredValue(contents);
  const review = baseline === null ? null : deriveEditReview(relativePath, baseline, reviewed);
  const settled = baseline !== null && baseline === contents;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drops a finished review from the store once the file matches its baseline again
  useEffect(() => {
    if (settled) setEditBaseline(key, null);
  }, [key, settled]);

  return {
    hunks: review?.hunks ?? [],
    accept: (index: number) => {
      if (review) setEditBaseline(key, acceptHunk(review, index));
    },
    revert: (index: number) => {
      if (review) input.onChange(revertHunk(review, index));
    },
    acceptAll: () => setEditBaseline(key, null),
    revertAll: () => {
      if (baseline !== null) input.onChange(baseline);
    },
  };
}
