import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as TeamworkService from "../../../teamwork/TeamworkService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TeamSheetsToolkit } from "./sheets.ts";

const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const orchestrator = { kind: "agent", createdBy: "agent", creationSource: "mcp" } as const;
const service = TeamworkService.TeamworkService;
const sheetsRefused = "change this environment's team sheets";

export const layer = McpToolAccess.toLayer(TeamSheetsToolkit, {
  t3_team_sheet_list: McpToolAccess.readsAsCaller(() =>
    Effect.flatMap(service, (teamwork) => teamwork.listSheets.pipe(Effect.mapError(failure))),
  ),
  t3_team_sheet_get: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(service, (teamwork) => teamwork.getSheet(input).pipe(Effect.mapError(failure))),
  ),
  t3_team_sheet_validate: McpToolAccess.readsAsCaller((input) =>
    Effect.flatMap(service, (teamwork) =>
      teamwork.validateSheet(input).pipe(Effect.mapError(failure)),
    ),
  ),
  t3_team_sheet_create: McpToolAccess.actsAsCaller(
    (input) =>
      Effect.flatMap(service, (teamwork) =>
        teamwork.createSheet(input, orchestrator).pipe(Effect.mapError(failure)),
      ),
    { refused: sheetsRefused },
  ),
  t3_team_sheet_update: McpToolAccess.actsAsCaller(
    (input) =>
      Effect.flatMap(service, (teamwork) =>
        teamwork.updateSheet(input, orchestrator).pipe(Effect.mapError(failure)),
      ),
    { refused: sheetsRefused },
  ),
  t3_team_sheet_duplicate: McpToolAccess.actsAsCaller(
    (input) =>
      Effect.flatMap(service, (teamwork) =>
        teamwork.duplicateSheet(input, orchestrator).pipe(Effect.mapError(failure)),
      ),
    { refused: sheetsRefused },
  ),
  t3_team_sheet_delete: McpToolAccess.actsAsCaller(
    (input) =>
      Effect.flatMap(service, (teamwork) =>
        teamwork.deleteSheet(input, orchestrator).pipe(Effect.as({}), Effect.mapError(failure)),
      ),
    { refused: sheetsRefused },
  ),
  // A linked caller turns a sheet on only for a thread its link started.
  t3_team_sheet_enable: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.flatMap(service, (teamwork) =>
        teamwork.setThreadSheet(input, orchestrator).pipe(Effect.mapError(failure)),
      ),
  ),
});
