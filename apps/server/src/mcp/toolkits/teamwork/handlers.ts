import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TeamworkService from "../../../teamwork/TeamworkService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { TeamworkToolkit } from "./tools.ts";

const caller = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const own = yield* McpInvocationContext.requireThreadScope(scope, "Teamwork");
  return {
    kind: "agent",
    createdBy: "agent",
    creationSource: "mcp",
    threadId: own.thread.threadId,
  } as const;
});
const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

export const layer = McpToolAccess.toLayer(TeamworkToolkit, {
  t3_team_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* TeamworkService.TeamworkService)
        .start(input, yield* caller)
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_team_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const own = yield* caller;
      return yield* (yield* TeamworkService.TeamworkService)
        .listForCaller(own.threadId)
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_team_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* TeamworkService.TeamworkService)
        .act(input, yield* caller)
        .pipe(Effect.mapError(failure));
    }),
  ),
  t3_team_start_member: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* (yield* TeamworkService.TeamworkService)
        .startMember(input, yield* caller)
        .pipe(Effect.mapError(failure));
    }),
  ),
});
