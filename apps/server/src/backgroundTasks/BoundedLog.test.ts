import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeBoundedLog, readBoundedLogTail } from "./BoundedLog.ts";

const encode = (text: string) => new TextEncoder().encode(text);

const logFiles = Effect.fn("BoundedLogTest.logFiles")(function* (dir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem.readDirectory(dir);
  return yield* Effect.forEach(names.toSorted(), (name) =>
    fileSystem.stat(path.join(dir, name)).pipe(Effect.map((info) => [name, Number(info.size)])),
  );
});

it.effect("rotates at the size limit and drops the oldest generation", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    const log = yield* makeBoundedLog({ dir, maxBytes: 10, rotatedFiles: 2 });

    for (const line of ["aaaaaaaa\n", "bbbbbbbb\n", "cccccccc\n", "dddddddd\n"]) {
      yield* log.append(encode(line));
    }

    assert.deepEqual(yield* logFiles(dir), [
      ["output.1.log", 9],
      ["output.2.log", 9],
      ["output.log", 9],
    ]);
    const { text, truncated } = yield* readBoundedLogTail({ dir, tailBytes: 100, rotatedFiles: 2 });
    assert.equal(text, "bbbbbbbb\ncccccccc\ndddddddd\n");
    assert.isFalse(truncated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps only the end of a chunk larger than a whole file", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    const log = yield* makeBoundedLog({ dir, maxBytes: 4, rotatedFiles: 1 });

    yield* log.append(encode("0123456789"));

    assert.deepEqual(yield* logFiles(dir), [["output.log", 4]]);
    assert.equal((yield* readBoundedLogTail({ dir, tailBytes: 4 })).text, "6789");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a tail shorter than the log says older output exists", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    const log = yield* makeBoundedLog({ dir, maxBytes: 100 });

    yield* log.append(encode("first line\nsecond line\n"));

    const page = yield* readBoundedLogTail({ dir, tailBytes: 12 });
    assert.equal(page.text, "second line\n");
    assert.isTrue(page.truncated);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("resumes counting from the file already on disk", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const dir = yield* fileSystem.makeTempDirectoryScoped();
    const first = yield* makeBoundedLog({ dir, maxBytes: 10 });
    yield* first.append(encode("12345678"));

    const second = yield* makeBoundedLog({ dir, maxBytes: 10 });
    yield* second.append(encode("abcd"));

    assert.deepEqual(yield* logFiles(dir), [
      ["output.1.log", 8],
      ["output.log", 4],
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
