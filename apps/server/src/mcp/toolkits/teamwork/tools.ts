import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  OrchestratorMcpFailure,
  TeamActInput,
  TeamGrowthDecideInput,
  TeamGrowthRequestInput,
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
      "Start a teamwork run of a sheet in your conversation, for work the user asked for outside a message. Omit `sheetId` for the thread's enabled sheet. Code threads only. While a sheet is on, each user message starts a run by itself, so you rarely need this.",
    parameters: TeamStartInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_list", {
    ...shared,
    description:
      "Read your teamwork runs: flow position, members, tasks, handoffs, evidence, verdicts, growth requests, and reports. A member reads its own team's runs.",
    parameters: Tool.EmptyParams,
    success: TeamListResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_team_act", {
    ...shared,
    description:
      "Update your team's run as yourself. The lead plans tasks, moves the run along the flow chart, and writes the report. Builders hand off. Independent reviewers and validators give verdicts on a named version. Validation needs evidence for each acceptance criterion, and failed checks stay visible. Stop and resume belong to the user.",
    parameters: TeamActInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_start_member", {
    ...shared,
    description:
      "As the Project Lead, give a team (omit `slot`) or a member (`slot` such as m1) its next turn. A bound slot takes the message in its existing session, queued behind any active turn; it never gets a second session. An empty slot starts a session only while this run is the first to use that node. Builders get worktrees. `modelSelection` sets model and effort within the node's option; a change switches the same session.",
    parameters: TeamStartMemberInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_growth_request", {
    ...shared,
    description:
      "As a team or member, ask the Project Lead for capacity your team lacks. Say what is missing, why current members cannot cover it, and what you tried. One request per team per round. It may be refused, and it never starts a session by itself.",
    parameters: TeamGrowthRequestInput,
    success: TeamRun,
  }),
  Tool.make("t3_team_growth_decide", {
    ...shared,
    description:
      "As the Project Lead, decide a growth request with a reason. Deny it when existing members can cover the work, or when idle members or untried options remain. Accepting needs `brief` and starts one new member. Budget and parallel limits apply. Wait for the owner's answer when one is due.",
    parameters: TeamGrowthDecideInput,
    success: TeamRun,
  }),
);
