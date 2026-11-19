import {
  IdeError,
  type IdeAgentChanges as IdeAgentChangesFeed,
  type IdeAgentChangesInput,
  type IdeAgentFile,
  type IdeAgentHunkActionInput,
  type ThreadId,
  threadInitial,
  threadLane,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { hunkChanges, locateHunk, parsePatch, singleHunkPatch } from "./agentHunks.ts";

const WAIT_FOR_CHANGE = "25 seconds";
/** Files larger than this keep their badge but get no marks. */
const MAX_MARKED_FILE_BYTES = 2_000_000;

export class IdeAgentChanges extends Context.Service<
  IdeAgentChanges,
  {
    /** Points the editor's folder at the thread `ide.open` was asked for. */
    readonly bind: (folder: string, threadId: ThreadId) => Effect.Effect<void>;
    /** The bound thread's latest turn, as marks on the files as they are now. */
    readonly changes: (input: IdeAgentChangesInput) => Effect.Effect<IdeAgentChangesFeed, IdeError>;
    /** Takes one of that turn's hunks out of its file, or puts it back. */
    readonly applyHunk: (input: IdeAgentHunkActionInput) => Effect.Effect<void, IdeError>;
  }
>()("t3pp/ide/IdeAgentChanges") {}

const unavailable = (detail: string) => new IdeError({ reason: "change_unavailable", detail });

interface FolderState {
  readonly version: string;
  readonly thread: {
    readonly id: ThreadId;
    readonly title: string;
    readonly turn: number;
  } | null;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const diffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const vcs = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;

  const bindings = yield* Ref.make<ReadonlyMap<string, ThreadId>>(new Map());
  const rebound = yield* PubSub.unbounded<void>();

  const pathKey = (target: string) => {
    const resolved = path.resolve(target);
    return platform === "win32" ? resolved.toLowerCase() : resolved;
  };

  const bind = Effect.fn("IdeAgentChanges.bind")(function* (folder: string, threadId: ThreadId) {
    const key = pathKey(folder);
    const previous = (yield* Ref.get(bindings)).get(key);
    if (previous === threadId) return;
    yield* Ref.update(bindings, (current) => new Map(current).set(key, threadId));
    yield* PubSub.publish(rebound, undefined);
  });

  /** The latest turn whose diff `getTurnDiff` can serve. */
  const latestTurn = Effect.fn("IdeAgentChanges.latestTurn")(function* (threadId: ThreadId) {
    const context = yield* threads.getCheckpointContext(threadId);
    const completed = new Set(
      context.runs.filter((run) => run.status === "completed").map((run) => run.id),
    );
    return context.checkpoints.reduce(
      (latest, checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.runId !== null &&
        completed.has(checkpoint.runId) &&
        checkpoint.appRunOrdinal !== null
          ? Math.max(latest, checkpoint.appRunOrdinal)
          : latest,
      0,
    );
  });

  const folderState = Effect.fn("IdeAgentChanges.folderState")(function* (key: string) {
    const threadId = (yield* Ref.get(bindings)).get(key);
    if (threadId === undefined) return { version: "none", thread: null } satisfies FolderState;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const turn = yield* latestTurn(threadId).pipe(Effect.orElseSucceed(() => 0));
    if (shell === null || turn === 0) {
      return { version: `${threadId}:0`, thread: null } satisfies FolderState;
    }
    return {
      version: `${threadId}:${turn}`,
      thread: { id: threadId, title: shell.title, turn },
    } satisfies FolderState;
  });

  /** The turn's text files, parsed, with the repository root their paths start from. */
  const turnPatch = Effect.fn("IdeAgentChanges.turnPatch")(function* (
    folder: string,
    threadId: ThreadId,
    turn: number,
  ) {
    const handle = yield* vcs
      .resolve({ cwd: folder })
      .pipe(Effect.mapError(() => unavailable("This folder is not a repository T3++ can diff.")));
    const diff = yield* diffs
      .getTurnDiff({
        threadId,
        fromTurnCount: turn - 1,
        toTurnCount: turn,
        // Hunks must apply byte for byte, so whitespace stays in.
        ignoreWhitespace: false,
      })
      .pipe(Effect.mapError(() => unavailable("This turn's changes are no longer available.")));
    return { root: handle.repository.rootPath, files: parsePatch(diff.diff) };
  });

  const markFiles = Effect.fn("IdeAgentChanges.markFiles")(function* (
    folder: string,
    threadId: ThreadId,
    turn: number,
  ) {
    const { root, files } = yield* turnPatch(folder, threadId, turn);
    const marked: IdeAgentFile[] = [];
    for (const file of files) {
      if (file.deleted) continue;
      const absolute = path.join(root, file.path);
      const size = yield* fs.stat(absolute).pipe(
        Effect.map((info) => Number(info.size)),
        Effect.orElseSucceed(() => null),
      );
      if (size === null) continue;
      if (size > MAX_MARKED_FILE_BYTES) {
        marked.push({ path: absolute, hunks: [] });
        continue;
      }
      const text = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => null));
      if (text === null) continue;
      const lines = text.split("\n");
      const hunks = file.hunks.flatMap((hunk) => {
        const start = locateHunk(hunk, lines);
        return start === null
          ? []
          : [{ id: hunk.id, changes: hunkChanges(hunk, start, lines.length) }];
      });
      marked.push({ path: absolute, hunks });
    }
    return marked;
  });

  /** Resolves once something that can move the folder's feed happens. */
  const nextChange = (threadId: ThreadId | undefined) =>
    Stream.runHead(
      Stream.merge(
        Stream.fromPubSub(rebound),
        threadId === undefined
          ? Stream.never
          : threads.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.threadId === threadId &&
                  (event.type === "run.updated" || event.type === "checkpoint.captured"),
              ),
              Stream.orDie,
            ),
      ),
    );

  const changes = Effect.fn("IdeAgentChanges.changes")(function* (input: IdeAgentChangesInput) {
    const key = pathKey(input.folder);
    let state = yield* folderState(key);
    if (input.after !== undefined && state.version === input.after) {
      const settled = yield* Effect.gen(function* () {
        while (true) {
          yield* nextChange((yield* Ref.get(bindings)).get(key));
          const next = yield* folderState(key);
          if (next.version !== input.after) return next;
        }
      }).pipe(Effect.timeoutOption(WAIT_FOR_CHANGE));
      state = Option.getOrElse(settled, () => state);
    }
    if (state.thread === null) return { version: state.version, thread: null, files: [] };
    const thread = state.thread;
    const files = yield* markFiles(input.folder, thread.id, thread.turn).pipe(
      Effect.orElseSucceed((): ReadonlyArray<IdeAgentFile> => []),
    );
    return {
      version: state.version,
      thread: {
        id: thread.id,
        title: thread.title,
        initial: threadInitial(thread.title),
        lane: threadLane(thread.id),
        turn: thread.turn,
      },
      files,
    };
  });

  const applyHunk = Effect.fn("IdeAgentChanges.applyHunk")(function* (
    input: IdeAgentHunkActionInput,
  ) {
    const bound = (yield* Ref.get(bindings)).get(pathKey(input.folder));
    if (bound !== input.threadId) {
      return yield* unavailable("The editor is showing another conversation now.");
    }
    const { root, files } = yield* turnPatch(input.folder, input.threadId, input.turn);
    const file = files.find(
      (candidate) => pathKey(path.join(root, candidate.path)) === pathKey(input.path),
    );
    const hunk = file?.hunks.find((candidate) => candidate.id === input.hunkId);
    if (file === undefined || hunk === undefined) {
      return yield* unavailable("That change is not part of the agent's latest turn anymore.");
    }
    const text =
      file.created && input.action === "reapply"
        ? ""
        : yield* fs.readFileString(input.path).pipe(Effect.orElseSucceed(() => null));
    const at =
      text === null
        ? null
        : file.created && input.action === "reapply"
          ? 0
          : locateHunk(hunk, text.split("\n"), input.action === "revert" ? "new" : "old");
    const applied =
      at !== null &&
      (yield* checkpoints
        .applyPatch({
          cwd: root,
          patch: singleHunkPatch(file, hunk, at),
          reverse: input.action === "revert",
        })
        .pipe(Effect.orElseSucceed(() => false)));
    if (!applied) {
      return yield* unavailable(
        input.action === "revert"
          ? "These lines changed since the agent wrote them, so this change cannot be reverted on its own."
          : "These lines changed since, so the agent's change cannot be put back on its own.",
      );
    }
  });

  return IdeAgentChanges.of({ bind, changes, applyHunk });
});

export const layer = Layer.effect(IdeAgentChanges, make);
