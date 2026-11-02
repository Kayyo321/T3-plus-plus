import { TeamNodeId, TeamSheetId, type TeamSheet } from "@t3tools/contracts";
import { DEFAULT_TEAM_SHEET } from "@t3tools/shared/teamSheets";
import { describe, expect, it } from "vite-plus/test";

import {
  addTeamSheetChange,
  NO_TEAM_SHEET_EDITS,
  newestTeamSheet,
  settleTeamSheetConflict,
  settleTeamSheetFailure,
  settleTeamSheetSave,
  teamSheetChangesToSend,
  teamSheetDraft,
  teamSheetEditProblem,
} from "./teamSheetEdits";

const build = TeamNodeId.make("build");
const review = TeamNodeId.make("review");
const sheet: TeamSheet = { ...DEFAULT_TEAM_SHEET, builtIn: false, revision: 3 };

describe("team sheet edits", () => {
  it("sends valid edits and holds an invalid draft with its first problem", () => {
    const moved = addTeamSheetChange(NO_TEAM_SHEET_EDITS, {
      type: "update_node",
      nodeId: build,
      position: { x: 1, y: 2 },
    });
    expect(teamSheetChangesToSend(sheet, moved)).toEqual(moved.pending);
    const broken = addTeamSheetChange(moved, { type: "remove_node", nodeId: review });
    const severed = addTeamSheetChange(broken, { type: "remove_node", nodeId: build });
    expect(teamSheetChangesToSend(sheet, severed)).toBeNull();
    expect(teamSheetEditProblem(sheet, severed)).toBe("The Project Lead cannot reach Validate.");
  });

  it("merges consecutive edits of one node", () => {
    const first = addTeamSheetChange(NO_TEAM_SHEET_EDITS, {
      type: "update_node",
      nodeId: build,
      name: "Makers",
    });
    const second = addTeamSheetChange(first, {
      type: "update_node",
      nodeId: build,
      position: { x: 9, y: 9 },
    });
    expect(second.pending).toEqual([
      { type: "update_node", nodeId: build, name: "Makers", position: { x: 9, y: 9 } },
    ]);
  });

  it("waits for a newer sheet after a conflict, then rebases pending changes onto it", () => {
    const edits = addTeamSheetChange(NO_TEAM_SHEET_EDITS, { type: "rename", name: "Mine" });
    const conflicted = settleTeamSheetConflict(edits, sheet.revision);
    expect(teamSheetChangesToSend(sheet, conflicted)).toBeNull();

    const theirs = { ...sheet, revision: 4, nestedSessions: false };
    expect(teamSheetChangesToSend(theirs, conflicted)).toEqual(edits.pending);
    expect(teamSheetDraft(theirs, conflicted)).toMatchObject({
      name: "Mine",
      nestedSessions: false,
    });
  });

  it("keeps changes added while a save was in flight", () => {
    const sent = addTeamSheetChange(NO_TEAM_SHEET_EDITS, { type: "rename", name: "One" });
    const later = addTeamSheetChange(sent, { type: "set_nested_sessions", enabled: false });
    expect(settleTeamSheetSave(later, sent.pending).pending).toEqual([
      { type: "set_nested_sessions", enabled: false },
    ]);

    const edit = { type: "update_node", nodeId: build, name: "Makers" } as const;
    const travelling = addTeamSheetChange(NO_TEAM_SHEET_EDITS, edit);
    const merged = addTeamSheetChange(travelling, {
      type: "update_node",
      nodeId: build,
      position: { x: 9, y: 9 },
    });
    expect(settleTeamSheetSave(merged, travelling.pending).pending).toEqual(merged.pending);
  });

  it("stops sending after a refusal until the next edit", () => {
    const edits = addTeamSheetChange(NO_TEAM_SHEET_EDITS, { type: "rename", name: "One" });
    const refused = settleTeamSheetFailure(edits, "Refused.");
    expect(teamSheetChangesToSend(sheet, refused)).toBeNull();
    expect(teamSheetEditProblem(sheet, refused)).toBe("Refused.");
    const retried = addTeamSheetChange(refused, { type: "rename", name: "Two" });
    expect(teamSheetChangesToSend(sheet, retried)).not.toBeNull();
  });

  it("prefers the newest revision of the same sheet", () => {
    const saved = { ...sheet, revision: 5 };
    expect(newestTeamSheet(sheet, saved)).toBe(saved);
    expect(newestTeamSheet(saved, sheet)).toBe(saved);
    expect(newestTeamSheet(sheet, { ...saved, id: TeamSheetId.make("other") })).toBe(sheet);
  });
});
