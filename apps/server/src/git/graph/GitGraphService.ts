import {
  GIT_GRAPH_MAX_HUNKS,
  GIT_GRAPH_PAGE_MAX_ROWS,
  type GitGraphBlameInput,
  type GitGraphBlameResult,
  type GitGraphChanges,
  type GitGraphChangesInput,
  type GitGraphCommitDetail,
  type GitGraphCommitInput,
  type GitGraphConversationMark,
  GitGraphFilter,
  type GitGraphListInput,
  type GitGraphOperation,
  type GitGraphPage,
  type GitGraphRecoveryPoint,
  type GitGraphRow,
  type GitGraphServiceError,
  type GitGraphSummary,
  type GitGraphWorktree,
  GitCommandError,
  GitGraphError,
  ThreadId,
  RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as ConversationAttribution from "./ConversationAttribution.ts";
import {
  assessRisk,
  type FileHunk,
  LOG_FORMAT,
  type LogCommit,
  parseBranches,
  parseHunks,
  parseLog,
  parseNumstatLog,
  parseStashes,
  parseStatus,
  parseWorktrees,
  tipName,
} from "./gitOutput.ts";
import { layoutLanes, type LaneRow, type LaneState, stackAboveRow } from "./laneLayout.ts";
import {
  parseRecoveryRecords,
  RECOVERY_LIST_FORMAT,
  RECOVERY_REF_PREFIX,
  type RecoveryRecord,
} from "./recovery.ts";
import { ensureGitRepository, readOnlyReason, resolveCommit, sha256Hex } from "./repository.ts";

const DEFAULT_PAGE_ROWS = 100;
/** A sparse filter must not walk a huge history in one request; the cursor picks up from here. */
const POST_FILTER_CHUNK = 400;
const POST_FILTER_MAX_SCANNED = 4_000;
const CHECKPOINTS_PER_COMMIT = 20;
const CHECKPOINTS_PER_PAGE = 200;
const SUMMARY_MAX_BRANCHES = 300;
const SUMMARY_MAX_STASHES = 50;
const SUMMARY_MAX_RECOVERIES = 50;
const RISK_MAX_COMMITS = 50;
const MAX_CHANGED_FILES = 500;
const MAX_COMMIT_FILES = 500;
const LOG_TIMEOUT_MS = 60_000;
const LOG_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CARRIED_CLAIMS_MAX = 64;
const CONTAINING_CHECKPOINTS = 8;

const GraphCursor = Schema.Struct({
  revision: Schema.String,
  filterKey: Schema.String,
  skip: Schema.Number,
  lanes: Schema.Array(Schema.NullOr(Schema.Tuple([Schema.String, Schema.Number]))),
  carried: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      threadId: Schema.String,
      title: Schema.String,
      runId: Schema.NullOr(Schema.String),
      turn: Schema.NullOr(Schema.Number),
      startedAt: Schema.Number,
      endedAt: Schema.Number,
      boundary: Schema.NullOr(Schema.String),
    }),
  ),
});
type GraphCursor = typeof GraphCursor.Type;

const encodeFilterKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      filter: GitGraphFilter,
      showCheckpoints: Schema.Boolean,
      checkpointThreadId: Schema.optional(ThreadId),
      limit: Schema.Number,
    }),
  ),
);

const encodeCursorJson = Schema.encodeSync(Schema.fromJsonString(GraphCursor));
const decodeCursorJson = Schema.decodeUnknownResult(Schema.fromJsonString(GraphCursor));

const encodeCursor = (cursor: GraphCursor) => Base64Url.encode(encodeCursorJson(cursor));

function decodeCursor(cursor: string): GraphCursor | null {
  const bytes = Base64Url.decode(cursor);
  if (Result.isFailure(bytes)) return null;
  const decoded = decodeCursorJson(new TextDecoder().decode(bytes.success));
  return Result.isSuccess(decoded) ? decoded.success : null;
}

