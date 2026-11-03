import { describe, expect, it } from "@effect/vitest";
import { TEAM_LEAD_MEMBER_ID, TEAM_SESSION_SLOT, TeamNodeId } from "@t3tools/contracts";

import {
  applyTeamSheetChanges,
  DEFAULT_TEAM_SHEET,
  isTeamLead,
  leadNodeOf,
  teamLeadInstructions,
  teamMemberId,
  teamMemberName,
  teamSheetProblems,
} from "./teamSheets.ts";

const build = TeamNodeId.make("build");
const review = TeamNodeId.make("review");
const validate = TeamNodeId.make("validate");
const lead = TeamNodeId.make("lead");
const extra = {
  id: TeamNodeId.make("docs"),
  kind: "build",
  name: "Docs",
  instructions: "",
  position: { x: 0, y: 0 },
  modelChoice: { type: "lead" },
} as const;

describe("teamSheetProblems", () => {
  it("accepts the default sheet", () => {
    expect(teamSheetProblems(DEFAULT_TEAM_SHEET)).toEqual([]);
  });

  it("refuses a sheet without exactly one lead", () => {
    const { nodes, edges } = DEFAULT_TEAM_SHEET;
    expect(teamSheetProblems({ nodes: nodes.slice(1), edges })).toEqual([
      "This sheet has no Project Lead.",
    ]);
    expect(teamSheetProblems({ nodes: [...nodes, { ...nodes[0]!, id: extra.id }], edges })).toEqual(
      ["This sheet has more than one Project Lead."],
    );
  });

  it("names a team the lead cannot reach", () => {
    const sheet = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [{ type: "add_node", node: extra }]);
    expect(teamSheetProblems(sheet)).toContain("The Project Lead cannot reach Docs.");
  });

  it("needs a forward path past a check and back to the lead", () => {
    const sheet = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      { type: "disconnect", edge: { from: validate, to: lead, kind: "handoff" } },
    ]);
    expect(teamSheetProblems(sheet)).toContain(
      "Work needs a path from the Project Lead, past a check, back to the lead.",
    );
    const unchecked = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      { type: "remove_node", nodeId: review },
      { type: "remove_node", nodeId: validate },
      { type: "connect", edge: { from: build, to: lead, kind: "handoff" } },
    ]);
    expect(teamSheetProblems(unchecked)).toContain(
      "Work needs a path from the Project Lead, past a check, back to the lead.",
    );
  });

  it("refuses more teams or lines than a sheet holds", () => {
    const teams = Array.from({ length: 29 }, (_, index) => ({
      ...extra,
      id: TeamNodeId.make(`team-${index}`),
      name: `Team ${index}`,
    }));
    const lines = Array.from({ length: 123 }, () => ({
      from: lead,
      to: build,
      kind: "handoff" as const,
    }));
    const problems = teamSheetProblems({
      nodes: [...DEFAULT_TEAM_SHEET.nodes, ...teams],
      edges: [...DEFAULT_TEAM_SHEET.edges, ...lines],
    });
    expect(problems).toContain("A sheet has room for 32 teams at most.");
    expect(problems).toContain("A sheet has room for 128 lines at most.");
  });

  it("refuses a model option for a provider the environment lacks", () => {
    const sheet = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      {
        type: "update_node",
        nodeId: review,
        modelChoice: { type: "provider", instanceId: "missing" as never },
      },
    ]);
    expect(teamSheetProblems(sheet, { instanceIds: new Set(["codex"]) })).toEqual([
      "Review uses a provider this environment does not have.",
    ]);
  });
});

describe("applyTeamSheetChanges", () => {
  it("keeps a node's id through a rename and drops its lines with it", () => {
    const renamed = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      { type: "update_node", nodeId: build, name: "Makers" },
    ]);
    expect(renamed.nodes.find((node) => node.id === build)?.name).toBe("Makers");
    const removed = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      { type: "remove_node", nodeId: review },
    ]);
    expect(removed.edges.some((edge) => edge.from === review || edge.to === review)).toBe(false);
  });

  it("sets growth only on the lead", () => {
    const grown = applyTeamSheetChanges(DEFAULT_TEAM_SHEET, [
      { type: "update_node", nodeId: lead, growth: { mode: "ask", scope: "sheet" } },
    ]);
    expect(leadNodeOf(grown)?.growth).toEqual({ mode: "ask", scope: "sheet" });
  });
});

describe("member naming", () => {
  it("reads the team's own session as the team", () => {
    expect(teamMemberName("Build", TEAM_SESSION_SLOT)).toBe("Build");
    expect(teamMemberName("Build", "m1")).toBe("Build m1");
    expect(teamMemberId(build, "m1")).toBe("build/m1");
    expect(isTeamLead(TEAM_LEAD_MEMBER_ID)).toBe(true);
  });
});

it("gives every lead the operating rules", () => {
  expect(teamLeadInstructions(DEFAULT_TEAM_SHEET)).toContain("One owner per task");
});
