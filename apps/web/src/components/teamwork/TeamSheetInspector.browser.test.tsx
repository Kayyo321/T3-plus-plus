import { EnvironmentId, type TeamGrowth, type TeamSheetChange } from "@t3tools/contracts";
import { DEFAULT_TEAM_SHEET, leadNodeOf } from "@t3tools/shared/teamSheets";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TeamSheetInspector } from "./TeamSheetInspector";

const lead = leadNodeOf(DEFAULT_TEAM_SHEET)!;

function LeadInspector(props: { readonly onChange: (change: TeamSheetChange) => void }) {
  const [growth, setGrowth] = useState<TeamGrowth>(lead.growth);
  return (
    <TeamSheetInspector
      environmentId={EnvironmentId.make("environment")}
      sheet={DEFAULT_TEAM_SHEET}
      node={{ ...lead, growth }}
      onChange={(change) => {
        props.onChange(change);
        if (change.type === "update_node" && change.growth) setGrowth(change.growth);
      }}
    />
  );
}

describe("TeamSheetInspector", () => {
  it("saves Growth and shows Scope only while Growth is On or Ask", async () => {
    const onChange = vi.fn();
    // The inspector renders no links.
    await using screen = await render(<LeadInspector onChange={onChange} />, { router: false });
    await expect.element(screen.getByText("This thread's model.")).toBeVisible();
    await expect.element(screen.getByRole("group", { name: "Scope" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: "update_node",
      nodeId: lead.id,
      growth: { mode: "ask", scope: "session" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Save to sheet" }));
    expect(onChange).toHaveBeenLastCalledWith({
      type: "update_node",
      nodeId: lead.id,
      growth: { mode: "ask", scope: "sheet" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Off" }));
    await expect.element(screen.getByRole("group", { name: "Scope" })).not.toBeInTheDocument();
  });
});
