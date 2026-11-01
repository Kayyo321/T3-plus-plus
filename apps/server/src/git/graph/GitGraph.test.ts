import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type GitGraphAction,
  type GitGraphListInput,
  type GitGraphRow,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as AuditTrail from "../../audit/AuditTrail.ts";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../../vcs/VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../GitWorkflowService.ts";
import * as ConversationAttribution from "./ConversationAttribution.ts";
import * as GitActions from "./GitActions.ts";
import * as GitGraphService from "./GitGraphService.ts";

const THREAD = ThreadId.make("thread-graph");
const RUN = RunId.make("run-graph");
const mark = { threadId: THREAD, title: "Fix the thing", runId: RUN, turn: 2 };

const layerDriver = Layer.mergeAll(GitVcsDriver.layerVcs, GitVcsDriver.layer).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-graph-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

const layerRegistry = VcsDriverRegistry.layer.pipe(Layer.provideMerge(layerDriver));

const layerWorkflow = Layer.unwrap(
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return Layer.mock(GitWorkflowService.GitWorkflowService)({
      switchRef: git.switchRef,
      pullCurrentBranch: git.pullCurrentBranch,
    });
  }),
).pipe(Layer.provide(layerDriver));

const recordedCheckpoints: Array<ConversationAttribution.CheckpointMeta> = [];

const layerAttribution = Layer.succeed(
  ConversationAttribution.ConversationAttribution,
  ConversationAttribution.ConversationAttribution.of({
    readCheckpoints: (refs) =>
      Effect.succeed(recordedCheckpoints.filter((checkpoint) => refs.includes(checkpoint.ref))),
  }),
);

const auditEntries: Array<{ readonly action: string; readonly outcome: string }> = [];

const layerGraph = GitGraphService.layer.pipe(
  Layer.provideMerge(layerAttribution),
  Layer.provideMerge(layerRegistry),
);

const layer = GitActions.layer.pipe(
  Layer.provideMerge(layerGraph),
  Layer.provide(layerWorkflow),
  Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
  Layer.provide(
    Layer.mock(AuditTrail.AuditTrail)({
      record: (entry) => Effect.sync(() => void auditEntries.push(entry)),
    }),
  ),
  Layer.provide(
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshStatus: () => Effect.succeed(null as never),
    }),
  ),
);

const ENV = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};

const runGit = Effect.fn("test.runGit")(function* (
  cwd: string,
  args: ReadonlyArray<string>,
  options?: { readonly allowFailure?: boolean; readonly env?: NodeJS.ProcessEnv },
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "test",
    cwd,
    args,
    env: { ...ENV, ...options?.env },
    timeoutMs: 20_000,
    allowNonZeroExit: options?.allowFailure ?? false,
  });
  return result.stdout.trim();
});

const write = Effect.fn("test.write")(function* (cwd: string, name: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(cwd, name);
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, contents);
});

const read = Effect.fn("test.read")(function* (cwd: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(cwd, name));
});

const exists = Effect.fn("test.exists")(function* (cwd: string, name: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.exists(path.join(cwd, name));
});

const commit = Effect.fn("test.commit")(function* (
  cwd: string,
  message: string,
  file: readonly [string, string] = [`${message}.txt`, message],
  options?: { readonly env?: NodeJS.ProcessEnv },
) {
  yield* write(cwd, file[0], file[1]);
  yield* runGit(cwd, ["add", "-A"]);
  yield* runGit(cwd, ["commit", "-m", message], options);
  return yield* runGit(cwd, ["rev-parse", "HEAD"]);
});

const makeRepo = Effect.fn("test.makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-git-graph-" });
  const cwd = yield* fileSystem.realPath(raw);
  yield* runGit(cwd, ["init", "--initial-branch=main"]);
  yield* runGit(cwd, ["config", "user.name", "Ada"]);
  yield* runGit(cwd, ["config", "user.email", "ada@example.com"]);
  yield* runGit(cwd, ["config", "commit.gpgsign", "false"]);
  return cwd;
});

const act = Effect.fn("test.act")(function* (cwd: string, action: GitGraphAction) {
  const actions = yield* GitActions.GitActions;
  return yield* actions.act({ cwd, action }, { actor: "user" });
});

const preview = Effect.fn("test.preview")(function* (cwd: string, action: GitGraphAction) {
  const actions = yield* GitActions.GitActions;
  return yield* actions.preview({ cwd, action });
});

