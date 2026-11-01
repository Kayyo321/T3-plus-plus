import {
  type AuditActorKind,
  CheckpointRef,
  CommandId,
  GIT_GRAPH_PREVIEW_MAX_ITEMS,
  type GitGraphAction,
  type GitGraphActionResult,
  type GitGraphActInput,
  type GitGraphDraftMessageInput,
  type GitGraphDraftMessageResult,
  GitGraphError,
  type GitGraphOperation,
  type GitGraphPreview,
  type GitGraphPreviewCommit,
  type GitGraphPreviewInput,
  type GitGraphRecoveryKind,
  type GitGraphRecoveryPoint,
  type GitGraphRollbackMode,
  type GitGraphServiceError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as AuditTrail from "../../audit/AuditTrail.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../GitWorkflowService.ts";
import { linkCreatedPullRequest } from "../linkCreatedPullRequest.ts";
import { CHECKPOINT_REF_PREFIX } from "./ConversationAttribution.ts";
import { hunkPatch, isConflicted, parseStatus } from "./gitOutput.ts";
import * as GitGraphService from "./GitGraphService.ts";
import {
  encodeRecoveryMeta,
  RECOVERY_REF_PREFIX,
  RECOVERY_RETAINED,
  recoveryRef,
  type RecoveryRecord,
} from "./recovery.ts";
import { ensureGitRepository, readOnlyReason, resolveCommit } from "./repository.ts";

const SHORT_SHA = 7;
const LONG_RUN_MS = 5 * 60_000;
const DRAFT_PATCH_MAX_BYTES = 1024 * 1024;
const NON_INTERACTIVE_ENV = {
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
} as const;
const RECOVERY_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "T3++",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3++",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
} as const;

export interface GitActor {
  readonly actor: AuditActorKind;
  readonly actorLabel?: string;
  readonly threadId?: ThreadId;
}

const short = (sha: string) => sha.slice(0, SHORT_SHA);

const refused = (detail: string) => new GitGraphError({ code: "refused", detail });
const stale = (detail: string) => new GitGraphError({ code: "stale", detail });

function rollbackTitle(input: {
  readonly mode: GitGraphRollbackMode;
  readonly isLastCommit: boolean;
  readonly target: string;
}): string {
  const lead = input.isLastCommit ? "Undo last commit" : `Go back to ${short(input.target)}`;
  switch (input.mode) {
    case "soft":
      return `${lead}, keep my changes staged`;
    case "mixed":
      return `${lead}, keep my changes`;
    case "hard":
      return `${lead} and throw away the changes`;
  }
}

const OPERATION_NOUN: Record<GitGraphOperation["kind"], string> = {
  merge: "merge",
  rebase: "rebase",
  "cherry-pick": "cherry-pick",
};

const quietPreview = (title: string, summary: string): GitGraphPreview => ({
  title,
  summary,
  rewritesHistory: false,
  discardsChanges: false,
  commits: [],
  commitsTotal: 0,
  files: [],
  filesTotal: 0,
  conflicts: [],
  warnings: [],
  canProceed: true,
  requiresAcknowledgement: false,
  recoveryNote: null,
});

const RECOVERY_NOTE =
  "T3++ saves a recovery point first, including uncommitted changes, so you can come back to this exact state.";

export class GitActions extends Context.Service<
  GitActions,
  {
    /** Exactly what `act` would change, without changing it. */
    readonly preview: (
      input: GitGraphPreviewInput,
    ) => Effect.Effect<GitGraphPreview, GitGraphServiceError>;
    readonly act: (
      input: GitGraphActInput,
      actor: GitActor,
    ) => Effect.Effect<GitGraphActionResult, GitGraphServiceError>;
    readonly draftMessage: (
      input: GitGraphDraftMessageInput,
    ) => Effect.Effect<GitGraphDraftMessageResult, GitGraphServiceError>;
  }
>()("t3pp/git/graph/GitActions") {}

