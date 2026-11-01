import {
  GitGraphActionResult,
  GitGraphBlameResult,
  GitGraphBranchAction,
  GitGraphChanges,
  GitGraphCommitAction,
  GitGraphCommitDetail,
  GitGraphConversationMark,
  GitGraphDiscardAction,
  GitGraphFilter,
  GitGraphIntegrateAction,
  GitGraphOperationAction,
  GitGraphPreview,
  GitGraphRecoveryRestoreAction,
  GitGraphRewriteAction,
  GitGraphRowRef,
  GitGraphStageAction,
  GitGraphStashAction,
  GitGraphSummary,
  GitGraphSyncAction,
  NonNegativeInt,
  OrchestratorMcpFailure,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as GitActions from "../../../git/graph/GitActions.ts";
import * as GitGraphService from "../../../git/graph/GitGraphService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  GitGraphService.GitGraphService,
  GitActions.GitActions,
];

const threadId = Schema.optional(
  ThreadId.annotate({ description: "Whose repository. Default: this thread's." }),
);

const GitGraphToolRow = Schema.Struct({
  sha: TrimmedNonEmptyString,
  parents: Schema.Array(TrimmedNonEmptyString),
  subject: Schema.String,
  authorName: Schema.String,
  authoredAt: NonNegativeInt,
  refs: Schema.Array(GitGraphRowRef),
  agentMade: Schema.Boolean,
  conversation: Schema.NullOr(GitGraphConversationMark),
});

const GitGraphToolResult = Schema.Struct({
  rows: Schema.Array(GitGraphToolRow),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  reset: Schema.Boolean,
  summary: Schema.NullOr(GitGraphSummary),
});

const action = <const Name extends string, A extends Schema.Top>(
  name: Name,
  description: string,
  schema: A,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct({ threadId, action: schema }),
    success: GitGraphActionResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Idempotent, false);

const read = <const Name extends string, P extends Schema.Struct.Fields, S extends Schema.Top>(
  name: Name,
  description: string,
  fields: P,
  success: S,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct({ threadId, ...fields }),
    success,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false);

const GitGraphTool = read(
  "t3_git_graph",
  "Read commit history across all branches, tags, and remotes, newest first, with the conversation that made each commit. The first page adds a summary: branches with ahead and behind, worktrees, stashes, recovery points, any merge in progress, and risky unpushed commits. Pass `nextCursor` for more.",
  {
    cursor: Schema.optional(TrimmedNonEmptyString),
    limit: Schema.optional(PositiveInt.annotate({ description: "Default 30, max 200." })),
    filter: Schema.optional(GitGraphFilter),
  },
  GitGraphToolResult,
).annotate(Tool.Title, "Read the commit graph");

const GitCommitInfoTool = read(
  "t3_git_commit_info",
  "Read one commit: full message, changed files, the conversation that made it, and risk flags.",
  { sha: TrimmedNonEmptyString },
  GitGraphCommitDetail,
).annotate(Tool.Title, "Read a commit");

const GitChangesTool = read(
  "t3_git_changes",
  "List uncommitted files. Pass `path` for its hunks, whose ids `t3_git_stage` takes.",
  { path: Schema.optional(Schema.String) },
  GitGraphChanges,
).annotate(Tool.Title, "Read uncommitted changes");

const GitBlameTool = read(
  "t3_git_blame",
  "Find the commit and conversation that wrote one line.",
  {
    path: Schema.String,
    line: PositiveInt,
    revision: Schema.optional(TrimmedNonEmptyString),
  },
  GitGraphBlameResult,
).annotate(Tool.Title, "Blame a line");

const GitPreviewTool = read(
  "t3_git_preview",
  "See exactly what a Git action would change, including predicted conflicts, without doing it. Call before merge, rebase, rollback, or delete, and tell the user what it says.",
  {
    action: Schema.Union([
      GitGraphIntegrateAction,
      GitGraphRewriteAction,
      GitGraphDiscardAction,
      GitGraphRecoveryRestoreAction,
    ]),
  },
  GitGraphPreview,
).annotate(Tool.Title, "Preview a Git action");

