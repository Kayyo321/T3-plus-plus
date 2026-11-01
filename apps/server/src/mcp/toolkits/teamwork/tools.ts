import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  OrchestratorMcpFailure,
  TeamActInput,
  TeamListResult,
  TeamRun,
  TeamStartInput,
  TeamStartMemberInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
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

export const TeamworkToolkit = Toolkit.make(
  Tool.make("t3_team_start", {
    ...shared,
    description:
      "Create a teamwork board under your conversation. Choose fix-a-bug, build-a-feature, or audit. Members start only when requested with t3_team_start_member; a dry run allows only the lead to plan.",
    parameters: TeamStartInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_list", {
    ...shared,
    description:
      "Read your teamwork boards: phases, tasks, handoffs, evidence, and reports. A member can read its own team's board.",
    parameters: Tool.EmptyParams,
    success: TeamListResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_team_act", {
    ...shared,
    description:
      "Update your team's board as yourself. Leads advance phases and write reports; independent reviewers give verdicts. Verification needs command output, and failed checks remain visible. Owner approvals and stop decisions belong to the user.",
    parameters: TeamActInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_start_member", {
    ...shared,
    description:
      "As the parent or lead, start one designated team member with its assignment. Builders get isolated worktrees. The server enforces the parallel limit; reuse an existing member conversation with t3_thread_send.",
    parameters: TeamStartMemberInput,
    success: TeamRun,
  }),
);
