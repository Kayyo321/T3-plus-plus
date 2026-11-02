import {
  OrchestratorMcpFailure,
  TeamSheet,
  TeamSheetCreateInput,
  TeamSheetDeleteInput,
  TeamSheetDuplicateInput,
  TeamSheetGetInput,
  TeamSheetListResult,
  TeamSheetUpdateInput,
  TeamSheetValidateInput,
  TeamSheetValidateResult,
  TeamThreadSheet,
  TeamThreadSheetSetInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as TeamworkService from "../../../teamwork/TeamworkService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ThreadManagementService.ThreadManagementService,
    TeamworkService.TeamworkService,
    McpInvocationContext.McpInvocationContext,
  ],
};

/** The orchestrator's only: other agents run sheets, and do not design them. */
export const TeamSheetsToolkit = Toolkit.make(
  Tool.make("t3_team_sheet_list", {
    ...shared,
    description: "List team sheets, the read-only default first.",
    parameters: Tool.EmptyParams,
    success: TeamSheetListResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_team_sheet_get", {
    ...shared,
    description: "Read one sheet with its nodes, lines, and `revision`.",
    parameters: TeamSheetGetInput,
    success: TeamSheet,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_team_sheet_validate", {
    ...shared,
    description:
      "Check a saved sheet or a draft `design` without saving. Returns what is wrong, in plain sentences.",
    parameters: TeamSheetValidateInput,
    success: TeamSheetValidateResult,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_team_sheet_create", {
    ...shared,
    description:
      "Create a sheet. Omit `design` to copy the default. A `design` has exactly one `lead` node, teams of kind build, review, or validate, and `handoff` lines from the lead, past a check, back to the lead; `return` lines send corrections back. Use it, not thread tools, when asked for a team setup.",
    parameters: TeamSheetCreateInput,
    success: TeamSheet,
  }),
  Tool.make("t3_team_sheet_update", {
    ...shared,
    description:
      "Edit a sheet with small `changes`, passing the `revision` you read as `baseRevision`. Read it with `t3_team_sheet_get` first. A stale revision is refused: read again. The open editor shows the change live. The default sheet is read-only.",
    parameters: TeamSheetUpdateInput,
    success: TeamSheet,
  }),
  Tool.make("t3_team_sheet_duplicate", {
    ...shared,
    description: "Copy a sheet, such as the default, into an editable one.",
    parameters: TeamSheetDuplicateInput,
    success: TeamSheet,
  }),
  Tool.make("t3_team_sheet_delete", {
    ...shared,
    description:
      "Delete a sheet. Threads using it turn teamwork off; their sessions stay. This cannot be undone.",
    parameters: TeamSheetDeleteInput,
    success: Schema.Struct({}),
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_team_sheet_enable", {
    ...shared,
    description:
      "Turn a sheet on or off for a Code thread. `sheetId` null turns teamwork off; rosters stay.",
    parameters: TeamThreadSheetSetInput,
    success: TeamThreadSheet,
  }),
);