const GitStageTool = action(
  "t3_git_stage",
  "Stage or unstage whole files, or single hunks from `t3_git_changes`.",
  GitGraphStageAction,
)
  .annotate(Tool.Title, "Stage changes")
  .annotate(Tool.Destructive, false);

const GitCommitTool = action("t3_git_commit", "Commit what is staged.", GitGraphCommitAction)
  .annotate(Tool.Title, "Commit")
  .annotate(Tool.Destructive, false);

const GitBranchTool = action(
  "t3_git_branch",
  "Create a branch from any commit, check one out, or rename one.",
  GitGraphBranchAction,
)
  .annotate(Tool.Title, "Change branches")
  .annotate(Tool.Destructive, false);

const GitIntegrateTool = action(
  "t3_git_integrate",
  "Merge a branch into the current one, or copy one commit onto it. Saves a recovery point first. On outcome `conflicts`, resolve and stage them, then use `t3_git_operation`.",
  GitGraphIntegrateAction,
)
  .annotate(Tool.Title, "Merge or cherry-pick")
  .annotate(Tool.Destructive, false);

const GitOperationTool = action(
  "t3_git_operation",
  "Continue or abort the merge, rebase, or cherry-pick in progress.",
  GitGraphOperationAction,
)
  .annotate(Tool.Title, "Finish or abort a Git operation")
  .annotate(Tool.Destructive, true);

const GitStashTool = action(
  "t3_git_stash",
  "Stash uncommitted changes, or apply a stash and keep it listed.",
  GitGraphStashAction,
)
  .annotate(Tool.Title, "Stash changes")
  .annotate(Tool.Destructive, false);

const GitRecoveryTool = action(
  "t3_git_recovery",
  "Go back to a recovery point: restores the branch, its files, or a dropped stash. Saves the current state first, so this can be undone too.",
  GitGraphRecoveryRestoreAction,
)
  .annotate(Tool.Title, "Restore a recovery point")
  .annotate(Tool.Destructive, true);

const GitRewriteTool = action(
  "t3_git_rewrite",
  "Rebase the current branch, roll it back, or return its files to a checkpoint. Rewrites history. Saves a recovery point first and returns it. Run `t3_git_preview` first.",
  GitGraphRewriteAction,
)
  .annotate(Tool.Title, "Rewrite history")
  .annotate(Tool.Destructive, true);

const GitDiscardTool = action(
  "t3_git_discard",
  "Delete a branch, drop a stash, or remove a recovery point. Branches and stashes keep a recovery point. Unmerged branches need `acknowledgeUnmerged`.",
  GitGraphDiscardAction,
)
  .annotate(Tool.Title, "Discard a branch or stash")
  .annotate(Tool.Destructive, true);

const GitSyncTool = action(
  "t3_git_sync",
  "Push the current branch, pull it fast-forward, or fetch every remote.",
  GitGraphSyncAction,
)
  .annotate(Tool.Title, "Push, pull, or fetch")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const GitPullRequestTool = Tool.make("t3_git_create_pull_request", {
  description:
    "Open a pull request from the current branch, pushing it if needed, and link it to this thread.",
  parameters: Schema.Struct({ threadId }),
  success: GitGraphActionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a pull request")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const GitToolkit = Toolkit.make(
  GitGraphTool,
  GitCommitInfoTool,
  GitChangesTool,
  GitBlameTool,
  GitPreviewTool,
  GitStageTool,
  GitCommitTool,
  GitBranchTool,
  GitIntegrateTool,
  GitOperationTool,
  GitStashTool,
  GitRecoveryTool,
  GitRewriteTool,
  GitDiscardTool,
  GitSyncTool,
  GitPullRequestTool,
);
