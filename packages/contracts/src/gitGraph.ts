import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";

export const GIT_GRAPH_PAGE_MAX_ROWS = 200;
/** Lanes past this share one overflow column, so wide repositories keep rows small. */
export const GIT_GRAPH_MAX_LANES = 24;
export const GIT_GRAPH_LANE_COLORS = 8;
export const GIT_GRAPH_PREVIEW_MAX_ITEMS = 50;
export const GIT_GRAPH_MAX_HUNKS = 200;

export const GitGraphRowKind = Schema.Literals(["commit", "checkpoint"]);
export type GitGraphRowKind = typeof GitGraphRowKind.Type;

export const GitGraphRefKind = Schema.Literals(["head", "branch", "remote", "tag"]);
export type GitGraphRefKind = typeof GitGraphRefKind.Type;

export const GitGraphRowRef = Schema.Struct({
  kind: GitGraphRefKind,
  name: TrimmedNonEmptyString,
});
export type GitGraphRowRef = typeof GitGraphRowRef.Type;

/** `[lane, color]`: a tuple because every row repeats these. */
export const GitGraphLaneSegment = Schema.Tuple([NonNegativeInt, NonNegativeInt]);
export type GitGraphLaneSegment = typeof GitGraphLaneSegment.Type;

export const GitGraphConversationMark = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  runId: Schema.NullOr(RunId),
  turn: Schema.NullOr(PositiveInt),
});
export type GitGraphConversationMark = typeof GitGraphConversationMark.Type;

export const GitGraphRow = Schema.Struct({
  kind: GitGraphRowKind,
  sha: TrimmedNonEmptyString,
  parents: Schema.Array(TrimmedNonEmptyString),
  subject: Schema.String,
  authorName: Schema.String,
  /** Unix seconds. */
  authoredAt: NonNegativeInt,
  refs: Schema.Array(GitGraphRowRef),
  lane: NonNegativeInt,
  color: NonNegativeInt,
  /** Lanes running past this row untouched. */
  through: Schema.Array(GitGraphLaneSegment),
  /** Lanes that end at this row's node, drawn in its top half. */
  into: Schema.Array(GitGraphLaneSegment),
  /** Lanes leaving this row's node, drawn in its bottom half. */
  out: Schema.Array(GitGraphLaneSegment),
  /** True when a turn made this commit or its trailers credit an agent. */
  agentMade: Schema.Boolean,
  conversation: Schema.NullOr(GitGraphConversationMark),
  /** The hidden ref of a `checkpoint` row. */
  checkpointRef: Schema.NullOr(TrimmedNonEmptyString),
});
export type GitGraphRow = typeof GitGraphRow.Type;

export const GitGraphFilter = Schema.Struct({
  author: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  message: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.optional(ThreadId),
  agentOnly: Schema.optional(Schema.Boolean),
});
export type GitGraphFilter = typeof GitGraphFilter.Type;

export const GitGraphListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** The `nextCursor` of the page before. */
  cursor: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
  filter: Schema.optional(GitGraphFilter),
  /** Overlays hidden checkpoint refs, narrowed to one conversation when `checkpointThreadId` is set. */
  showCheckpoints: Schema.optional(Schema.Boolean),
  checkpointThreadId: Schema.optional(ThreadId),
});
export type GitGraphListInput = typeof GitGraphListInput.Type;

export const GitGraphBranch = Schema.Struct({
  name: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
  upstream: Schema.NullOr(TrimmedNonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  isHead: Schema.Boolean,
});
export type GitGraphBranch = typeof GitGraphBranch.Type;

export const GitGraphWorktree = Schema.Struct({
  path: TrimmedNonEmptyString,
  sha: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  isCurrent: Schema.Boolean,
});
export type GitGraphWorktree = typeof GitGraphWorktree.Type;

export const GitGraphOperationKind = Schema.Literals(["merge", "rebase", "cherry-pick"]);
export type GitGraphOperationKind = typeof GitGraphOperationKind.Type;

export const GitGraphOperation = Schema.Struct({
  kind: GitGraphOperationKind,
  /** What is being brought in, when Git recorded it. */
  incoming: Schema.NullOr(Schema.String),
  conflicts: Schema.Array(Schema.String),
  /** Restores the state from before this operation began. */
  recoveryId: Schema.NullOr(TrimmedNonEmptyString),
});
export type GitGraphOperation = typeof GitGraphOperation.Type;

export const GitGraphStash = Schema.Struct({
  sha: TrimmedNonEmptyString,
  ref: TrimmedNonEmptyString,
  message: Schema.String,
  createdAt: NonNegativeInt,
});
export type GitGraphStash = typeof GitGraphStash.Type;

export const GitGraphRecoveryKind = Schema.Literals([
  "rollback",
  "merge",
  "rebase",
  "cherry-pick",
  "branch-delete",
  "stash-drop",
  "restore",
]);
export type GitGraphRecoveryKind = typeof GitGraphRecoveryKind.Type;

export const GitGraphRecoveryPoint = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: GitGraphRecoveryKind,
  label: Schema.String,
  sha: TrimmedNonEmptyString,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** True when uncommitted changes were saved alongside the commit. */
  savedChanges: Schema.Boolean,
  createdAt: NonNegativeInt,
});
export type GitGraphRecoveryPoint = typeof GitGraphRecoveryPoint.Type;

