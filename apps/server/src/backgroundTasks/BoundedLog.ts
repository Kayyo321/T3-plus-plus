import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** A long-lived dev server cannot be allowed to fill a disk, however noisy it is. */
const BOUNDED_LOG_MAX_BYTES = 1024 * 1024;
const BOUNDED_LOG_ROTATED_FILES = 2;

const LOG_NAME = "output.log";

const logFile = (path: Path.Path, dir: string, generation: number) =>
  path.join(dir, generation === 0 ? LOG_NAME : `output.${generation}.log`);

const fileSize = (fileSystem: FileSystem.FileSystem, target: string) =>
  fileSystem.stat(target).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );

/** Appends must come from one fiber at a time; a task's output pump is that fiber. */
export const makeBoundedLog = Effect.fn("BoundedLog.make")(function* (input: {
  readonly dir: string;
  readonly maxBytes?: number;
  readonly rotatedFiles?: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const maxBytes = input.maxBytes ?? BOUNDED_LOG_MAX_BYTES;
  const rotatedFiles = input.rotatedFiles ?? BOUNDED_LOG_ROTATED_FILES;
  yield* fileSystem.makeDirectory(input.dir, { recursive: true });
  const current = logFile(path, input.dir, 0);
  let size = yield* fileSize(fileSystem, current);

  const rotate = Effect.gen(function* () {
    yield* fileSystem
      .remove(logFile(path, input.dir, rotatedFiles), { force: true })
      .pipe(Effect.ignore);
    for (let generation = rotatedFiles - 1; generation >= 0; generation -= 1) {
      const from = logFile(path, input.dir, generation);
      if (yield* fileSystem.exists(from)) {
        yield* fileSystem.rename(from, logFile(path, input.dir, generation + 1));
      }
    }
    size = 0;
  });

  const append = Effect.fn("BoundedLog.append")(function* (chunk: Uint8Array) {
    const kept = chunk.byteLength > maxBytes ? chunk.subarray(-maxBytes) : chunk;
    if (size + kept.byteLength > maxBytes) yield* rotate;
    yield* fileSystem.writeFile(current, kept, { flag: "a" });
    size += kept.byteLength;
  });

  return { path: current, append };
});

/** The end of the log across its rotated files, oldest bytes first. */
export const readBoundedLogTail = Effect.fn("BoundedLog.readTail")(function* (input: {
  readonly dir: string;
  readonly tailBytes: number;
  readonly rotatedFiles?: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const rotatedFiles = input.rotatedFiles ?? BOUNDED_LOG_ROTATED_FILES;
  const chunks: Array<Uint8Array> = [];
  let remaining = input.tailBytes;
  let truncated = false;
  for (let generation = 0; generation <= rotatedFiles; generation += 1) {
    const target = logFile(path, input.dir, generation);
    if (!(yield* fileSystem.exists(target))) break;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const bytes = yield* fileSystem.readFile(target);
    chunks.unshift(bytes.byteLength > remaining ? bytes.subarray(-remaining) : bytes);
    truncated ||= bytes.byteLength > remaining;
    remaining -= bytes.byteLength;
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
});