const list = Effect.fn("test.list")(function* (
  input: Partial<GitGraphListInput> & { readonly cwd: string },
) {
  const graph = yield* GitGraphService.GitGraphService;
  return yield* graph.list(input);
});

const listAll = Effect.fn("test.listAll")(function* (
  input: Partial<GitGraphListInput> & { readonly cwd: string; readonly limit: number },
) {
  const rows: Array<GitGraphRow> = [];
  let cursor: string | undefined;
  for (;;) {
    const page = yield* list({ ...input, ...(cursor === undefined ? {} : { cursor }) });
    rows.push(...page.rows);
    if (page.nextCursor === null) return rows;
    cursor = page.nextCursor;
  }
});

const subjects = (rows: ReadonlyArray<GitGraphRow>) => rows.map((row) => row.subject);

const clearRecorded = Effect.sync(() => {
  recordedCheckpoints.length = 0;
  auditEntries.length = 0;
});

const provide = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof layer> | Scope.Scope>) =>
  clearRecorded.pipe(Effect.andThen(effect), Effect.scoped, Effect.provide(layer));

describe("GitGraphService", () => {
  it.live("shows branches, tags, remotes, and merges, but no hidden refs", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const base = yield* commit(cwd, "base");
        yield* runGit(cwd, ["tag", "v1"]);
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        yield* commit(cwd, "feature work");
        yield* runGit(cwd, ["update-ref", "refs/remotes/origin/feature", "HEAD"]);
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "main work");
        yield* runGit(cwd, ["merge", "--no-edit", "--no-ff", "feature"]);
        yield* runGit(cwd, [
          "update-ref",
          "refs/t3/orchestration-v2/checkpoints/abc/ordinal/1",
          base,
        ]);
        yield* commit(cwd, "stray", ["stray.txt", "x"]);
        const stray = yield* runGit(cwd, ["rev-parse", "HEAD"]);
        yield* runGit(cwd, ["update-ref", "refs/t3pp/recovery/hidden", stray]);
        yield* runGit(cwd, ["reset", "--hard", "HEAD~1"]);

        const page = yield* list({ cwd });
        assert.strictEqual(page.layout, "graph");
        assert.isFalse(subjects(page.rows).includes("stray"));
        const merge = page.rows.find((row) => row.parents.length === 2)!;
        assert.deepEqual(merge.refs, [{ kind: "head", name: "main" }]);
        assert.strictEqual(merge.out.length, 2);
        const feature = page.rows.find((row) => row.subject === "feature work")!;
        assert.deepInclude(feature.refs, { kind: "branch", name: "feature" });
        assert.deepInclude(feature.refs, { kind: "remote", name: "origin/feature" });
        const tagged = page.rows.find((row) => row.subject === "base")!;
        assert.deepInclude(tagged.refs, { kind: "tag", name: "v1" });
        assert.strictEqual(page.summary?.branch, "main");
        assert.deepEqual(page.summary?.branches.map((branch) => branch.name).toSorted(), [
          "feature",
          "main",
        ]);
      }),
    ),
  );

  it.live("lays out a real octopus merge and pages across its lanes", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "root");
        for (const branch of ["one", "two", "three"]) {
          yield* runGit(cwd, ["switch", "-c", branch, "main"]);
          yield* commit(cwd, `work on ${branch}`);
          yield* commit(cwd, `more on ${branch}`);
        }
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "main moved");
        yield* runGit(cwd, ["merge", "--no-edit", "one", "two", "three"]);

        const whole = yield* list({ cwd, limit: 50 });
        const paged = yield* listAll({ cwd, limit: 3 });
        assert.deepEqual(paged, [...whole.rows]);
        assert.strictEqual(whole.rows[0]!.parents.length, 4);
        assert.strictEqual(whole.rows[0]!.out.length, 4);
        assert.strictEqual(whole.rows.at(-1)!.into.length, 4);
      }),
    ),
  );

  it.live("keeps criss-cross merges connected", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "root");
        yield* runGit(cwd, ["switch", "-c", "left"]);
        const left = yield* commit(cwd, "left");
        yield* runGit(cwd, ["switch", "-c", "right", "main"]);
        const right = yield* commit(cwd, "right");
        yield* runGit(cwd, ["merge", "--no-edit", left]);
        yield* runGit(cwd, ["switch", "left"]);
        yield* runGit(cwd, ["merge", "--no-edit", right]);

        const { rows } = yield* list({ cwd });
        const merges = rows.filter((row) => row.parents.length === 2);
        assert.strictEqual(merges.length, 2);
        for (const merge of merges) assert.strictEqual(merge.out.length, 2);
        const open = new Set<number>();
        for (const row of rows) {
          for (const [lane] of [...row.into, ...row.through]) assert.isTrue(open.has(lane));
          for (const [lane] of row.into) open.delete(lane);
          for (const [lane] of row.out) open.add(lane);
        }
        assert.strictEqual(open.size, 0);
      }),
    ),
  );

  it.live("restarts from the top when refs move under a cursor", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        for (const name of ["a", "b", "c"]) yield* commit(cwd, name);
        const first = yield* list({ cwd, limit: 1 });
        yield* commit(cwd, "d");
        const second = yield* list({ cwd, limit: 1, cursor: first.nextCursor! });
        assert.isTrue(second.reset);
        assert.deepEqual(subjects(second.rows), ["d"]);
        assert.isNotNull(second.summary);
      }),
    ),
  );

  it.live("filters by author, path, and message into a flat list that still pages", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "fix: parser", ["src/parser.ts", "1"]);
        yield* commit(cwd, "docs: readme", ["README.md", "1"]);
        yield* commit(cwd, "fix: lexer", ["src/lexer.ts", "1"], {
          env: { GIT_AUTHOR_NAME: "Grace Hopper", GIT_AUTHOR_EMAIL: "grace@example.com" },
        });
        yield* commit(cwd, "fix: parser again", ["src/parser.ts", "2"]);

        const byMessage = yield* listAll({ cwd, limit: 2, filter: { message: "FIX:" } });
        assert.deepEqual(subjects(byMessage), ["fix: parser again", "fix: lexer", "fix: parser"]);
        const byAuthor = yield* list({ cwd, filter: { author: "grace" } });
        assert.strictEqual(byAuthor.layout, "flat");
        assert.deepEqual(subjects(byAuthor.rows), ["fix: lexer"]);
        const byPath = yield* list({ cwd, filter: { path: "src/parser.ts" } });
        assert.deepEqual(subjects(byPath.rows), ["fix: parser again", "fix: parser"]);
        assert.deepEqual(byPath.rows[0]!.out, []);
      }),
    ),
  );

  it.live("marks commits by trailer and by the turn whose checkpoints moved HEAD", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const base = yield* commit(cwd, "user commit");
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        const baseline = "refs/t3/orchestration-v2/checkpoints/scope/ordinal/0";
        const turn = "refs/t3/orchestration-v2/checkpoints/scope/ordinal/1";
        const checkpointAt = Effect.fn("test.checkpointAt")(function* (ref: string) {
          const tree = yield* runGit(cwd, ["rev-parse", "HEAD^{tree}"]);
          const sha = yield* runGit(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "checkpoint"]);
          yield* runGit(cwd, ["update-ref", ref, sha]);
        });
        yield* checkpointAt(baseline);
        yield* commit(cwd, "agent first");
        const tip = yield* commit(cwd, "agent second");
        yield* checkpointAt(turn);
        yield* commit(cwd, "credited\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
        recordedCheckpoints.push(
          {
            ref: baseline,
            mark: { ...mark, turn: null },
            ordinal: 0,
            previousRef: null,
            startedAt: null,
            capturedAt: now - 60,
          },
          {
            ref: turn,
            mark,
            ordinal: 1,
            previousRef: baseline,
            startedAt: now - 60,
            capturedAt: now + 60,
          },
        );

        const { rows } = yield* list({ cwd });
        const bySubject = (subject: string) => rows.find((row) => row.subject === subject)!;
        assert.deepEqual(bySubject("agent second").conversation, mark);
        assert.deepEqual(bySubject("agent first").conversation, mark);
        assert.isNull(bySubject("user commit").conversation);
        assert.isFalse(bySubject("user commit").agentMade);
        assert.isTrue(bySubject("credited").agentMade);
        assert.isNull(bySubject("credited").conversation);

        const agentOnly = yield* list({ cwd, filter: { agentOnly: true } });
        assert.deepEqual(subjects(agentOnly.rows), ["credited", "agent second", "agent first"]);
        const conversation = yield* list({ cwd, filter: { threadId: THREAD } });
        assert.deepEqual(subjects(conversation.rows), ["agent second", "agent first"]);

        const graph = yield* GitGraphService.GitGraphService;
        const detail = yield* graph.commit({ cwd, sha: tip });
        assert.deepEqual(detail.conversation, mark);
        const blame = yield* graph.blame({ cwd, path: "agent second.txt", line: 1 });
        assert.strictEqual(blame.sha, tip);
        assert.deepEqual(blame.conversation, mark);
        assert.isNull((yield* graph.commit({ cwd, sha: base })).conversation);
      }),
    ),
  );

  it.live("overlays checkpoints on their commit's lane without adding lanes", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        for (const ordinal of [0, 1, 2]) {
          const tree = yield* runGit(cwd, ["rev-parse", "HEAD^{tree}"]);
          const sha = yield* runGit(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", "checkpoint"]);
          const ref = `refs/t3/orchestration-v2/checkpoints/scope/ordinal/${ordinal}`;
          yield* runGit(cwd, ["update-ref", ref, sha]);
          recordedCheckpoints.push({
            ref,
            mark: { ...mark, turn: ordinal === 0 ? null : ordinal },
            ordinal,
            previousRef:
              ordinal === 0
                ? null
                : `refs/t3/orchestration-v2/checkpoints/scope/ordinal/${ordinal - 1}`,
            startedAt: now,
            capturedAt: now + ordinal,
          });
        }

        const hidden = yield* list({ cwd });
        assert.strictEqual(hidden.rows.length, 1);
        const { rows } = yield* list({ cwd, showCheckpoints: true });
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["checkpoint", "checkpoint", "checkpoint", "commit"],
        );
        assert.deepEqual(subjects(rows).slice(0, 2), ["Turn 2 checkpoint", "Turn 1 checkpoint"]);
        assert.isTrue(rows.every((row) => row.lane === 0));
        assert.deepEqual(rows[0]!.into, []);
        assert.strictEqual(rows[3]!.into.length, 1);
        const narrowed = yield* list({
          cwd,
          showCheckpoints: true,
          checkpointThreadId: ThreadId.make("another-thread"),
        });
        assert.strictEqual(narrowed.rows.length, 1);
      }),
    ),
  );

  it.live("flags risky unpushed commits and leaves pushed ones alone", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "pushed secret", [".env", "A=1"]);
        yield* runGit(cwd, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
        const risky = yield* commit(cwd, "add key", ["deploy/id_rsa", "secret"]);
        const { summary } = yield* list({ cwd });
        assert.deepEqual(
          summary?.risks.map((risk) => risk.sha),
          [risky],
        );
        assert.deepEqual(summary?.risks[0]?.reasons, ["sensitive-path"]);
      }),
    ),
  );

  it.live("works from a worktree and shows every checkout's HEAD", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* commit(cwd, "base");
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-graph-wt-" });
        const worktree = path.join(yield* fileSystem.realPath(parent), "wt");
        yield* runGit(cwd, ["worktree", "add", "--detach", worktree]);
        yield* commit(worktree, "detached work");
        const fromMain = yield* list({ cwd });
        assert.isTrue(subjects(fromMain.rows).includes("detached work"));
        const fromWorktree = yield* list({ cwd: worktree });
        assert.isTrue(fromWorktree.summary!.worktrees.some((entry) => entry.isCurrent));
        assert.strictEqual(fromWorktree.summary?.branch, null);
      }),
    ),
  );

  it.live("explains jj instead of acting on it", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fileSystem.makeDirectory(path.join(cwd, ".jj"));
        const { summary } = yield* list({ cwd });
        assert.include(summary?.readOnlyReason ?? "", "jj");
        const exit = yield* Effect.exit(act(cwd, { type: "fetch" }));
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "only reads it");
      }),
    ),
  );
});

