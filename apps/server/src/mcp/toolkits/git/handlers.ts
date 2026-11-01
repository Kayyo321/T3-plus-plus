import {
  type GitGraphAction,
  type GitGraphBranchAction,
  type GitGraphCommitAction,
  type GitGraphDiscardAction,
  type GitGraphIntegrateAction,
  type GitGraphOperationAction,
  type GitGraphRecoveryRestoreAction,
  type GitGraphRewriteAction,
  type GitGraphStageAction,
  type GitGraphStashAction,
  type GitGraphSyncAction,
  type GitGraphServiceError,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as GitActions from "../../../git/graph/GitActions.ts";
import * as GitGraphService from "../../../git/graph/GitGraphService.ts";
import * as Project from "../../../project/ProjectService.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { GitToolkit } from "./tools.ts";

const DEFAULT_GRAPH_ROWS = 30;

const toFailure = (error: GitGraphServiceError) =>
  new OrchestratorMcpFailure({
    code: error._tag === "GitGraphError" ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

/** The thread's own checkout: a worktree when it has one, otherwise the project folder. */
const repositoryOf = Effect.fn("mcp.git.repositoryOf")(function* (threadId?: ThreadId) {
  const context = yield* McpInvocationContext.McpInvocationContext;
  if (!context.capabilities.has("worktree")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot reach repositories.",
    });
  }
  const {
    projection: { thread },
  } = yield* readThread(threadId);
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }
  return {
    cwd: thread.worktreePath ?? project.value.workspaceRoot,
    threadId: thread.id,
    context,
  };
});

const runAction = Effect.fn("mcp.git.runAction")(function* (
  threadId: ThreadId | undefined,
  action: GitGraphAction,
) {
  const repository = yield* repositoryOf(threadId);
  const actions = yield* GitActions.GitActions;
  const caller = repository.context.client?.label ?? repository.context.thread?.providerInstanceId;
  return yield* actions
    .act(
      { cwd: repository.cwd, action, threadId: repository.threadId },
      { actor: "agent", ...(caller === undefined ? {} : { actorLabel: caller }) },
    )
    .pipe(Effect.mapError(toFailure));
});

const actionHandler = <A extends GitGraphAction>() =>
  McpToolAccess.writesThreads(
    (input: { readonly threadId?: ThreadId | undefined; readonly action: A }) => [input.threadId],
    (input) => runAction(input.threadId, input.action),
  );

const handlers = {
  t3_git_graph: McpToolAccess.reads(({ threadId, limit, ...input }) =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryOf(threadId);
      const graph = yield* GitGraphService.GitGraphService;
      const page = yield* graph
        .list({ cwd, ...input, limit: limit ?? DEFAULT_GRAPH_ROWS })
        .pipe(Effect.mapError(toFailure));
      return {
        rows: page.rows.map((row) => ({
          sha: row.sha,
          parents: row.parents,
          subject: row.subject,
          authorName: row.authorName,
          authoredAt: row.authoredAt,
          refs: row.refs,
          agentMade: row.agentMade,
          conversation: row.conversation,
        })),
        nextCursor: page.nextCursor,
        reset: page.reset,
        summary: page.summary,
      };
    }),
  ),
  t3_git_commit_info: McpToolAccess.reads(({ threadId, sha }) =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryOf(threadId);
      const graph = yield* GitGraphService.GitGraphService;
      return yield* graph.commit({ cwd, sha }).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_git_changes: McpToolAccess.reads(({ threadId, path }) =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryOf(threadId);
      const graph = yield* GitGraphService.GitGraphService;
      return yield* graph
        .changes({ cwd, ...(path === undefined ? {} : { path }) })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_git_blame: McpToolAccess.reads(({ threadId, ...input }) =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryOf(threadId);
      const graph = yield* GitGraphService.GitGraphService;
      return yield* graph.blame({ cwd, ...input }).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_git_preview: McpToolAccess.reads(({ threadId, action }) =>
    Effect.gen(function* () {
      const { cwd } = yield* repositoryOf(threadId);
      const actions = yield* GitActions.GitActions;
      return yield* actions.preview({ cwd, action }).pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_git_stage: actionHandler<GitGraphStageAction>(),
  t3_git_commit: actionHandler<GitGraphCommitAction>(),
  t3_git_branch: actionHandler<GitGraphBranchAction>(),
  t3_git_integrate: actionHandler<GitGraphIntegrateAction>(),
  t3_git_operation: actionHandler<GitGraphOperationAction>(),
  t3_git_stash: actionHandler<GitGraphStashAction>(),
  t3_git_recovery: actionHandler<GitGraphRecoveryRestoreAction>(),
  t3_git_rewrite: actionHandler<GitGraphRewriteAction>(),
  t3_git_discard: actionHandler<GitGraphDiscardAction>(),
  t3_git_sync: actionHandler<GitGraphSyncAction>(),
  t3_git_create_pull_request: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) => runAction(input.threadId, { type: "createPullRequest" }),
  ),
} satisfies McpToolAccess.Handlers<typeof GitToolkit.tools>;

export const layer = McpToolAccess.toLayer(GitToolkit, handlers);