const laneStateFromCursor = (cursor: GraphCursor): LaneState =>
  cursor.lanes.map((lane) => (lane === null ? null : { sha: lane[0], color: lane[1] }));

const carriedFromCursor = (cursor: GraphCursor) =>
  new Map(
    cursor.carried.map((entry): [string, ConversationAttribution.TurnClaim] => [
      entry.sha,
      {
        mark: {
          threadId: ThreadId.make(entry.threadId),
          title: entry.title,
          runId: entry.runId === null ? null : RunId.make(entry.runId),
          turn: entry.turn,
        },
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        boundary: entry.boundary,
      },
    ]),
  );

const carriedToCursor = (carried: ReadonlyMap<string, ConversationAttribution.TurnClaim>) =>
  [...carried].slice(0, CARRIED_CLAIMS_MAX).map(([sha, claim]): GraphCursor["carried"][number] => ({
    sha,
    threadId: claim.mark.threadId,
    title: claim.mark.title,
    runId: claim.mark.runId,
    turn: claim.mark.turn,
    startedAt: claim.startedAt,
    endedAt: claim.endedAt,
    boundary: claim.boundary,
  }));

const isFiltered = (filter: GitGraphFilter) =>
  filter.author !== undefined ||
  filter.path !== undefined ||
  filter.message !== undefined ||
  filter.threadId !== undefined ||
  filter.agentOnly === true;

const matchesConversationFilter = (
  filter: GitGraphFilter,
  commit: LogCommit,
  mark: GitGraphConversationMark | null,
) =>
  (filter.threadId === undefined || mark?.threadId === filter.threadId) &&
  (filter.agentOnly !== true || mark !== null || commit.creditsAgent);

const commitRow = (
  commit: LogCommit,
  lanes: LaneRow,
  conversation: GitGraphConversationMark | null,
): GitGraphRow => ({
  ...lanes,
  kind: "commit",
  sha: commit.sha,
  parents: commit.parents,
  subject: commit.subject,
  authorName: commit.authorName,
  authoredAt: commit.authoredAt,
  refs: commit.refs,
  agentMade: conversation !== null || commit.creditsAgent,
  conversation,
  checkpointRef: null,
});

const FLAT_LANES: LaneRow = { lane: 0, color: 0, through: [], into: [], out: [] };

interface CheckpointTip {
  readonly ref: string;
  readonly sha: string;
  readonly parent: string;
}

export class GitGraphService extends Context.Service<
  GitGraphService,
  {
    readonly list: (input: GitGraphListInput) => Effect.Effect<GitGraphPage, GitGraphServiceError>;
    readonly commit: (
      input: GitGraphCommitInput,
    ) => Effect.Effect<GitGraphCommitDetail, GitGraphServiceError>;
    readonly changes: (
      input: GitGraphChangesInput,
    ) => Effect.Effect<GitGraphChanges, GitGraphServiceError>;
    readonly blame: (
      input: GitGraphBlameInput,
    ) => Effect.Effect<GitGraphBlameResult, GitGraphServiceError>;
    /** Merge, rebase, or cherry-pick in progress here, with its conflicts. */
    readonly operation: (
      cwd: string,
    ) => Effect.Effect<GitGraphOperation | null, GitGraphServiceError>;
    /** Newest first, with what restoring each needs. */
    readonly recoveries: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<RecoveryRecord>, GitCommandError>;
    /** Hunks of one file on one side, keyed by the same ids `changes` hands out. */
    readonly hunks: (
      cwd: string,
      path: string,
      staged: boolean,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly hunk: FileHunk }>,
      GitCommandError
    >;
  }