describe("GitActions", () => {
  it.live("rollback saves everything first and the way back restores it", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "keep", ["keep.txt", "v1"]);
        const undone = yield* commit(cwd, "undo me", ["keep.txt", "v2"]);
        yield* write(cwd, "keep.txt", "uncommitted edit");
        yield* write(cwd, "untracked.txt", "new file");

        const previewed = yield* preview(cwd, { type: "rollback", target: "HEAD~1", mode: "hard" });
        assert.strictEqual(previewed.title, "Undo last commit and throw away the changes");
        assert.isTrue(previewed.discardsChanges);
        assert.deepEqual(
          previewed.commits.map((entry) => entry.sha),
          [undone],
        );
        assert.deepEqual(previewed.files, ["keep.txt"]);
        assert.strictEqual(yield* read(cwd, "keep.txt"), "uncommitted edit");

        const done = yield* act(cwd, { type: "rollback", target: "HEAD~1", mode: "hard" });
        assert.strictEqual(yield* read(cwd, "keep.txt"), "v1");
        assert.notStrictEqual(done.headSha, undone);
        const recovery = done.recovery!;
        assert.strictEqual(recovery.sha, undone);
        assert.isTrue(recovery.savedChanges);
        assert.deepEqual(
          (yield* list({ cwd })).summary?.recoveries.map((entry) => entry.id),
          [recovery.id],
        );

        const restored = yield* act(cwd, { type: "recoveryRestore", id: recovery.id });
        assert.strictEqual(restored.headSha, undone);
        assert.strictEqual(yield* read(cwd, "keep.txt"), "uncommitted edit");
        assert.strictEqual(yield* read(cwd, "untracked.txt"), "new file");
        assert.strictEqual(yield* runGit(cwd, ["symbolic-ref", "--short", "HEAD"]), "main");

        // Going back is itself reversible.
        const redo = yield* act(cwd, { type: "recoveryRestore", id: restored.recovery!.id });
        assert.strictEqual(redo.headSha, done.headSha);
        assert.strictEqual(yield* read(cwd, "keep.txt"), "v1");
      }),
    ),
  );

  it.live("names rollback in plain words and keeps changes on soft and mixed", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["file.txt", "1"]);
        yield* commit(cwd, "next", ["file.txt", "2"]);
        const mixed = yield* preview(cwd, { type: "rollback", target: "HEAD~1", mode: "mixed" });
        assert.strictEqual(mixed.title, "Undo last commit, keep my changes");
        assert.isFalse(mixed.discardsChanges);
        yield* act(cwd, { type: "rollback", target: "HEAD~1", mode: "mixed" });
        assert.strictEqual(yield* read(cwd, "file.txt"), "2");
        const graph = yield* GitGraphService.GitGraphService;
        const { files } = yield* graph.changes({ cwd });
        assert.deepEqual(files, [{ path: "file.txt", staged: " ", unstaged: "M" }]);
        yield* commit(cwd, "next again", ["file.txt", "2"]);
        yield* act(cwd, { type: "rollback", target: "HEAD~1", mode: "soft" });
        const soft = yield* graph.changes({ cwd });
        assert.deepEqual(soft.files, [{ path: "file.txt", staged: "M", unstaged: " " }]);
      }),
    ),
  );

  it.live("previews a conflicting merge without touching the checkout, then stops safely", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["shared.txt", "base\n"]);
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        yield* commit(cwd, "theirs", ["shared.txt", "theirs\n"]);
        yield* commit(cwd, "theirs clean", ["clean.txt", "clean\n"]);
        yield* runGit(cwd, ["switch", "main"]);
        const ours = yield* commit(cwd, "ours", ["shared.txt", "ours\n"]);

        const previewed = yield* preview(cwd, { type: "merge", ref: "feature" });
        assert.deepEqual(previewed.conflicts, ["shared.txt"]);
        assert.isTrue(previewed.files.includes("clean.txt"));
        assert.strictEqual(previewed.commitsTotal, 2);
        assert.strictEqual(yield* read(cwd, "shared.txt"), "ours\n");
        assert.strictEqual(yield* runGit(cwd, ["status", "--porcelain"]), "");

        const stopped = yield* act(cwd, { type: "merge", ref: "feature" });
        assert.strictEqual(stopped.outcome, "conflicts");
        assert.deepEqual(stopped.conflicts, ["shared.txt"]);
        const { summary } = yield* list({ cwd });
        assert.strictEqual(summary?.operation?.kind, "merge");
        assert.deepEqual(summary?.operation?.conflicts, ["shared.txt"]);
        assert.strictEqual(summary?.operation?.recoveryId, stopped.recovery!.id);

        const refused = yield* Effect.exit(act(cwd, { type: "operationContinue" }));
        assert.isTrue(Exit.isFailure(refused));
        const rollback = yield* Effect.exit(act(cwd, { type: "rebase", onto: "feature" }));
        assert.isTrue(Exit.isFailure(rollback));

        yield* act(cwd, { type: "operationAbort" });
        assert.strictEqual(yield* runGit(cwd, ["rev-parse", "HEAD"]), ours);
        assert.isNull((yield* list({ cwd })).summary?.operation ?? null);
      }),
    ),
  );

  it.live("finishes a conflicted merge once the file is resolved and staged", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["shared.txt", "base\n"]);
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        yield* commit(cwd, "theirs", ["shared.txt", "theirs\n"]);
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "ours", ["shared.txt", "ours\n"]);
        yield* act(cwd, { type: "merge", ref: "feature" });
        yield* write(cwd, "shared.txt", "resolved\n");
        yield* act(cwd, { type: "stage", paths: ["shared.txt"] });
        const finished = yield* act(cwd, { type: "operationContinue" });
        assert.strictEqual(finished.outcome, "done");
        assert.strictEqual(
          yield* runGit(cwd, ["rev-list", "--parents", "-n", "1", "HEAD"]).pipe(
            Effect.map((line) => line.split(" ").length),
          ),
          3,
        );
      }),
    ),
  );

  it.live("merges cleanly with a recovery point and undoes the merge", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        yield* commit(cwd, "feature");
        yield* runGit(cwd, ["switch", "main"]);
        const before = yield* commit(cwd, "main");
        const merged = yield* act(cwd, { type: "merge", ref: "feature" });
        assert.strictEqual(merged.outcome, "done");
        assert.isTrue(yield* exists(cwd, "feature.txt"));
        const undone = yield* act(cwd, { type: "recoveryRestore", id: merged.recovery!.id });
        assert.strictEqual(undone.headSha, before);
        assert.isFalse(yield* exists(cwd, "feature.txt"));
      }),
    ),
  );

  it.live("rebase states what it rewrites and can be undone", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        const original = yield* commit(cwd, "feature");
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "main moved");
        yield* runGit(cwd, ["switch", "feature"]);

        const previewed = yield* preview(cwd, { type: "rebase", onto: "main" });
        assert.isTrue(previewed.rewritesHistory);
        assert.include(previewed.summary, "rewrites history");
        assert.deepEqual(
          previewed.commits.map((entry) => entry.sha),
          [original],
        );

        const rebased = yield* act(cwd, { type: "rebase", onto: "main" });
        assert.notStrictEqual(rebased.headSha, original);
        const undone = yield* act(cwd, { type: "recoveryRestore", id: rebased.recovery!.id });
        assert.strictEqual(undone.headSha, original);
        assert.strictEqual(yield* runGit(cwd, ["symbolic-ref", "--short", "HEAD"]), "feature");
      }),
    ),
  );

  it.live("recovers a rebase from another branch", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        const original = yield* commit(cwd, "feature");
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "main moved");
        yield* runGit(cwd, ["switch", "feature"]);
        const rebased = yield* act(cwd, { type: "rebase", onto: "main" });
        yield* runGit(cwd, ["switch", "main"]);
        const undone = yield* act(cwd, { type: "recoveryRestore", id: rebased.recovery!.id });
        assert.strictEqual(undone.headSha, original);
        assert.strictEqual(yield* runGit(cwd, ["symbolic-ref", "--short", "HEAD"]), "feature");
      }),
    ),
  );

  it.live("forgets a recovery point when Git refused before changing anything", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["file.txt", "1"]);
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        yield* commit(cwd, "feature", ["file.txt", "2"]);
        yield* runGit(cwd, ["switch", "main"]);
        yield* write(cwd, "file.txt", "dirty");
        const exit = yield* Effect.exit(act(cwd, { type: "merge", ref: "feature" }));
        assert.isTrue(Exit.isFailure(exit));
        assert.deepEqual((yield* list({ cwd })).summary?.recoveries, []);
        assert.strictEqual(yield* read(cwd, "file.txt"), "dirty");
      }),
    ),
  );

  it.live("cherry-picks behind the same notice and stops on conflicts", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["shared.txt", "base\n"]);
        yield* runGit(cwd, ["switch", "-c", "feature"]);
        const clean = yield* commit(cwd, "clean", ["clean.txt", "x"]);
        const conflicting = yield* commit(cwd, "conflict", ["shared.txt", "theirs\n"]);
        yield* runGit(cwd, ["switch", "main"]);
        yield* commit(cwd, "ours", ["shared.txt", "ours\n"]);

        assert.isTrue((yield* preview(cwd, { type: "cherryPick", sha: clean })).rewritesHistory);
        const picked = yield* act(cwd, { type: "cherryPick", sha: clean });
        assert.strictEqual(picked.outcome, "done");
        assert.isTrue(yield* exists(cwd, "clean.txt"));

        const previewed = yield* preview(cwd, { type: "cherryPick", sha: conflicting });
        assert.deepEqual(previewed.conflicts, ["shared.txt"]);
        const stopped = yield* act(cwd, { type: "cherryPick", sha: conflicting });
        assert.strictEqual(stopped.outcome, "conflicts");
        assert.strictEqual((yield* list({ cwd })).summary?.operation?.kind, "cherry-pick");
        yield* act(cwd, { type: "operationAbort" });
        assert.strictEqual(yield* read(cwd, "shared.txt"), "ours\n");
      }),
    ),
  );

  it.live("round-trips a stash through push, apply, drop, and back", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["file.txt", "1"]);
        yield* write(cwd, "file.txt", "2");
        yield* write(cwd, "new.txt", "new");
        yield* act(cwd, { type: "stashPush", message: "wip", includeUntracked: true });
        assert.strictEqual(yield* read(cwd, "file.txt"), "1");
        assert.isFalse(yield* exists(cwd, "new.txt"));

        const [stash] = (yield* list({ cwd })).summary!.stashes;
        assert.include(stash!.message, "wip");
        yield* act(cwd, { type: "stashApply", sha: stash!.sha });
        assert.strictEqual(yield* read(cwd, "file.txt"), "2");
        assert.strictEqual(yield* read(cwd, "new.txt"), "new");
        assert.strictEqual((yield* list({ cwd })).summary?.stashes.length, 1);

        const dropped = yield* act(cwd, { type: "stashDrop", sha: stash!.sha });
        assert.strictEqual((yield* list({ cwd })).summary?.stashes.length, 0);
        yield* act(cwd, { type: "recoveryRestore", id: dropped.recovery!.id });
        const [back] = (yield* list({ cwd })).summary!.stashes;
        assert.strictEqual(back?.sha, stash!.sha);
        assert.include(back?.message ?? "", "wip");
      }),
    ),
  );

  it.live("warns before deleting unmerged work and can bring the branch back", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        yield* runGit(cwd, ["switch", "-c", "merged"]);
        yield* runGit(cwd, ["switch", "-c", "unmerged"]);
        const tip = yield* commit(cwd, "only here");
        yield* runGit(cwd, ["switch", "main"]);

        const safe = yield* preview(cwd, { type: "branchDelete", name: "merged" });
        assert.isFalse(safe.requiresAcknowledgement);
        const risky = yield* preview(cwd, { type: "branchDelete", name: "unmerged" });
        assert.isTrue(risky.requiresAcknowledgement);
        assert.deepEqual(
          risky.commits.map((entry) => entry.sha),
          [tip],
        );

        const refused = yield* Effect.exit(act(cwd, { type: "branchDelete", name: "unmerged" }));
        assert.isTrue(Exit.isFailure(refused));
        assert.strictEqual(yield* runGit(cwd, ["rev-parse", "unmerged"]), tip);

        const deleted = yield* act(cwd, {
          type: "branchDelete",
          name: "unmerged",
          acknowledgeUnmerged: true,
        });
        const gone = yield* runGit(cwd, ["rev-parse", "--verify", "--quiet", "unmerged"], {
          allowFailure: true,
        });
        assert.strictEqual(gone, "");
        yield* act(cwd, { type: "recoveryRestore", id: deleted.recovery!.id });
        assert.strictEqual(yield* runGit(cwd, ["rev-parse", "unmerged"]), tip);

        const current = yield* preview(cwd, { type: "branchDelete", name: "main" });
        assert.isFalse(current.canProceed);
      }),
    ),
  );

  it.live("branches from any node, renames, and checks out", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const first = yield* commit(cwd, "first");
        yield* commit(cwd, "second");
        yield* act(cwd, { type: "branchCreate", name: "from-first", startPoint: first });
        assert.strictEqual(yield* runGit(cwd, ["rev-parse", "from-first"]), first);
        yield* act(cwd, { type: "branchRename", from: "from-first", to: "renamed" });
        yield* act(cwd, { type: "branchCheckout", name: "renamed" });
        assert.strictEqual(yield* runGit(cwd, ["symbolic-ref", "--short", "HEAD"]), "renamed");
        const invalid = yield* Effect.exit(
          act(cwd, { type: "branchCreate", name: "bad..name", startPoint: "HEAD" }),
        );
        assert.isTrue(Exit.isFailure(invalid));
      }),
    ),
  );

  it.live("stages one hunk, refuses a stale one, and commits with the given message", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
        yield* commit(cwd, "base", ["file.txt", `${lines.join("\n")}\n`]);
        lines[1] = "changed top";
        lines[28] = "changed bottom";
        yield* write(cwd, "file.txt", `${lines.join("\n")}\n`);

        const graph = yield* GitGraphService.GitGraphService;
        const { hunks } = yield* graph.changes({ cwd, path: "file.txt" });
        assert.strictEqual(hunks.length, 2);
        const [top, bottom] = hunks;
        yield* act(cwd, { type: "stageHunk", path: "file.txt", hunkId: top!.id });

        const staged = yield* runGit(cwd, ["diff", "--cached", "--name-only"]);
        assert.strictEqual(staged, "file.txt");
        const after = yield* graph.changes({ cwd, path: "file.txt" });
        assert.deepEqual(
          after.hunks.map((hunk) => hunk.staged),
          [false, true],
        );
        assert.strictEqual(after.hunks[0]!.id, bottom!.id);

        const stale = yield* Effect.exit(
          act(cwd, { type: "stageHunk", path: "file.txt", hunkId: "nope" }),
        );
        assert.isTrue(Exit.isFailure(stale));

        yield* act(cwd, { type: "unstageHunk", path: "file.txt", hunkId: after.hunks[1]!.id });
        assert.strictEqual(yield* runGit(cwd, ["diff", "--cached", "--name-only"]), "");
        yield* act(cwd, { type: "stageHunk", path: "file.txt", hunkId: top!.id });
        yield* act(cwd, { type: "commit", message: "feat: subject\n\nThe body." });
        assert.strictEqual(yield* runGit(cwd, ["log", "-1", "--format=%s"]), "feat: subject");
        assert.strictEqual(yield* runGit(cwd, ["log", "-1", "--format=%b"]), "The body.");
        assert.include(yield* runGit(cwd, ["diff", "--name-only"]), "file.txt");
      }),
    ),
  );

  it.live("returns to a checkpoint with its untracked files and can come back", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base", ["file.txt", "1"]);
        yield* write(cwd, "file.txt", "turn edit");
        yield* write(cwd, "made-by-turn.txt", "turn file");
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const { driver } = yield* registry.resolve({ cwd });
        const checkpointRef = "refs/t3/orchestration-v2/checkpoints/scope/ordinal/1";
        yield* driver.checkpoints.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRef as never,
        });
        yield* commit(cwd, "later", ["file.txt", "later"]);
        yield* runGit(cwd, ["clean", "-fd"]);

        const previewed = yield* preview(cwd, { type: "rollbackToCheckpoint", checkpointRef });
        assert.strictEqual(previewed.commitsTotal, 1);
        const done = yield* act(cwd, { type: "rollbackToCheckpoint", checkpointRef });
        assert.strictEqual(yield* read(cwd, "file.txt"), "turn edit");
        assert.strictEqual(yield* read(cwd, "made-by-turn.txt"), "turn file");
        yield* act(cwd, { type: "recoveryRestore", id: done.recovery!.id });
        assert.strictEqual(yield* read(cwd, "file.txt"), "later");

        const notCheckpoint = yield* Effect.exit(
          act(cwd, { type: "rollbackToCheckpoint", checkpointRef: "refs/heads/main" }),
        );
        assert.isTrue(Exit.isFailure(notCheckpoint));
      }),
    ),
  );

  it.live("pushes, fetches, and pulls with ahead and behind on the branch", () =>
    provide(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const remoteRoot = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-graph-remote-",
        });
        const remote = yield* fileSystem.realPath(remoteRoot);
        yield* runGit(remote, ["init", "--bare", "--initial-branch=main"]);
        const cwd = yield* makeRepo();
        yield* runGit(cwd, ["remote", "add", "origin", remote]);
        yield* commit(cwd, "base");
        const pushed = yield* act(cwd, { type: "push" });
        assert.include(pushed.message, "Pushed");
        const ahead = yield* commit(cwd, "ahead");
        const status = (yield* list({ cwd })).summary;
        assert.strictEqual(status?.upstream, "origin/main");
        assert.strictEqual(status?.ahead, 1);

        yield* act(cwd, { type: "push" });
        yield* runGit(cwd, ["reset", "--hard", "HEAD~1"]);
        yield* act(cwd, { type: "fetch" });
        assert.strictEqual((yield* list({ cwd })).summary?.behind, 1);
        const pulled = yield* act(cwd, { type: "pull" });
        assert.strictEqual(pulled.headSha, ahead);
      }),
    ),
  );

  it.live("records what it did for the audit trail, failures included", () =>
    provide(
      Effect.gen(function* () {
        const cwd = yield* makeRepo();
        yield* commit(cwd, "base");
        yield* act(cwd, { type: "rollback", target: "HEAD", mode: "soft" });
        yield* Effect.exit(act(cwd, { type: "merge", ref: "does-not-exist" }));
        assert.deepEqual(
          auditEntries.map(({ action, outcome }) => [action, outcome]),
          [
            ["git.rollback", "succeeded"],
            ["git.merge", "failed"],
          ],
        );
      }),
    ),
  );
});