const make = Effect.gen(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const graph = yield* GitGraphService.GitGraphService;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const audit = yield* AuditTrail.AuditTrail;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectService.ProjectService;
  const statusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const repositoryContext = yield* Effect.context<
    | Crypto.Crypto
    | FileSystem.FileSystem
    | GitVcsDriver.GitVcsDriver
    | Path.Path
    | VcsDriverRegistry.VcsDriverRegistry
  >();
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const inRepository = Effect.provideContext(repositoryContext);

  const run = (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Partial<Pick<GitVcsDriver.ExecuteGitInput, "env" | "stdin" | "timeoutMs">>,
  ) => git.execute({ operation: "GitActions.run", cwd, args, timeoutMs: 60_000, ...options });

  const attempt = (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Partial<Pick<GitVcsDriver.ExecuteGitInput, "env" | "stdin" | "timeoutMs">>,
  ) =>
    run(cwd, args, { ...options }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const tryRun = (
    cwd: string,
    args: ReadonlyArray<string>,
    options?: Partial<Pick<GitVcsDriver.ExecuteGitInput, "env" | "timeoutMs">>,
  ) =>
    git.execute({
      operation: "GitActions.run",
      cwd,
      args,
      timeoutMs: LONG_RUN_MS,
      allowNonZeroExit: true,
      ...options,
    });

  const stdoutLines = (cwd: string, args: ReadonlyArray<string>) =>
    run(cwd, args).pipe(
      Effect.map((result) => result.stdout.split("\u0000").filter((line) => line.length > 0)),
    );

  const readHead = Effect.fn("GitActions.readHead")(function* (cwd: string) {
    const [head, branch] = yield* Effect.all(
      [
        tryRun(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
        tryRun(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    return {
      sha: head.exitCode === 0 ? head.stdout.trim() : null,
      branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    };
  });

  const requireHead = Effect.fn("GitActions.requireHead")(function* (cwd: string) {
    const head = yield* readHead(cwd);
    if (head.sha === null) {
      return yield* refused("This repository has no commits yet.");
    }
    return { sha: head.sha, branch: head.branch };
  });

  const assertNoOperation = Effect.fn("GitActions.assertNoOperation")(function* (cwd: string) {
    const operation = yield* graph.operation(cwd);
    if (operation !== null) {
      return yield* refused(
        `A ${OPERATION_NOUN[operation.kind]} is in progress. Finish or abort it first.`,
      );
    }
  });

  const readChanges = Effect.fn("GitActions.readChanges")(function* (cwd: string) {
    const status = yield* run(cwd, ["status", "--porcelain=v1", "-z"]);
    return parseStatus(status.stdout);
  });

  const commitsIn = Effect.fn("GitActions.commitsIn")(function* (
    cwd: string,
    revisions: ReadonlyArray<string>,
  ) {
    const [count, log] = yield* Effect.all(
      [
        run(cwd, ["rev-list", "--count", ...revisions]),
        run(cwd, [
          "log",
          `--max-count=${GIT_GRAPH_PREVIEW_MAX_ITEMS}`,
          "--format=%H%x1f%s",
          ...revisions,
          "--",
        ]),
      ],
      { concurrency: "unbounded" },
    );
    const commits = log.stdout.split("\n").flatMap((line): ReadonlyArray<GitGraphPreviewCommit> => {
      const [sha, subject] = line.split("\u001f");
      return sha ? [{ sha, subject: subject ?? "" }] : [];
    });
    return { commits, commitsTotal: Number(count.stdout.trim()) };
  });

  const filesBetween = Effect.fn("GitActions.filesBetween")(function* (
    cwd: string,
    from: string,
    to: string | null,
  ) {
    const files = yield* stdoutLines(cwd, [
      "diff",
      "--name-only",
      "-z",
      from,
      ...(to === null ? [] : [to]),
    ]);
    return { files: files.slice(0, GIT_GRAPH_PREVIEW_MAX_ITEMS), filesTotal: files.length };
  });

  const pushedCount = Effect.fn("GitActions.pushedCount")(function* (
    cwd: string,
    commitsTotal: number,
    revisions: ReadonlyArray<string>,
  ) {
    if (commitsTotal === 0) return 0;
    const unpushed = yield* run(cwd, ["rev-list", "--count", ...revisions, "--not", "--remotes"]);
    return commitsTotal - Number(unpushed.stdout.trim());
  });

  /** Merges in memory, so a preview never touches the worktree or index. Needs Git 2.38. */
  const simulateMerge = Effect.fn("GitActions.simulateMerge")(function* (
    cwd: string,
    ours: string,
    theirs: string,
    base?: string,
  ) {
    const result = yield* tryRun(cwd, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      ...(base === undefined ? [] : [`--merge-base=${base}`]),
      ours,
      theirs,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 1) return null;
    const [tree, ...conflicts] = result.stdout.split("\u0000").filter((line) => line.length > 0);
    return { tree: tree ?? null, conflicts: [...new Set(conflicts)] };
  });

  const newRecoveryId = Effect.fn("GitActions.newRecoveryId")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const suffix = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    return `${String(now).padStart(14, "0")}-${suffix.slice(0, 8)}`;
  });

  const pruneRecoveries = Effect.fn("GitActions.pruneRecoveries")(function* (cwd: string) {
    const refs = yield* run(cwd, [
      "for-each-ref",
      "--sort=-refname",
      "--format=%(refname)",
      RECOVERY_REF_PREFIX,
    ]);
    const expired = refs.stdout
      .split("\n")
      .filter((ref) => ref.length > 0)
      .slice(RECOVERY_RETAINED);
    yield* Effect.forEach(expired, (ref) => run(cwd, ["update-ref", "-d", ref]), {
      discard: true,
    });
  });

  const writeRecovery = Effect.fn("GitActions.writeRecovery")(function* (
    cwd: string,
    input: {
      readonly id: string;
      readonly kind: GitGraphRecoveryKind;
      readonly label: string;
      readonly sha: string;
      readonly branch: string | null;
      readonly snapshot: string | null;
      readonly stashMessage?: string;
    },
  ) {
    const tree = yield* run(cwd, ["rev-parse", `${input.sha}^{tree}`]);
    const metadata = encodeRecoveryMeta({
      kind: input.kind,
      label: input.label,
      branch: input.branch,
      ...(input.stashMessage === undefined ? {} : { stashMessage: input.stashMessage }),
    });
    const commit = yield* run(
      cwd,
      [
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        input.sha,
        ...(input.snapshot === null ? [] : ["-p", input.snapshot]),
        "-m",
        metadata,
      ],
      { env: RECOVERY_IDENTITY_ENV },
    );
    yield* run(cwd, ["update-ref", recoveryRef(input.id), commit.stdout.trim()]);
    yield* pruneRecoveries(cwd);
    const now = yield* Clock.currentTimeMillis;
    return {
      id: input.id,
      kind: input.kind,
      label: input.label,
      sha: input.sha,
      branch: input.branch,
      savedChanges: input.snapshot !== null,
      createdAt: Math.floor(now / 1000),
    } satisfies GitGraphRecoveryPoint;
  });

  /** Saves HEAD, its branch, and every file including untracked ones, before anything moves. */
  const saveState = Effect.fn("GitActions.saveState")(function* (
    cwd: string,
    kind: GitGraphRecoveryKind,
    label: string,
  ) {
    const head = yield* requireHead(cwd);
    const id = yield* newRecoveryId();
    const ref = recoveryRef(id);
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError(() => refused("Could not reach this repository to save a recovery point.")),
      );
    yield* handle.driver.checkpoints
      .captureCheckpoint({ cwd, checkpointRef: CheckpointRef.make(ref) })
      .pipe(Effect.mapError(() => refused("Could not save a recovery point, so nothing changed.")));
    const [snapshot, headTree, snapshotTree] = yield* Effect.all(
      [
        run(cwd, ["rev-parse", ref]),
        run(cwd, ["rev-parse", `${head.sha}^{tree}`]),
        run(cwd, ["rev-parse", `${ref}^{tree}`]),
      ],
      { concurrency: "unbounded" },
    );
    const changed = headTree.stdout.trim() !== snapshotTree.stdout.trim();
    return yield* writeRecovery(cwd, {
      id,
      kind,
      label,
      sha: head.sha,
      branch: head.branch,
      snapshot: changed ? snapshot.stdout.trim() : null,
    });
  });

  const dismissRecovery = (cwd: string, recovery: GitGraphRecoveryPoint) =>
    run(cwd, ["update-ref", "-d", recoveryRef(recovery.id)]).pipe(Effect.asVoid);

  const findRecovery = Effect.fn("GitActions.findRecovery")(function* (cwd: string, id: string) {
    const records = yield* graph.recoveries(cwd);
    const record = records.find((candidate) => candidate.point.id === id);
    if (record === undefined) {
      return yield* stale("That recovery point no longer exists.");
    }
    return record;
  });

  const result = Effect.fn("GitActions.result")(function* (
    cwd: string,
    message: string,
    recovery: GitGraphRecoveryPoint | null = null,
  ) {
    const head = yield* readHead(cwd);
    return {
      outcome: "done",
      message,
      recovery,
      headSha: head.sha,
      conflicts: [],
      pullRequestUrl: null,
    } satisfies GitGraphActionResult;
  });

  /** A stopped merge, rebase, or pick is a state to resolve, unless Git stopped before starting. */
  const settleStoppedOperation = Effect.fn("GitActions.settleStoppedOperation")(function* (
    cwd: string,
    recovery: GitGraphRecoveryPoint | null,
    failure: string,
  ) {
    const changes = yield* readChanges(cwd);
    const conflicts = changes.filter(isConflicted).map((file) => file.path);
    if (conflicts.length === 0) {
      if (recovery !== null) yield* dismissRecovery(cwd, recovery);
      return yield* refused(failure);
    }
    const head = yield* readHead(cwd);
    return {
      outcome: "conflicts",
      message: `${conflicts.length === 1 ? "1 file needs" : `${conflicts.length} files need`} your attention before this can finish.`,
      recovery,
      headSha: head.sha,
      conflicts,
      pullRequestUrl: null,
    } satisfies GitGraphActionResult;
  });

  const assertBranchName = Effect.fn("GitActions.assertBranchName")(function* (
    cwd: string,
    name: string,
  ) {
    const check = yield* tryRun(cwd, ["check-ref-format", "--branch", name]);
    if (check.exitCode !== 0) return yield* refused(`"${name}" is not a valid branch name.`);
  });

  const uniqueBranchCommits = (name: string) => [
    `refs/heads/${name}`,
    "--not",
    `--exclude=${name}`,
    "--branches",
    "--remotes",
    "--tags",
  ];

  const requireBranch = Effect.fn("GitActions.requireBranch")(function* (
    cwd: string,
    name: string,
  ) {
    const tip = yield* tryRun(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (tip.exitCode !== 0) return yield* stale(`Branch "${name}" no longer exists.`);
    return tip.stdout.trim();
  });

  const checkedOutIn = Effect.fn("GitActions.checkedOutIn")(function* (cwd: string, name: string) {
    const worktrees = yield* run(cwd, ["worktree", "list", "--porcelain", "-z"]);
    return worktrees.stdout.split("\u0000").includes(`branch refs/heads/${name}`);
  });

  const previewRollback = Effect.fn("GitActions.previewRollback")(function* (
    cwd: string,
    revision: string,
    mode: GitGraphRollbackMode,
  ) {
    const head = yield* requireHead(cwd);
    const target = yield* inRepository(resolveCommit(cwd, revision));
    const range = [`${target}..${head.sha}`];
    const [{ commits, commitsTotal }, files, changes, parent] = yield* Effect.all(
      [
        commitsIn(cwd, range),
        filesBetween(cwd, target, null),
        readChanges(cwd),
        tryRun(cwd, ["rev-parse", "--verify", "--quiet", `${head.sha}^{commit}^1`]),
      ],
      { concurrency: "unbounded" },
    );
    const pushed = yield* pushedCount(cwd, commitsTotal, range);
    const tracked = changes.filter((file) => file.staged !== "?");
    const discardsChanges = mode === "hard" && (files.filesTotal > 0 || tracked.length > 0);
    const warnings = [
      ...(pushed > 0
        ? [
            `${pushed === 1 ? "1 of these commits is" : `${pushed} of these commits are`} already pushed. The remote keeps ${pushed === 1 ? "it" : "them"} until you force-push from a terminal.`,
          ]
        : []),
      ...(discardsChanges && tracked.length > 0
        ? [
            `${tracked.length === 1 ? "1 uncommitted file" : `${tracked.length} uncommitted files`} will be overwritten. Untracked files stay.`,
          ]
        : []),
    ];
    return {
      ...quietPreview(
        rollbackTitle({
          mode,
          isLastCommit: parent.exitCode === 0 && parent.stdout.trim() === target,
          target,
        }),
        commitsTotal === 0
          ? "Your branch stays where it is."
          : mode === "soft"
            ? `${commitsTotal === 1 ? "This commit leaves" : `These ${commitsTotal} commits leave`} your branch. ${commitsTotal === 1 ? "Its changes stay" : "Their changes stay"} staged.`
            : mode === "mixed"
              ? `${commitsTotal === 1 ? "This commit leaves" : `These ${commitsTotal} commits leave`} your branch. ${commitsTotal === 1 ? "Its changes stay" : "Their changes stay"} in your files, unstaged.`
              : `${commitsTotal === 1 ? "This commit leaves" : `These ${commitsTotal} commits leave`} your branch and your files match ${short(target)}.`,
      ),
      rewritesHistory: commitsTotal > 0,
      discardsChanges,
      commits,
      commitsTotal,
      ...(mode === "hard" ? files : {}),
      warnings,
      recoveryNote: RECOVERY_NOTE,
    } satisfies GitGraphPreview;
  });

  const previewMerge = Effect.fn("GitActions.previewMerge")(function* (cwd: string, ref: string) {
    const head = yield* requireHead(cwd);
    const theirs = yield* inRepository(resolveCommit(cwd, ref));
    const title = `Merge ${ref} into ${head.branch ?? short(head.sha)}`;
    const { commits, commitsTotal } = yield* commitsIn(cwd, [`${head.sha}..${theirs}`]);
    if (commitsTotal === 0) {
      return {
        ...quietPreview(title, `${head.branch ?? "This commit"} already has everything in ${ref}.`),
        canProceed: false,
      } satisfies GitGraphPreview;
    }
    const fastForward = yield* tryRun(cwd, ["merge-base", "--is-ancestor", head.sha, theirs]);
    const simulated = yield* simulateMerge(cwd, head.sha, theirs);
    const changes = yield* readChanges(cwd);
    const files =
      simulated?.tree != null
        ? yield* filesBetween(cwd, head.sha, simulated.tree)
        : { files: [], filesTotal: 0 };
    return {
      ...quietPreview(
        title,
        fastForward.exitCode === 0
          ? `${head.branch ?? "This commit"} moves forward to ${ref}. No merge commit is needed.`
          : (simulated?.conflicts.length ?? 0) > 0
            ? "This merge will stop on conflicts. You can resolve them, ask an agent, or abort."
            : "This merge will finish cleanly.",
      ),
      commits,
      commitsTotal,
      ...files,
      conflicts: simulated?.conflicts ?? [],
      warnings: [
        ...(simulated === null
          ? ["This version of Git cannot predict conflicts. Update to 2.38 or newer to see them."]
          : []),
        ...(changes.length > 0
          ? ["You have uncommitted changes. Git stops if the merge would touch them."]
          : []),
      ],
      recoveryNote: RECOVERY_NOTE,
    } satisfies GitGraphPreview;
  });

  const previewRebase = Effect.fn("GitActions.previewRebase")(function* (
    cwd: string,
    onto: string,
  ) {
    const head = yield* requireHead(cwd);
    const target = yield* inRepository(resolveCommit(cwd, onto));
    const range = [`${target}..${head.sha}`];
    const { commits, commitsTotal } = yield* commitsIn(cwd, range);
    const simulated = yield* simulateMerge(cwd, head.sha, target);
    const pushed = yield* pushedCount(cwd, commitsTotal, range);
    const changes = yield* readChanges(cwd);
    const dirty = changes.filter((file) => file.staged !== "?").length > 0;
    return {
      ...quietPreview(
        `Rebase ${head.branch ?? short(head.sha)} onto ${onto}`,
        commitsTotal === 0
          ? `${head.branch ?? "This commit"} moves forward to ${onto}.`
          : `This rewrites history: ${commitsTotal === 1 ? "this commit is" : `these ${commitsTotal} commits are`} replayed on top of ${onto} and ${commitsTotal === 1 ? "gets a new id" : "get new ids"}.`,
      ),
      rewritesHistory: commitsTotal > 0,
      commits,
      commitsTotal,
      conflicts: simulated?.conflicts ?? [],
      canProceed: !dirty,
      warnings: [
        ...(dirty ? ["Commit or stash your uncommitted changes first."] : []),
        ...(pushed > 0
          ? [
              `${pushed === 1 ? "1 of these commits is" : `${pushed} of these commits are`} already pushed. After rebasing, the branch needs a force-push from a terminal.`,
            ]
          : []),
        ...((simulated?.conflicts.length ?? 0) > 0
          ? ["Conflicts are likely. They are checked against the whole branch, not each commit."]
          : []),
      ],
      recoveryNote: RECOVERY_NOTE,
    } satisfies GitGraphPreview;
  });

  const previewCherryPick = Effect.fn("GitActions.previewCherryPick")(function* (
    cwd: string,
    revision: string,
  ) {
    const head = yield* requireHead(cwd);
    const sha = yield* inRepository(resolveCommit(cwd, revision));
    const parent = yield* tryRun(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^1`]);
    const simulated =
      parent.exitCode === 0 ? yield* simulateMerge(cwd, head.sha, sha, parent.stdout.trim()) : null;
    const { commits } = yield* commitsIn(cwd, ["--no-walk", sha]);
    const merge = yield* tryRun(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^2`]);
    return {
      ...quietPreview(
        `Copy ${short(sha)} onto ${head.branch ?? short(head.sha)}`,
        "This rewrites history: the commit is copied onto your branch as a new commit with a new id.",
      ),
      rewritesHistory: true,
      commits,
      commitsTotal: 1,
      conflicts: simulated?.conflicts ?? [],
      canProceed: merge.exitCode !== 0,
      warnings: merge.exitCode === 0 ? ["A merge commit cannot be copied this way."] : [],
      recoveryNote: RECOVERY_NOTE,
    } satisfies GitGraphPreview;
  });

  const previewBranchDelete = Effect.fn("GitActions.previewBranchDelete")(function* (
    cwd: string,
    name: string,
  ) {
    yield* requireBranch(cwd, name);
    const { commits, commitsTotal } = yield* commitsIn(cwd, uniqueBranchCommits(name));
    const checkedOut = yield* checkedOutIn(cwd, name);
    return {
      ...quietPreview(
        `Delete branch ${name}`,
        commitsTotal === 0
          ? "Everything on this branch also lives on another branch, a tag, or a remote."
          : `${commitsTotal === 1 ? "1 commit lives" : `${commitsTotal} commits live`} only on this branch.`,
      ),
      commits,
      commitsTotal,
      canProceed: !checkedOut,
      requiresAcknowledgement: commitsTotal > 0,
      discardsChanges: commitsTotal > 0,
      warnings: [
        ...(checkedOut ? ["This branch is checked out. Switch away from it first."] : []),
        ...(commitsTotal > 0 ? ["Unmerged work: nothing else points at these commits."] : []),
      ],
      recoveryNote: "T3++ keeps a recovery point, so you can bring the branch back.",
    } satisfies GitGraphPreview;
  });

  const previewCheckpointRollback = Effect.fn("GitActions.previewCheckpointRollback")(function* (
    cwd: string,
    checkpointRef: string,
  ) {
    const head = yield* requireHead(cwd);
    const { sha, parent } = yield* resolveCheckpoint(cwd, checkpointRef);
    const range = [`${parent}..${head.sha}`];
    const [{ commits, commitsTotal }, files] = yield* Effect.all(
      [commitsIn(cwd, range), filesBetween(cwd, sha, null)],
      { concurrency: "unbounded" },
    );
    return {
      ...quietPreview(
        "Put my files back to this checkpoint",
        "Your files return to how this turn left them. The conversation stays as it is.",
      ),
      rewritesHistory: commitsTotal > 0,
      discardsChanges: true,
      commits,
      commitsTotal,
      ...files,
      warnings: ["Files added since this checkpoint are removed from the folder."],
      recoveryNote: RECOVERY_NOTE,
    } satisfies GitGraphPreview;
  });

  const previewRestore = Effect.fn("GitActions.previewRestore")(function* (
    cwd: string,
    id: string,
  ) {
    const record = yield* findRecovery(cwd, id);
    const { kind, sha, label } = record.point;
    if (kind === "branch-delete" || kind === "stash-drop") {
      return quietPreview(
        kind === "branch-delete" ? `Bring back branch ${record.point.branch}` : "Bring back stash",
        label,
      );
    }
    const head = yield* requireHead(cwd);
    const range = [`${sha}..${head.sha}`];
    const [{ commits, commitsTotal }, files] = yield* Effect.all(
      [commitsIn(cwd, range), filesBetween(cwd, sha, null)],
      { concurrency: "unbounded" },
    );
    return {
      ...quietPreview(
        `Go back: ${label}`,
        `${record.point.branch ?? "HEAD"} returns to ${short(sha)}, the state saved at that point.`,
      ),
      rewritesHistory: commitsTotal > 0,
      discardsChanges: files.filesTotal > 0,
      commits,
      commitsTotal,
      ...files,
      recoveryNote: "The current state is saved first, so this can be undone too.",
    } satisfies GitGraphPreview;
  });

  const resolveCheckpoint = Effect.fn("GitActions.resolveCheckpoint")(function* (
    cwd: string,
    checkpointRef: string,
  ) {
    if (!checkpointRef.startsWith(`${CHECKPOINT_REF_PREFIX}/`)) {
      return yield* refused("That is not a checkpoint.");
    }
    const resolved = yield* tryRun(cwd, [
      "rev-parse",
      `${checkpointRef}^{commit}`,
      `${checkpointRef}^1`,
    ]);
    const [sha, parent] = resolved.stdout.split("\n");
    if (resolved.exitCode !== 0 || !sha || !parent) {
      return yield* stale("That checkpoint no longer exists.");
    }
    return { sha, parent };
  });

  const preview: GitActions["Service"]["preview"] = Effect.fn("GitActions.preview")(
    function* (input) {
      const { cwd, action } = input;
      yield* inRepository(ensureGitRepository(cwd));
      switch (action.type) {
        case "rollback":
          return yield* previewRollback(cwd, action.target, action.mode);
        case "rollbackToCheckpoint":
          return yield* previewCheckpointRollback(cwd, action.checkpointRef);
        case "merge":
          return yield* previewMerge(cwd, action.ref);
        case "rebase":
          return yield* previewRebase(cwd, action.onto);
        case "cherryPick":
          return yield* previewCherryPick(cwd, action.sha);
        case "branchDelete":
          return yield* previewBranchDelete(cwd, action.name);
        case "recoveryRestore":
          return yield* previewRestore(cwd, action.id);
        case "stashDrop":
          return {
            ...quietPreview("Drop this stash", "The stash leaves your list."),
            discardsChanges: true,
            recoveryNote: "T3++ keeps a recovery point, so you can bring the stash back.",
          } satisfies GitGraphPreview;
        case "operationAbort":
          return {
            ...quietPreview(
              "Abort and go back",
              "Git stops and puts your branch and files back to how they were before this began.",
            ),
            discardsChanges: true,
          } satisfies GitGraphPreview;
        default:
          return quietPreview(action.type, "This does not rewrite history or discard work.");
      }
    },
  );

  const applyHunk = Effect.fn("GitActions.applyHunk")(function* (
    cwd: string,
    path: string,
    hunkId: string,
    staged: boolean,
  ) {
    const hunks = yield* graph.hunks(cwd, path, staged);
    const match = hunks.find((entry) => entry.id === hunkId);
    if (match === undefined) {
      return yield* stale("That change moved. Refresh and pick it again.");
    }
    const applied = yield* attempt(
      cwd,
      ["apply", "--cached", "--whitespace=nowarn", ...(staged ? ["--reverse"] : []), "-"],
      { stdin: hunkPatch(match.hunk) },
    );
    if (!applied) return yield* refused("Git could not apply this change on its own.");
  });

  const rollback = Effect.fn("GitActions.rollback")(function* (
    cwd: string,
    action: Extract<GitGraphAction, { type: "rollback" }>,
  ) {
    yield* assertNoOperation(cwd);
    const { title } = yield* previewRollback(cwd, action.target, action.mode);
    const target = yield* inRepository(resolveCommit(cwd, action.target));
    const recovery = yield* saveState(cwd, "rollback", `Before: ${title}`);
    yield* run(cwd, ["reset", `--${action.mode}`, target], { timeoutMs: LONG_RUN_MS });
    return yield* result(cwd, `${title}. You can go back from Recovery.`, recovery);
  });

  const rollbackToCheckpoint = Effect.fn("GitActions.rollbackToCheckpoint")(function* (
    cwd: string,
    checkpointRef: string,
  ) {
    yield* assertNoOperation(cwd);
    const { parent } = yield* resolveCheckpoint(cwd, checkpointRef);
    const recovery = yield* saveState(cwd, "rollback", "Before putting files back to a checkpoint");
    yield* run(cwd, ["reset", "--quiet", "--mixed", parent], { timeoutMs: LONG_RUN_MS });
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError(() =>
          refused("Could not reach this repository to restore the checkpoint."),
        ),
      );
    const restored = yield* handle.driver.checkpoints
      .restoreCheckpoint({ cwd, checkpointRef: CheckpointRef.make(checkpointRef) })
      .pipe(Effect.mapError(() => refused("Git could not restore this checkpoint.")));
    if (!restored) return yield* stale("That checkpoint no longer exists.");
    return yield* result(cwd, "Files are back to this checkpoint.", recovery);
  });

  const merge = Effect.fn("GitActions.merge")(function* (cwd: string, ref: string) {
    yield* assertNoOperation(cwd);
    const theirs = yield* inRepository(resolveCommit(cwd, ref));
    const recovery = yield* saveState(cwd, "merge", `Before merging ${ref}`);
    const merged = yield* tryRun(cwd, ["merge", "--no-edit", "-m", `Merge ${ref}`, theirs], {
      env: NON_INTERACTIVE_ENV,
    });
    if (merged.exitCode === 0) return yield* result(cwd, `Merged ${ref}.`, recovery);
    return yield* settleStoppedOperation(
      cwd,
      recovery,
      "Git stopped before merging. Uncommitted changes may overlap with it.",
    );
  });

  const rebase = Effect.fn("GitActions.rebase")(function* (cwd: string, onto: string) {
    yield* assertNoOperation(cwd);
    const target = yield* inRepository(resolveCommit(cwd, onto));
    const recovery = yield* saveState(cwd, "rebase", `Before rebasing onto ${onto}`);
    const rebased = yield* tryRun(cwd, ["rebase", target], { env: NON_INTERACTIVE_ENV });
    if (rebased.exitCode === 0) return yield* result(cwd, `Rebased onto ${onto}.`, recovery);
    return yield* settleStoppedOperation(
      cwd,
      recovery,
      "Git stopped before rebasing. Commit or stash your changes first.",
    );
  });

  const cherryPick = Effect.fn("GitActions.cherryPick")(function* (cwd: string, revision: string) {
    yield* assertNoOperation(cwd);
    const sha = yield* inRepository(resolveCommit(cwd, revision));
    const recovery = yield* saveState(cwd, "cherry-pick", `Before copying ${short(sha)}`);
    const picked = yield* tryRun(cwd, ["cherry-pick", sha], { env: NON_INTERACTIVE_ENV });
    if (picked.exitCode === 0) {
      return yield* result(cwd, `Copied ${short(sha)} onto your branch.`, recovery);
    }
    return yield* settleStoppedOperation(
      cwd,
      recovery,
      "Git could not copy this commit. It may already be on your branch.",
    );
  });

  const continueOperation = Effect.fn("GitActions.continueOperation")(function* (cwd: string) {
    const operation = yield* graph.operation(cwd);
    if (operation === null) return yield* stale("Nothing is in progress.");
    if (operation.conflicts.length > 0) {
      return yield* refused(
        `${operation.conflicts.length === 1 ? "1 file still has" : `${operation.conflicts.length} files still have`} conflicts. Resolve and stage them first.`,
      );
    }
    const args =
      operation.kind === "merge" ? ["commit", "--no-edit"] : [operation.kind, "--continue"];
    const continued = yield* tryRun(cwd, args, { env: NON_INTERACTIVE_ENV });
    if (continued.exitCode === 0) {
      return yield* result(cwd, `Finished the ${OPERATION_NOUN[operation.kind]}.`);
    }
    return yield* settleStoppedOperation(
      cwd,
      null,
      "Git could not continue. If nothing is left to apply, abort instead.",
    );
  });

  const abortOperation = Effect.fn("GitActions.abortOperation")(function* (cwd: string) {
    const operation = yield* graph.operation(cwd);
    if (operation === null) return yield* stale("Nothing is in progress.");
    yield* run(cwd, [operation.kind, "--abort"]);
    return yield* result(cwd, `Aborted the ${OPERATION_NOUN[operation.kind]}.`);
  });

  const deleteBranch = Effect.fn("GitActions.deleteBranch")(function* (
    cwd: string,
    action: Extract<GitGraphAction, { type: "branchDelete" }>,
  ) {
    const tip = yield* requireBranch(cwd, action.name);
    if (yield* checkedOutIn(cwd, action.name)) {
      return yield* refused("This branch is checked out. Switch away from it first.");
    }
    const { commitsTotal } = yield* commitsIn(cwd, uniqueBranchCommits(action.name));
    if (commitsTotal > 0 && action.acknowledgeUnmerged !== true) {
      return yield* refused(
        `${commitsTotal === 1 ? "1 commit lives" : `${commitsTotal} commits live`} only on ${action.name}. Confirm to delete it anyway.`,
      );
    }
    const recovery = yield* writeRecovery(cwd, {
      id: yield* newRecoveryId(),
      kind: "branch-delete",
      label: `Deleted branch ${action.name}`,
      sha: tip,
      branch: action.name,
      snapshot: null,
    });
    yield* git.deleteLocalBranch({ cwd, refName: action.name, force: true });
    return yield* result(cwd, `Deleted ${action.name}.`, recovery);
  });

  const applyStash = Effect.fn("GitActions.applyStash")(function* (cwd: string, sha: string) {
    const stash = yield* inRepository(resolveCommit(cwd, sha));
    const withIndex = yield* tryRun(cwd, ["stash", "apply", "--index", stash]);
    if (withIndex.exitCode === 0) return yield* result(cwd, "Applied the stash. It stays listed.");
    const conflicted = (yield* readChanges(cwd)).filter(isConflicted).length > 0;
    if (conflicted) {
      return yield* settleStoppedOperation(cwd, null, "Git could not apply this stash.");
    }
    const plain = yield* tryRun(cwd, ["stash", "apply", stash]);
    if (plain.exitCode === 0) return yield* result(cwd, "Applied the stash. It stays listed.");
    return yield* settleStoppedOperation(
      cwd,
      null,
      "Git could not apply this stash over your current changes.",
    );
  });

  const dropStash = Effect.fn("GitActions.dropStash")(function* (cwd: string, sha: string) {
    const listed = yield* run(cwd, ["stash", "list", "--format=%H%x1f%gd%x1f%gs"]);
    const entry = listed.stdout
      .split("\n")
      .map((line) => line.split("\u001f"))
      .find(([candidate]) => candidate === sha);
    if (entry === undefined) return yield* stale("That stash is already gone.");
    const [, reflogRef, message] = entry;
    const recovery = yield* writeRecovery(cwd, {
      id: yield* newRecoveryId(),
      kind: "stash-drop",
      label: `Dropped stash: ${message ?? ""}`,
      sha,
      branch: null,
      snapshot: null,
      stashMessage: message ?? "",
    });
    yield* run(cwd, ["stash", "drop", reflogRef!]);
    return yield* result(cwd, "Dropped the stash.", recovery);
  });

  const restoreHeadRecovery = Effect.fn("GitActions.restoreHeadRecovery")(function* (
    cwd: string,
    record: RecoveryRecord,
  ) {
    yield* assertNoOperation(cwd);
    const { sha, branch, label } = record.point;
    const recovery = yield* saveState(cwd, "restore", `Before going back: ${label}`);
    yield* run(
      cwd,
      ["checkout", "--quiet", "--force", ...(branch === null ? ["--detach"] : ["-B", branch]), sha],
      { timeoutMs: LONG_RUN_MS },
    );
    if (record.snapshot !== null) {
      const handle = yield* registry
        .resolve({ cwd })
        .pipe(
          Effect.mapError(() => refused("Could not reach this repository to restore your files.")),
        );
      yield* handle.driver.checkpoints
        .restoreCheckpoint({ cwd, checkpointRef: CheckpointRef.make(record.snapshot) })
        .pipe(Effect.mapError(() => refused("Git could not restore your saved files.")));
    }
    return yield* result(cwd, `Went back to ${short(sha)}. This can be undone too.`, recovery);
  });

  const restoreRecovery = Effect.fn("GitActions.restoreRecovery")(function* (
    cwd: string,
    id: string,
  ) {
    const record = yield* findRecovery(cwd, id);
    const { kind, sha, branch } = record.point;
    if (kind === "branch-delete") {
      const created = yield* attempt(cwd, ["branch", "--", branch!, sha]);
      if (!created) return yield* refused(`Branch "${branch}" already exists.`);
      return yield* result(cwd, `Branch ${branch} is back.`);
    }
    if (kind === "stash-drop") {
      yield* run(cwd, ["stash", "store", "-m", record.meta.stashMessage ?? "Restored stash", sha]);
      return yield* result(cwd, "The stash is back.");
    }
    return yield* restoreHeadRecovery(cwd, record);
  });

  /** The existing PR flow, so branch rules, drafting, and host support stay in one place. */
  const createPullRequest = Effect.fn("GitActions.createPullRequest")(function* (
    cwd: string,
    threadId: ThreadId | undefined,
  ) {
    const actionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const created = yield* workflow
      .runStackedAction({
        actionId,
        cwd,
        action: "create_pr",
        ...(threadId === undefined ? {} : { threadId }),
      })
      .pipe(
        Effect.mapError(() =>
          refused("Could not open a pull request. Check the branch and your host's sign-in."),
        ),
      );
    if (threadId !== undefined) {
      yield* linkCreatedPullRequest({
        threadId,
        result: created,
        commandId: crypto.randomUUIDv4().pipe(
          Effect.orDie,
          Effect.map((id) => CommandId.make(`server:pr-created-link:${id}`)),
        ),
      }).pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
        Effect.provideService(ProjectService.ProjectService, projects),
      );
    }
    return {
      ...(yield* result(
        cwd,
        created.pr.status === "created"
          ? `Opened pull request #${created.pr.number}.`
          : `Pull request #${created.pr.number} already exists.`,
      )),
      pullRequestUrl: created.pr.url ?? null,
    } satisfies GitGraphActionResult;
  });

  const perform = Effect.fn("GitActions.perform")(function* (
    cwd: string,
    action: GitGraphAction,
    threadId: ThreadId | undefined,
  ): Effect.fn.Return<GitGraphActionResult, GitGraphServiceError> {
    switch (action.type) {
      case "stage":
        yield* run(cwd, ["--literal-pathspecs", "add", "-A", "--", ...action.paths]);
        return yield* result(cwd, "Staged.");
      case "unstage":
        yield* run(cwd, ["--literal-pathspecs", "reset", "--quiet", "--", ...action.paths]);
        return yield* result(cwd, "Unstaged.");
      case "stageHunk":
        yield* applyHunk(cwd, action.path, action.hunkId, false);
        return yield* result(cwd, "Staged.");
      case "unstageHunk":
        yield* applyHunk(cwd, action.path, action.hunkId, true);
        return yield* result(cwd, "Unstaged.");
      case "commit": {
        const [subject, ...body] = action.message.split("\n");
        const { commitSha } = yield* git.commit(cwd, subject!.trim(), body.join("\n"));
        return yield* result(cwd, `Committed ${short(commitSha)}.`);
      }
      case "branchCreate": {
        yield* assertBranchName(cwd, action.name);
        const startPoint = yield* inRepository(resolveCommit(cwd, action.startPoint));
        yield* git.createBranch({ cwd, branch: action.name, startPoint });
        if (action.checkout === true) {
          yield* workflow
            .switchRef({ cwd, refName: action.name })
            .pipe(
              Effect.mapError(() =>
                refused(
                  "Branch created, but Git could not check it out. Your changes may overlap.",
                ),
              ),
            );
        }
        return yield* result(cwd, `Created ${action.name}.`);
      }
      case "branchCheckout":
        yield* workflow.switchRef({ cwd, refName: action.name });
        return yield* result(cwd, `Checked out ${action.name}.`);
      case "branchRename":
        yield* assertBranchName(cwd, action.to);
        yield* git.renameBranch({
          cwd,
          oldBranch: action.from,
          newBranch: action.to,
          exactName: true,
        });
        return yield* result(cwd, `Renamed ${action.from} to ${action.to}.`);
      case "branchDelete":
        return yield* deleteBranch(cwd, action);
      case "merge":
        return yield* merge(cwd, action.ref);
      case "rebase":
        return yield* rebase(cwd, action.onto);
      case "cherryPick":
        return yield* cherryPick(cwd, action.sha);
      case "rollback":
        return yield* rollback(cwd, action);
      case "rollbackToCheckpoint":
        return yield* rollbackToCheckpoint(cwd, action.checkpointRef);
      case "operationContinue":
        return yield* continueOperation(cwd);
      case "operationAbort":
        return yield* abortOperation(cwd);
      case "push": {
        const pushed = yield* git.pushCurrentBranch(cwd, null);
        return yield* result(
          cwd,
          pushed.status === "pushed" ? `Pushed ${pushed.branch}.` : "Already up to date.",
        );
      }
      case "pull": {
        const pulled = yield* workflow.pullCurrentBranch(cwd);
        return yield* result(
          cwd,
          pulled.status === "pulled" ? `Pulled ${pulled.refName}.` : "Already up to date.",
        );
      }
      case "fetch":
        yield* run(cwd, ["fetch", "--all", "--prune"], { timeoutMs: LONG_RUN_MS });
        return yield* result(cwd, "Fetched.");
      case "stashPush": {
        const pushed = yield* run(cwd, [
          "stash",
          "push",
          ...(action.includeUntracked === true ? ["--include-untracked"] : []),
          ...(action.message ? ["-m", action.message] : []),
        ]);
        return yield* result(
          cwd,
          pushed.stdout.includes("No local changes")
            ? "Nothing to stash."
            : "Stashed your changes.",
        );
      }
      case "stashApply":
        return yield* applyStash(cwd, action.sha);
      case "stashDrop":
        return yield* dropStash(cwd, action.sha);
      case "createPullRequest":
        return yield* createPullRequest(cwd, threadId);
      case "recoveryRestore":
        return yield* restoreRecovery(cwd, action.id);
      case "recoveryDismiss": {
        const record = yield* findRecovery(cwd, action.id);
        yield* dismissRecovery(cwd, record.point);
        return yield* result(cwd, "Removed the recovery point.");
      }
    }
  });

  const SHARES_CHECKOUT_LEASE: ReadonlySet<GitGraphAction["type"]> = new Set([
    "branchCheckout",
    "branchCreate",
    "createPullRequest",
    "pull",
  ]);

  const act: GitActions["Service"]["act"] = Effect.fn("GitActions.act")(function* (input, actor) {
    const { cwd, action } = input;
    const threadId = actor.threadId ?? input.threadId;
    const repository = yield* inRepository(ensureGitRepository(cwd));
    const reason = yield* inRepository(readOnlyReason(repository.rootPath));
    if (reason !== null) return yield* new GitGraphError({ code: "read_only", detail: reason });

    const auditFields = {
      actor: actor.actor,
      ...(actor.actorLabel === undefined ? {} : { actorLabel: actor.actorLabel }),
      domain: "git",
      action: `git.${action.type}`,
      target: { kind: "repository", id: repository.rootPath },
      ...(threadId === undefined ? {} : { threadId }),
    } as const;

    const realRoot = yield* fileSystem
      .realPath(repository.rootPath)
      .pipe(Effect.orElseSucceed(() => repository.rootPath));
    // These reach GitWorkflowService, which takes this same lease itself.
    const leased = SHARES_CHECKOUT_LEASE.has(action.type)
      ? perform(cwd, action, threadId)
      : withWorkspaceLease(realRoot, perform(cwd, action, threadId));

    return yield* leased.pipe(
      Effect.tap((done) =>
        audit.record({
          ...auditFields,
          outcome: "succeeded",
          result: done.message,
          ...(done.recovery === null
            ? {}
            : {
                undo: {
                  tool: "t3_git_recovery",
                  input: { action: { type: "recoveryRestore", id: done.recovery.id } },
                  label: "Go back",
                },
              }),
        }),
      ),
      Effect.tapError((error: GitGraphServiceError) =>
        audit.record({ ...auditFields, outcome: "failed", result: error.message }),
      ),
      Effect.ensuring(
        statusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid),
      ),
    );
  });

  const draftMessage: GitActions["Service"]["draftMessage"] = Effect.fn("GitActions.draftMessage")(
    function* (input) {
      yield* inRepository(ensureGitRepository(input.cwd));
      const summary = yield* run(input.cwd, ["diff", "--cached", "--name-status"]);
      const stagedSummary = summary.stdout.trim();
      if (stagedSummary.length === 0) return { message: null };
      const patch = yield* git.execute({
        operation: "GitActions.draftMessage",
        cwd: input.cwd,
        args: ["diff", "--no-ext-diff", "--no-textconv", "--cached", "--patch", "--minimal"],
        timeoutMs: 30_000,
        maxOutputBytes: DRAFT_PATCH_MAX_BYTES,
        appendTruncationMarker: true,
      });
      const message = yield* workflow
        .draftCommitMessage({
          cwd: input.cwd,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          context: { stagedSummary, stagedPatch: patch.stdout },
        })
        .pipe(
          Effect.mapError(() =>
            refused("Could not draft a message. Check the writing model in Settings."),
          ),
        );
      return { message };
    },
  );

  return GitActions.of({ preview, act, draftMessage });
});

export const layer = Layer.effect(GitActions, make);