export const GitGraphRiskReason = Schema.Literals(["sensitive-path", "large-commit"]);
export type GitGraphRiskReason = typeof GitGraphRiskReason.Type;

export const GitGraphCommitRisk = Schema.Struct({
  sha: TrimmedNonEmptyString,
  reasons: Schema.Array(GitGraphRiskReason),
  sensitivePaths: Schema.Array(Schema.String),
  changedLines: NonNegativeInt,
  changedFiles: NonNegativeInt,
});
export type GitGraphCommitRisk = typeof GitGraphCommitRisk.Type;

export const GitGraphSummary = Schema.Struct({
  /** Set when the view shows history but must not change it, with the reason to show. */
  readOnlyReason: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  upstream: Schema.NullOr(TrimmedNonEmptyString),
  ahead: NonNegativeInt,
  behind: NonNegativeInt,
  branches: Schema.Array(GitGraphBranch),
  worktrees: Schema.Array(GitGraphWorktree),
  operation: Schema.NullOr(GitGraphOperation),
  stashes: Schema.Array(GitGraphStash),
  recoveries: Schema.Array(GitGraphRecoveryPoint),
  risks: Schema.Array(GitGraphCommitRisk),
  changedFiles: NonNegativeInt,
});
export type GitGraphSummary = typeof GitGraphSummary.Type;

export const GitGraphLayout = Schema.Literals(["graph", "flat"]);
export type GitGraphLayout = typeof GitGraphLayout.Type;

export const GitGraphPage = Schema.Struct({
  /** Changes when any branch, tag, or remote ref moves. */
  revision: TrimmedNonEmptyString,
  rows: Schema.Array(GitGraphRow),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
  /** The cursor went stale because refs moved; these rows restart the list. */
  reset: Schema.Boolean,
  /** Filtered lists are `flat`: they have no lanes because matches are rarely adjacent. */
  layout: GitGraphLayout,
  /** First pages only. */
  summary: Schema.NullOr(GitGraphSummary),
});
export type GitGraphPage = typeof GitGraphPage.Type;

export const GitGraphCommitInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sha: TrimmedNonEmptyString,
});
export type GitGraphCommitInput = typeof GitGraphCommitInput.Type;

export const GitGraphFileChange = Schema.Struct({
  path: Schema.String,
  /** Git's one-letter status: A, M, D, R, and so on. */
  status: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type GitGraphFileChange = typeof GitGraphFileChange.Type;

export const GitGraphCommitDetail = Schema.Struct({
  sha: TrimmedNonEmptyString,
  parents: Schema.Array(TrimmedNonEmptyString),
  message: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAt: NonNegativeInt,
  files: Schema.Array(GitGraphFileChange),
  filesTruncated: Schema.Boolean,
  conversation: Schema.NullOr(GitGraphConversationMark),
  risk: Schema.NullOr(GitGraphCommitRisk),
});
export type GitGraphCommitDetail = typeof GitGraphCommitDetail.Type;

export const GitGraphChangesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Adds the hunks of this file, staged and unstaged. */
  path: Schema.optional(Schema.String),
});
export type GitGraphChangesInput = typeof GitGraphChangesInput.Type;

export const GitGraphChangedFile = Schema.Struct({
  path: Schema.String,
  /** Porcelain v1 status letters; `?` for untracked, and ` ` where a side is clean. */
  staged: Schema.String,
  unstaged: Schema.String,
});
export type GitGraphChangedFile = typeof GitGraphChangedFile.Type;