>()("t3pp/git/graph/GitGraphService") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const attribution = yield* ConversationAttribution.ConversationAttribution;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryContext = yield* Effect.context<
    | Crypto.Crypto
    | FileSystem.FileSystem
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | VcsDriverRegistry.VcsDriverRegistry
  >();
  const provideRepositoryContext = Effect.provideContext(repositoryContext);

  const stdout = (
    operation: string,
    cwd: string,
    args: ReadonlyArray<string>,
    timeoutMs = 15_000,
  ) =>
    git
      .execute({ operation, cwd, args, timeoutMs, maxOutputBytes: LOG_MAX_OUTPUT_BYTES })
      .pipe(Effect.map((result) => result.stdout));

  const optionalStdout = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation, cwd, args, allowNonZeroExit: true, timeoutMs: 15_000 })
      .pipe(Effect.map((result) => (result.exitCode === 0 ? result.stdout : "")));

  const readWorktrees = Effect.fn("GitGraphService.readWorktrees")(function* (
    cwd: string,
    rootPath: string,
  ) {
    const entries = parseWorktrees(
      yield* stdout("GitGraphService.readWorktrees", cwd, [
        "worktree",
        "list",
        "--porcelain",
        "-z",
      ]),
    );
    return entries.map((entry): GitGraphWorktree => ({
      ...entry,
      isCurrent: entry.path === rootPath,
    }));
  });

  const readCheckpointTips = Effect.fn("GitGraphService.readCheckpointTips")(function* (
    cwd: string,
  ) {
    const output = yield* stdout("GitGraphService.readCheckpointTips", cwd, [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(parent)",
      ConversationAttribution.CHECKPOINT_REF_PREFIX,
    ]);
    const parentOfRef = new Map<string, string>();
    const byParent = new Map<string, Array<CheckpointTip>>();
    for (const line of output.split("\n")) {
      const [ref, sha, parent] = line.split("\u0000");
      if (!ref || !sha || !parent) continue;
      parentOfRef.set(ref, parent);
      const tips = byParent.get(parent) ?? [];
      tips.push({ ref, sha, parent });
      byParent.set(parent, tips);
    }
    return { parentOfRef, byParent };
  });

  /** The earliest checkpoints holding a commit, for looking one commit up without a graph walk. */
  const conversationOfCommit = Effect.fn("GitGraphService.conversationOfCommit")(function* (
    cwd: string,
    sha: string,
    committedAt: number,
  ) {
    const refs = (yield* stdout("GitGraphService.conversationOfCommit", cwd, [
      "for-each-ref",
      `--contains=${sha}`,
      "--sort=committerdate",
      `--count=${CONTAINING_CHECKPOINTS}`,
      "--format=%(refname)",
      ConversationAttribution.CHECKPOINT_REF_PREFIX,
    ]))
      .split("\n")
      .filter((ref) => ref.length > 0);
    if (refs.length === 0) return null;
    const checkpoints = yield* attribution.readCheckpoints(refs);
    const turn = checkpoints
      .filter(
        (checkpoint) =>
          // The turn that made a commit is the first whose checkpoint holds it.
          checkpoint.previousRef !== null &&
          !refs.includes(checkpoint.previousRef) &&
          checkpoint.startedAt !== null &&
          committedAt >= checkpoint.startedAt - 2 &&
          committedAt <= checkpoint.capturedAt + 2,
      )
      .toSorted((a, b) => a.capturedAt - b.capturedAt)[0];
    return turn?.mark ?? null;
  });

  const revisionOf = Effect.fn("GitGraphService.revisionOf")(function* (
    cwd: string,
    worktrees: ReadonlyArray<GitGraphWorktree>,
  ) {
    const refs = yield* stdout("GitGraphService.revisionOf", cwd, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ]);
    const heads = worktrees.map((worktree) => worktree.sha ?? "").join("\n");
    return {
      revision: (yield* provideRepositoryContext(sha256Hex(`${heads}\n${refs}`))).slice(0, 16),
      hasRefs: refs.length > 0,
    };
  });

  const readLog = Effect.fn("GitGraphService.readLog")(function* (input: {
    readonly cwd: string;
    readonly tips: ReadonlyArray<string>;
    readonly filter: GitGraphFilter;
    readonly skip: number;
    readonly count: number;
  }) {
    const { filter } = input;
    const output = yield* stdout(
      "GitGraphService.readLog",
      input.cwd,
      [
        "-c",
        "log.showSignature=false",
        ...(filter.path === undefined ? [] : ["--literal-pathspecs"]),
        "log",
        "--topo-order",
        "--no-color",
        "--decorate=full",
        `--format=${LOG_FORMAT}`,
        `--skip=${input.skip}`,
        `--max-count=${input.count}`,
        ...(filter.author === undefined && filter.message === undefined
          ? []
          : ["--regexp-ignore-case", "--fixed-strings"]),
        ...(filter.author === undefined ? [] : [`--author=${filter.author}`]),
        ...(filter.message === undefined ? [] : [`--grep=${filter.message}`]),
        ...input.tips,
        "--",
        ...(filter.path === undefined ? [] : [filter.path]),
      ],
      LOG_TIMEOUT_MS,
    );
    return parseLog(output);
  });

  const readBatchCheckpoints = Effect.fn("GitGraphService.readBatchCheckpoints")(function* (
    commits: ReadonlyArray<LogCommit>,
    tips: Effect.Success<ReturnType<typeof readCheckpointTips>>,
  ) {
    const refs = commits.flatMap((commit) =>
      (tips.byParent.get(commit.sha) ?? []).map((tip) => tip.ref),
    );
    return refs.length === 0 ? [] : yield* attribution.readCheckpoints(refs);
  });

  const checkpointRows = (
    commit: LogCommit,
    lanes: LaneRow,
    checkpoints: ReadonlyArray<ConversationAttribution.CheckpointMeta>,
    tips: ReadonlyArray<CheckpointTip>,
    budget: { remaining: number },
  ): ReadonlyArray<GitGraphRow> => {
    const shaOfRef = new Map(tips.map((tip) => [tip.ref, tip.sha]));
    const shown = checkpoints
      .filter((checkpoint) => shaOfRef.has(checkpoint.ref))
      .toSorted((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, Math.min(CHECKPOINTS_PER_COMMIT, budget.remaining));
    budget.remaining -= shown.length;
    return stackAboveRow(lanes, shown.length)
      .slice(0, -1)
      .map((row, index): GitGraphRow => {
        const checkpoint = shown[index]!;
        return {
          ...row,
          kind: "checkpoint",
          sha: shaOfRef.get(checkpoint.ref)!,
          parents: [commit.sha],
          subject:
            checkpoint.mark.turn === null
              ? "Conversation start"
              : `Turn ${checkpoint.mark.turn} checkpoint`,
          authorName: "T3++",
          authoredAt: checkpoint.capturedAt,
          refs: [],
          agentMade: true,
          conversation: checkpoint.mark,
          checkpointRef: checkpoint.ref,
        };
      });
  };

  const readRisks = Effect.fn("GitGraphService.readRisks")(function* (cwd: string) {
    const output = yield* optionalStdout("GitGraphService.readRisks", cwd, [
      "log",
      `--max-count=${RISK_MAX_COMMITS}`,
      "--format=%x1e%H",
      "--numstat",
      "--no-renames",
      "HEAD",
      "--not",
      "--remotes",
    ]);
    return parseNumstatLog(output).flatMap(({ sha, files }) => {
      const risk = assessRisk(sha, files);
      return risk === null ? [] : [risk];
    });
  });

  const readRecoveries: GitGraphService["Service"]["recoveries"] = Effect.fn(
    "GitGraphService.readRecoveries",
  )(function* (cwd) {
    return parseRecoveryRecords(
      yield* stdout("GitGraphService.readRecoveries", cwd, [
        "for-each-ref",
        "--sort=-committerdate",
        RECOVERY_LIST_FORMAT,
        RECOVERY_REF_PREFIX,
      ]),
    );
  });

  const readOperation = Effect.fn("GitGraphService.readOperation")(function* (
    cwd: string,
    recoveries: ReadonlyArray<GitGraphRecoveryPoint>,
  ) {
    const gitDir = (yield* stdout("GitGraphService.readOperation", cwd, [
      "rev-parse",
      "--absolute-git-dir",
    ])).trim();
    const exists = (name: string) =>
      fileSystem.exists(path.join(gitDir, name)).pipe(Effect.orElseSucceed(() => false));
    const readText = (name: string) =>
      fileSystem.readFileString(path.join(gitDir, name)).pipe(
        Effect.map((text) => text.trim()),
        Effect.orElseSucceed(() => null),
      );
    const [merging, picking, rebasingMerge, rebasingApply] = yield* Effect.all(
      [
        exists("MERGE_HEAD"),
        exists("CHERRY_PICK_HEAD"),
        exists("rebase-merge"),
        exists("rebase-apply"),
      ],
      { concurrency: "unbounded" },
    );
    const kind =
      rebasingMerge || rebasingApply
        ? ("rebase" as const)
        : picking
          ? ("cherry-pick" as const)
          : merging
            ? ("merge" as const)
            : null;
    if (kind === null) return null;
    const incoming = yield* kind === "merge"
      ? readText("MERGE_MSG").pipe(Effect.map((text) => text?.split("\n")[0] ?? null))
      : kind === "cherry-pick"
        ? readText("CHERRY_PICK_HEAD")
        : readText(rebasingMerge ? "rebase-merge/onto" : "rebase-apply/onto");
    const unmerged = yield* stdout("GitGraphService.readOperation", cwd, [
      "diff",
      "--name-only",
      "--diff-filter=U",
      "-z",
    ]);
    return {
      kind,
      incoming,
      conflicts: unmerged.split("\u0000").filter((name) => name.length > 0),
      recoveryId: recoveries.find((recovery) => recovery.kind === kind)?.id ?? null,
    } satisfies GitGraphOperation;
  });

  const readSummary = Effect.fn("GitGraphService.readSummary")(function* (
    cwd: string,
    rootPath: string,
    worktrees: ReadonlyArray<GitGraphWorktree>,
  ) {
    const [branchOutput, stashOutput, recoveries, risks, statusOutput, reason] = yield* Effect.all(
      [
        stdout("GitGraphService.readBranches", cwd, [
          "for-each-ref",
          "--sort=-committerdate",
          `--count=${SUMMARY_MAX_BRANCHES}`,
          "--format=%(refname:short)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)",
          "refs/heads",
        ]),
        optionalStdout("GitGraphService.readStashes", cwd, [
          "stash",
          "list",
          `--max-count=${SUMMARY_MAX_STASHES}`,
          "--format=%H%x1f%gd%x1f%ct%x1f%gs%x1e",
        ]),
        readRecoveries(cwd),
        readRisks(cwd),
        stdout("GitGraphService.readStatus", cwd, ["status", "--porcelain=v1", "-z"]),
        provideRepositoryContext(readOnlyReason(rootPath)),
      ],
      { concurrency: "unbounded" },
    );
    const recoveryPoints = recoveries.map((record) => record.point);
    const operation = yield* readOperation(cwd, recoveryPoints);
    const branches = parseBranches(branchOutput);
    const current = branches.find((branch) => branch.isHead) ?? null;
    return {
      readOnlyReason: reason,
      headSha: worktrees.find((worktree) => worktree.isCurrent)?.sha ?? current?.sha ?? null,
      branch: current?.name ?? null,
      upstream: current?.upstream ?? null,
      ahead: current?.ahead ?? 0,
      behind: current?.behind ?? 0,
      branches,
      worktrees,
      operation,
      stashes: parseStashes(stashOutput),
      recoveries: recoveryPoints.slice(0, SUMMARY_MAX_RECOVERIES),
      risks,
      changedFiles: parseStatus(statusOutput).length,
    } satisfies GitGraphSummary;
  });

  const list: GitGraphService["Service"]["list"] = Effect.fn("GitGraphService.list")(
    function* (input) {
      const repository = yield* provideRepositoryContext(ensureGitRepository(input.cwd));
      const filter = input.filter ?? {};
      const flat = isFiltered(filter);
      const showCheckpoints = input.showCheckpoints === true && !flat;
      const limit = Math.min(input.limit ?? DEFAULT_PAGE_ROWS, GIT_GRAPH_PAGE_MAX_ROWS);
      const checkpointThread =
        input.checkpointThreadId === undefined
          ? {}
          : { checkpointThreadId: input.checkpointThreadId };
      const worktrees = yield* readWorktrees(input.cwd, repository.rootPath);
      const { revision, hasRefs } = yield* revisionOf(input.cwd, worktrees);
      const filterKey = (yield* provideRepositoryContext(
        sha256Hex(encodeFilterKey({ filter, showCheckpoints, ...checkpointThread, limit })),
      )).slice(0, 12);

      const decoded = input.cursor === undefined ? null : decodeCursor(input.cursor);
      const reset =
        input.cursor !== undefined &&
        (decoded === null || decoded.revision !== revision || decoded.filterKey !== filterKey);
      const cursor = reset ? null : decoded;
      const summary =
        cursor === null ? yield* readSummary(input.cwd, repository.rootPath, worktrees) : null;

      const heads = worktrees.flatMap((worktree) => (worktree.sha === null ? [] : [worktree.sha]));
      const tips = ["--branches", "--tags", "--remotes", ...new Set(heads)];
      if (!hasRefs && heads.length === 0) {
        return {
          revision,
          rows: [],
          nextCursor: null,
          reset,
          layout: flat ? "flat" : "graph",
          summary,
        } satisfies GitGraphPage;
      }

      const checkpointTips = yield* readCheckpointTips(input.cwd);
      const carried = cursor === null ? new Map() : carriedFromCursor(cursor);
      const postFiltered = filter.threadId !== undefined || filter.agentOnly === true;
      const chunk = postFiltered ? POST_FILTER_CHUNK : limit + 1;
      const startSkip = cursor?.skip ?? 0;

      const kept: Array<{
        readonly commit: LogCommit;
        readonly mark: GitGraphConversationMark | null;
        readonly checkpoints: ReadonlyArray<ConversationAttribution.CheckpointMeta>;
      }> = [];
      let consumed = 0;
      let exhausted = false;
      scanning: while (kept.length < limit && consumed < POST_FILTER_MAX_SCANNED) {
        const batch = yield* readLog({
          cwd: input.cwd,
          tips,
          filter,
          skip: startSkip + consumed,
          count: chunk,
        });
        const batchCheckpoints = yield* readBatchCheckpoints(batch, checkpointTips);
        const claims = ConversationAttribution.turnClaims(
          batchCheckpoints,
          checkpointTips.parentOfRef,
        );
        for (const commit of batch) {
          if (kept.length >= limit) break scanning;
          consumed += 1;
          const mark = ConversationAttribution.claimCommit(commit, claims, carried);
          if (!matchesConversationFilter(filter, commit, mark)) continue;
          const refsHere = new Set(
            (checkpointTips.byParent.get(commit.sha) ?? []).map((tip) => tip.ref),
          );
          kept.push({
            commit,
            mark,
            checkpoints: batchCheckpoints.filter(
              (checkpoint) =>
                refsHere.has(checkpoint.ref) &&
                (input.checkpointThreadId === undefined ||
                  checkpoint.mark.threadId === input.checkpointThreadId),
            ),
          });
        }
        if (batch.length < chunk) {
          exhausted = true;
          break;
        }
      }

      const laned = flat
        ? { rows: kept.map(() => FLAT_LANES), state: [] as LaneState }
        : layoutLanes(
            kept.map(({ commit }) => ({
              sha: commit.sha,
              parents: commit.parents,
              tipName: tipName(commit),
            })),
            cursor === null ? [] : laneStateFromCursor(cursor),
          );

      const budget = { remaining: CHECKPOINTS_PER_PAGE };
      const rows = kept.flatMap(
        ({ commit, mark, checkpoints }, index): ReadonlyArray<GitGraphRow> => {
          const lanes = laned.rows[index]!;
          if (!showCheckpoints || checkpoints.length === 0) {
            return [commitRow(commit, lanes, mark)];
          }
          const stacked = checkpointRows(
            commit,
            lanes,
            checkpoints,
            checkpointTips.byParent.get(commit.sha) ?? [],
            budget,
          );
          const below = stackAboveRow(lanes, stacked.length).at(-1)!;
          return [...stacked, commitRow(commit, below, mark)];
        },
      );

      const nextCursor = exhausted
        ? null
        : encodeCursor({
            revision,
            filterKey,
            skip: startSkip + consumed,
            lanes: laned.state.map((lane) => (lane === null ? null : [lane.sha, lane.color])),
            carried: carriedToCursor(carried),
          });
      return {
        revision,
        rows,
        nextCursor,
        reset,
        layout: flat ? "flat" : "graph",
        summary,
      } satisfies GitGraphPage;
    },
  );

  const commit: GitGraphService["Service"]["commit"] = Effect.fn("GitGraphService.commit")(
    function* (input) {
      yield* provideRepositoryContext(ensureGitRepository(input.cwd));
      const sha = yield* provideRepositoryContext(resolveCommit(input.cwd, input.sha));
      const fields = yield* stdout("GitGraphService.commit", input.cwd, [
        "show",
        "--no-patch",
        "--no-color",
        "--format=%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%B",
        sha,
      ]);
      const [parents, authorName, authorEmail, authoredAt, committedAt, ...message] =
        fields.split("\u001f");
      const parentList = (parents ?? "").split(" ").filter((parent) => parent.length > 0);
      const comparison = parentList[0] === undefined ? ["--root", sha] : [parentList[0], sha];
      const [statusOutput, numstatOutput] = yield* Effect.all(
        [
          stdout("GitGraphService.commitStatus", input.cwd, [
            "diff-tree",
            "-r",
            "--no-commit-id",
            "--no-renames",
            "--name-status",
            "-z",
            ...comparison,
          ]),
          stdout("GitGraphService.commitNumstat", input.cwd, [
            "diff-tree",
            "-r",
            "--no-commit-id",
            "--no-renames",
            "--numstat",
            "-z",
            ...comparison,
          ]),
        ],
        { concurrency: "unbounded" },
      );
      const statusFields = statusOutput.split("\u0000").filter((field) => field.length > 0);
      const statusByPath = new Map<string, string>();
      for (let index = 0; index + 1 < statusFields.length; index += 2) {
        statusByPath.set(statusFields[index + 1]!, statusFields[index]!);
      }
      const allFiles = numstatOutput.split("\u0000").flatMap((line) => {
        const [additions, deletions, filePath] = line.split("\t");
        if (additions === undefined || deletions === undefined || !filePath) return [];
        return [
          {
            path: filePath,
            status: statusByPath.get(filePath) ?? "M",
            additions: Number(additions) || 0,
            deletions: Number(deletions) || 0,
          },
        ];
      });
      return {
        sha,
        parents: parentList,
        message: message.join("\u001f").trim(),
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        authoredAt: Number(authoredAt),
        files: allFiles.slice(0, MAX_COMMIT_FILES),
        filesTruncated: allFiles.length > MAX_COMMIT_FILES,
        conversation: yield* conversationOfCommit(input.cwd, sha, Number(committedAt)),
        risk: assessRisk(sha, allFiles),
      } satisfies GitGraphCommitDetail;
    },
  );

  const hunks: GitGraphService["Service"]["hunks"] = Effect.fn("GitGraphService.hunks")(
    function* (cwd, filePath, staged) {
      const diff = yield* stdout("GitGraphService.hunks", cwd, [
        "--literal-pathspecs",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...(staged ? ["--cached"] : []),
        "--",
        filePath,
      ]);
      return yield* Effect.forEach(parseHunks(diff).hunks, (hunk) =>
        provideRepositoryContext(sha256Hex(`${staged}\n${filePath}\n${hunk.body.join("\n")}`)).pipe(
          Effect.map((digest) => ({ id: digest.slice(0, 16), hunk })),
        ),
      );
    },
  );

  const changes: GitGraphService["Service"]["changes"] = Effect.fn("GitGraphService.changes")(
    function* (input) {
      yield* provideRepositoryContext(ensureGitRepository(input.cwd));
      const status = parseStatus(
        yield* stdout("GitGraphService.changes", input.cwd, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
      );
      const fileHunks =
        input.path === undefined
          ? []
          : yield* Effect.forEach(
              [false, true],
              (staged) =>
                hunks(input.cwd, input.path!, staged).pipe(
                  Effect.map((entries) =>
                    entries.map(({ id, hunk }) => ({
                      id,
                      staged,
                      header: hunk.header,
                      lines: hunk.body,
                    })),
                  ),
                ),
              { concurrency: "unbounded" },
            ).pipe(Effect.map((sides) => sides.flat()));
      return {
        files: status.slice(0, MAX_CHANGED_FILES),
        filesTruncated: status.length > MAX_CHANGED_FILES,
        hunks: fileHunks,
        hunksTruncated: fileHunks.length >= GIT_GRAPH_MAX_HUNKS,
      } satisfies GitGraphChanges;
    },
  );

  const blame: GitGraphService["Service"]["blame"] = Effect.fn("GitGraphService.blame")(
    function* (input) {
      yield* provideRepositoryContext(ensureGitRepository(input.cwd));
      const revision =
        input.revision === undefined
          ? []
          : [yield* provideRepositoryContext(resolveCommit(input.cwd, input.revision))];
      const result = yield* git.execute({
        operation: "GitGraphService.blame",
        cwd: input.cwd,
        args: [
          "blame",
          "--porcelain",
          "-L",
          `${input.line},${input.line}`,
          ...revision,
          "--",
          input.path,
        ],
        allowNonZeroExit: true,
        timeoutMs: 15_000,
      });
      if (result.exitCode !== 0) {
        return yield* new GitGraphError({
          code: "stale",
          detail: "That line is not in the repository at this revision.",
        });
      }
      const lines = result.stdout.split("\n");
      const sha = lines[0]?.split(" ")[0] ?? "";
      const field = (name: string) =>
        lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1) ?? "";
      if (/^0+$/u.test(sha)) {
        return {
          sha: null,
          subject: "",
          authorName: "",
          authoredAt: 0,
          conversation: null,
        } satisfies GitGraphBlameResult;
      }
      return {
        sha,
        subject: field("summary"),
        authorName: field("author"),
        authoredAt: Number(field("author-time")),
        conversation: yield* conversationOfCommit(input.cwd, sha, Number(field("committer-time"))),
      } satisfies GitGraphBlameResult;
    },
  );

  const operation: GitGraphService["Service"]["operation"] = Effect.fn("GitGraphService.operation")(
    function* (cwd) {
      const recoveries = yield* readRecoveries(cwd);
      return yield* readOperation(
        cwd,
        recoveries.map((record) => record.point),
      );
    },
  );

  return GitGraphService.of({
    list,
    commit,
    changes,
    blame,
    operation,
    recoveries: readRecoveries,
    hunks,
  });
});

export const layer = Layer.effect(GitGraphService, make);
