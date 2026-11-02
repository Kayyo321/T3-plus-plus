import { TeamNodeId } from "@t3tools/contracts";
import { DEFAULT_TEAM_SHEET } from "@t3tools/shared/teamSheets";
import { expect, it } from "vite-plus/test";

import { teamNodeMenu } from "./teamSheetMenu";

const nodeOf = (kind: string) => {
  const node = DEFAULT_TEAM_SHEET.nodes.find((candidate) => candidate.kind === kind);
  return node?.id ?? TeamNodeId.make("missing");
};

it("connects a free line, removes a drawn one, and never offers the card itself", () => {
  const build = nodeOf("build");
  const review = nodeOf("review");
  const { items, actions } = teamNodeMenu(DEFAULT_TEAM_SHEET, build);
  const targets = items.find((item) => item.id === "connect")?.children ?? [];
  expect(targets.map((target) => target.id)).not.toContain(`target:${build}`);
  expect(actions.get(`connect:${review}:handoff`)).toMatchObject({ type: "disconnect" });
  expect(actions.get(`connect:${review}:return`)).toMatchObject({ type: "connect" });
});

it("keeps the Project Lead on the sheet", () => {
  const { actions } = teamNodeMenu(DEFAULT_TEAM_SHEET, nodeOf("lead"));
  expect(actions.has("delete")).toBe(false);
});