export const GitGraphHunk = Schema.Struct({
  /** Hash of the hunk's text: a stale id cannot apply to a newer diff. */
  id: TrimmedNonEmptyString,
  staged: Schema.Boolean,
  header: Schema.String,
  lines: Schema.Array(Schema.String),
});
export type GitGraphHunk = typeof GitGraphHunk.Type;

export const GitGraphChanges = Schema.Struct({
  files: Schema.Array(GitGraphChangedFile),
  filesTruncated: Schema.Boolean,
  hunks: Schema.Array(GitGraphHunk),
  hunksTruncated: Schema.Boolean,
});
export type GitGraphChanges = typeof GitGraphChanges.Type;

export const GitGraphRollbackMode = Schema.Literals(["soft", "mixed", "hard"]);
export type GitGraphRollbackMode = typeof GitGraphRollbackMode.Type;

const GitRevision = TrimmedNonEmptyString;
const GitBranchName = TrimmedNonEmptyString;
const GitFilePaths = Schema.Array(Schema.String.check(Schema.isNonEmpty()));

export type GitGraphStageAction = typeof GitGraphStageAction.Type;
export const GitGraphStageAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("stage"), paths: GitFilePaths }),
  Schema.Struct({ type: Schema.Literal("unstage"), paths: GitFilePaths }),
  Schema.Struct({
    type: Schema.Literal("stageHunk"),
    path: Schema.String,
    hunkId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("unstageHunk"),
    path: Schema.String,
    hunkId: TrimmedNonEmptyString,
  }),
]);

export type GitGraphCommitAction = typeof GitGraphCommitAction.Type;
export const GitGraphCommitAction = Schema.Struct({
  type: Schema.Literal("commit"),
  message: TrimmedNonEmptyString,
});

export type GitGraphBranchAction = typeof GitGraphBranchAction.Type;
export const GitGraphBranchAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("branchCreate"),
    name: GitBranchName,
    startPoint: GitRevision,
    checkout: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("branchCheckout"), name: GitBranchName }),
  Schema.Struct({ type: Schema.Literal("branchRename"), from: GitBranchName, to: GitBranchName }),
]);

export type GitGraphIntegrateAction = typeof GitGraphIntegrateAction.Type;
export const GitGraphIntegrateAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("merge"), ref: GitRevision }),
  Schema.Struct({ type: Schema.Literal("cherryPick"), sha: GitRevision }),
]);

/** Moves or replaces commits. Each saves a recovery point first. */
export type GitGraphRewriteAction = typeof GitGraphRewriteAction.Type;
export const GitGraphRewriteAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("rebase"), onto: GitRevision }),
  Schema.Struct({
    type: Schema.Literal("rollback"),
    target: GitRevision,
    mode: GitGraphRollbackMode,
  }),
  Schema.Struct({
    type: Schema.Literal("rollbackToCheckpoint"),
    checkpointRef: TrimmedNonEmptyString,
  }),
]);

export type GitGraphOperationAction = typeof GitGraphOperationAction.Type;
export const GitGraphOperationAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("operationContinue") }),
  Schema.Struct({ type: Schema.Literal("operationAbort") }),
]);

export type GitGraphSyncAction = typeof GitGraphSyncAction.Type;
export const GitGraphSyncAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("push") }),
  Schema.Struct({ type: Schema.Literal("pull") }),
  Schema.Struct({ type: Schema.Literal("fetch") }),
]);

export type GitGraphStashAction = typeof GitGraphStashAction.Type;
export const GitGraphStashAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stashPush"),
    message: Schema.optional(Schema.String),
    includeUntracked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("stashApply"), sha: GitRevision }),
]);

/** Removes something from view. Branches and stashes keep a recovery point. */
export type GitGraphDiscardAction = typeof GitGraphDiscardAction.Type;
export const GitGraphDiscardAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("branchDelete"),
    name: GitBranchName,
    /** Required to delete a branch holding commits found nowhere else. */
    acknowledgeUnmerged: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("stashDrop"), sha: GitRevision }),
  Schema.Struct({ type: Schema.Literal("recoveryDismiss"), id: TrimmedNonEmptyString }),
]);

export type GitGraphRecoveryRestoreAction = typeof GitGraphRecoveryRestoreAction.Type;
export const GitGraphRecoveryRestoreAction = Schema.Struct({
  type: Schema.Literal("recoveryRestore"),
  id: TrimmedNonEmptyString,
});

export const GitGraphPullRequestAction = Schema.Struct({
  type: Schema.Literal("createPullRequest"),
});

