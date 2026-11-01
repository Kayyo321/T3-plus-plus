import { GitGraphError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";

const JJ_READ_ONLY_REASON =
  "This repository is managed by jj, so the Git view only reads it. Use jj to change its history.";

/** Everything the graph does goes through Git, so any other VCS stops here in plain words. */
export const ensureGitRepository = Effect.fn("GitGraph.ensureGitRepository")(function* (
  cwd: string,
) {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const handle = yield* registry.detect({ cwd }).pipe(
    Effect.catchTags({
      VcsUnsupportedOperationError: (error) =>
        Effect.fail(
          new GitGraphError({
            code: "unsupported",
            detail:
              error.kind === "jj"
                ? "This project is set to use jj, which the Git view does not support yet."
                : "This folder does not use a version control system the Git view supports.",
          }),
        ),
    }),
    Effect.mapError((error) =>
      error._tag === "GitGraphError"
        ? error
        : new GitGraphError({
            code: "unsupported",
            detail: "Could not read this repository.",
          }),
    ),
  );
  if (handle === null || handle.kind !== "git") {
    return yield* new GitGraphError({
      code: "unsupported",
      detail: "This folder is not a Git repository.",
    });
  }
  return handle.repository;
});

export const readOnlyReason = Effect.fn("GitGraph.readOnlyReason")(function* (rootPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const colocatedJj = yield* fileSystem
    .exists(path.join(rootPath, ".jj"))
    .pipe(Effect.orElseSucceed(() => false));
  return colocatedJj ? JJ_READ_ONLY_REASON : null;
});

export const sha256Hex = Effect.fn("GitGraph.sha256Hex")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(text)).pipe(Effect.orDie);
  return Hex.encode(digest);
});

export const resolveCommit = Effect.fn("GitGraph.resolveCommit")(function* (
  cwd: string,
  revision: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git.execute({
    operation: "GitGraph.resolveCommit",
    cwd,
    args: ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`],
    allowNonZeroExit: true,
    timeoutMs: 5_000,
  });
  const sha = result.stdout.trim();
  if (result.exitCode !== 0 || sha.length === 0) {
    return yield* new GitGraphError({
      code: "stale",
      detail: "That commit or branch no longer exists. Refresh the graph and try again.",
    });
  }
  return sha;
});
