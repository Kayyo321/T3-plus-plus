import type { TeamSheet, TeamSheetChange } from "@t3tools/contracts";
import { applyTeamSheetChanges, teamSheetProblems } from "@t3tools/shared/teamSheets";

const MAX_CHANGES_PER_UPDATE = 64;

export interface TeamSheetEdits {
  readonly pending: ReadonlyArray<TeamSheetChange>;
  /** A write lost to this revision. Nothing is sent until a newer sheet is read. */
  readonly conflictedAt: number | null;
  readonly failure: string | null;
}

export const NO_TEAM_SHEET_EDITS: TeamSheetEdits = {
  pending: [],
  conflictedAt: null,
  failure: null,
};

const mergeable = (left: TeamSheetChange | undefined, right: TeamSheetChange) =>
  left?.type === "update_node" && right.type === "update_node" && left.nodeId === right.nodeId;

/** Consecutive edits of one node become one change, so a long stall stays under the update limit. */
export function addTeamSheetChange(edits: TeamSheetEdits, change: TeamSheetChange): TeamSheetEdits {
  const last = edits.pending.at(-1);
  const pending =
    last !== undefined && mergeable(last, change)
      ? [...edits.pending.slice(0, -1), { ...last, ...change }]
      : [...edits.pending, change];
  return { ...edits, pending: pending as TeamSheetEdits["pending"], failure: null };
}

export const teamSheetDraft = (server: TeamSheet, edits: TeamSheetEdits) =>
  applyTeamSheetChanges(server, edits.pending);

export const teamSheetEditProblem = (server: TeamSheet, edits: TeamSheetEdits): string | null =>
  edits.failure ?? teamSheetProblems(teamSheetDraft(server, edits))[0] ?? null;

export function teamSheetChangesToSend(
  server: TeamSheet,
  edits: TeamSheetEdits,
): ReadonlyArray<TeamSheetChange> | null {
  if (edits.pending.length === 0 || edits.failure !== null) return null;
  if (edits.conflictedAt !== null && server.revision <= edits.conflictedAt) return null;
  if (teamSheetProblems(teamSheetDraft(server, edits)).length > 0) return null;
  return edits.pending.slice(0, MAX_CHANGES_PER_UPDATE);
}

/** Only what was sent leaves. A change merged while it travelled is new, so it stays and resends. */
export const settleTeamSheetSave = (
  edits: TeamSheetEdits,
  sent: ReadonlyArray<TeamSheetChange>,
): TeamSheetEdits => ({
  pending: edits.pending.filter((change) => !sent.includes(change)),
  conflictedAt: null,
  failure: edits.failure,
});

export const settleTeamSheetConflict = (
  edits: TeamSheetEdits,
  revision: number,
): TeamSheetEdits => ({ ...edits, conflictedAt: revision });

export const settleTeamSheetFailure = (edits: TeamSheetEdits, failure: string): TeamSheetEdits => ({
  ...edits,
  failure,
});

export const newestTeamSheet = (left: TeamSheet, right: TeamSheet | null) =>
  right !== null && right.id === left.id && right.revision > left.revision ? right : left;