export const GitGraphAction = Schema.Union([
  ...GitGraphStageAction.members,
  GitGraphCommitAction,
  ...GitGraphBranchAction.members,
  ...GitGraphIntegrateAction.members,
  ...GitGraphRewriteAction.members,
  ...GitGraphOperationAction.members,
  ...GitGraphSyncAction.members,
  ...GitGraphStashAction.members,
  ...GitGraphDiscardAction.members,
  GitGraphRecoveryRestoreAction,
  GitGraphPullRequestAction,
]);
export type GitGraphAction = typeof GitGraphAction.Type;
export type GitGraphActionType = GitGraphAction["type"];

export const GitGraphActInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: GitGraphAction,
  /** The conversation this was done from, for the audit trail. */
  threadId: Schema.optional(ThreadId),
});
export type GitGraphActInput = typeof GitGraphActInput.Type;

export const GitGraphActionResult = Schema.Struct({
  outcome: Schema.Literals(["done", "conflicts"]),
  /** Plain-language result to show. */
  message: Schema.String,
  /** The way back from this action, when it created one. */
  recovery: Schema.NullOr(GitGraphRecoveryPoint),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  conflicts: Schema.Array(Schema.String),
  /** The review this action created or found. */
  pullRequestUrl: Schema.NullOr(Schema.String),
});
export type GitGraphActionResult = typeof GitGraphActionResult.Type;

export const GitGraphPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  action: GitGraphAction,
});
export type GitGraphPreviewInput = typeof GitGraphPreviewInput.Type;

export const GitGraphPreviewCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: Schema.String,
});
export type GitGraphPreviewCommit = typeof GitGraphPreviewCommit.Type;

export const GitGraphPreview = Schema.Struct({
  /** Plain words: "Undo last commit, keep my changes". */
  title: Schema.String,
  summary: Schema.String,
  rewritesHistory: Schema.Boolean,
  discardsChanges: Schema.Boolean,
  commits: Schema.Array(GitGraphPreviewCommit),
  commitsTotal: NonNegativeInt,
  files: Schema.Array(Schema.String),
  filesTotal: NonNegativeInt,
  conflicts: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
  /** False when Git cannot do this from the current state; `warnings` says why. */
  canProceed: Schema.Boolean,
  /** Actions that must be repeated with an explicit acknowledgement. */
  requiresAcknowledgement: Schema.Boolean,
  /** How to get back, or null when nothing is at risk. */
  recoveryNote: Schema.NullOr(Schema.String),
});
export type GitGraphPreview = typeof GitGraphPreview.Type;

export const GitGraphBlameInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  path: Schema.String.check(Schema.isNonEmpty()),
  line: PositiveInt,
  /** A commit to blame at; the working tree when omitted. */
  revision: Schema.optional(GitRevision),
});
export type GitGraphBlameInput = typeof GitGraphBlameInput.Type;

export const GitGraphBlameResult = Schema.Struct({
  /** Null for a line that is not committed yet. */
  sha: Schema.NullOr(TrimmedNonEmptyString),
  subject: Schema.String,
  authorName: Schema.String,
  authoredAt: NonNegativeInt,
  conversation: Schema.NullOr(GitGraphConversationMark),
});
export type GitGraphBlameResult = typeof GitGraphBlameResult.Type;

export const GitGraphDraftMessageInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  threadId: Schema.optional(ThreadId),
});
export type GitGraphDraftMessageInput = typeof GitGraphDraftMessageInput.Type;

export const GitGraphDraftMessageResult = Schema.Struct({
  /** Null when nothing is staged. */
  message: Schema.NullOr(Schema.String),
});
export type GitGraphDraftMessageResult = typeof GitGraphDraftMessageResult.Type;

export const GitGraphErrorCode = Schema.Literals([
  /** This folder has no Git repository the view can read. */
  "unsupported",
  /** The view is read-only here, as in a jj repository. */
  "read_only",
  /** The request is understood and Git could do it, but a guard refused. */
  "refused",
  /** The target moved or was removed after it was shown. */
  "stale",
]);
export type GitGraphErrorCode = typeof GitGraphErrorCode.Type;

export class GitGraphError extends Schema.TaggedError<GitGraphError>()("GitGraphError", {
  code: GitGraphErrorCode,
  /** Written for the user; never Git's own output. */
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export const GitGraphServiceError = Schema.Union([GitGraphError, GitCommandError]);
export type GitGraphServiceError = typeof GitGraphServiceError.Type;
