// @effect-diagnostics nodeBuiltinImport:off - a synchronous digest names each hunk.
import type { IdeAgentChange } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

export interface PatchHunk {
  readonly id: string;
  readonly header: string;
  readonly newStart: number;
  /** Body lines with their ` `, `-`, `+`, or `\` prefix. */
  readonly lines: ReadonlyArray<string>;
}

export interface PatchFile {
  /** Repository-relative path after the change. */
  readonly path: string;
  readonly created: boolean;
  readonly deleted: boolean;
  /** `new file mode` or `deleted file mode`, which reverting a creation needs. */
  readonly modeLine: string | null;
  readonly hunks: ReadonlyArray<PatchHunk>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Git's C-style quoting, used for paths with unusual characters. */
const unquote = (value: string): string => {
  if (!value.startsWith('"')) return value;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      bytes.push(...encoder.encode(char));
      continue;
    }
    const next = value[index + 1]!;
    if (/[0-7]/.test(next)) {
      bytes.push(Number.parseInt(value.slice(index + 1, index + 4), 8));
      index += 3;
      continue;
    }
    bytes.push(
      ({ n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 } as Record<string, number>)[next] ??
        next.charCodeAt(0),
    );
    index += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const quote = (value: string): string =>
  /["\\\t\n\r]/.test(value)
    ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`
    : value;

const sidePath = (line: string, prefix: "--- " | "+++ ", side: "a/" | "b/"): string | null => {
  const raw = unquote(line.slice(prefix.length).replace(/\t$/, ""));
  if (raw === "/dev/null") return null;
  return raw.startsWith(side) ? raw.slice(side.length) : raw;
};

const hunkId = (path: string, header: string, lines: ReadonlyArray<string>) =>
  NodeCrypto.createHash("sha256")
    .update(`${path}\n${header}\n${lines.join("\n")}`)
    .digest("hex")
    .slice(0, 20);

/** Text files of a `git diff --patch` with a/ and b/ prefixes. Incomplete trailing hunks drop. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  const lines = patch.split("\n");
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]!.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    index += 1;
    let oldPath: string | null = null;
    let newPath: string | null = null;
    let modeLine: string | null = null;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) {
      const line = lines[index]!;
      if (line.startsWith("@@")) break;
      if (line.startsWith("new file mode ") || line.startsWith("deleted file mode ")) {
        modeLine = line;
      } else if (line.startsWith("--- ")) {
        oldPath = sidePath(line, "--- ", "a/");
      } else if (line.startsWith("+++ ")) {
        newPath = sidePath(line, "+++ ", "b/");
      }
      index += 1;
    }
    const hunks: PatchHunk[] = [];
    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const header = lines[index]!;
      const match = HUNK_HEADER.exec(header);
      index += 1;
      if (match === null) break;
      let oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
      let newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      const body: string[] = [];
      while (index < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const line = lines[index]!;
        const kind = line[0];
        if (kind === " ") {
          oldRemaining -= 1;
          newRemaining -= 1;
        } else if (kind === "-") oldRemaining -= 1;
        else if (kind === "+") newRemaining -= 1;
        else if (kind !== "\\") break;
        body.push(line);
        index += 1;
      }
      while (index < lines.length && lines[index]!.startsWith("\\")) {
        body.push(lines[index]!);
        index += 1;
      }
      if (oldRemaining !== 0 || newRemaining !== 0) break;
      const path = newPath ?? oldPath ?? "";
      hunks.push({
        id: hunkId(path, header, body),
        header,
        newStart: Number(match[3]),
        lines: body,
      });
    }
    const path = newPath ?? oldPath;
    if (path !== null && hunks.length > 0) {
      files.push({
        path,
        created: oldPath === null,
        deleted: newPath === null,
        modeLine,
        hunks,
      });
    }
  }
  return files;
}

const image = (hunk: PatchHunk, side: "old" | "new") =>
  hunk.lines
    .filter((line) => line[0] === " " || line[0] === (side === "new" ? "+" : "-"))
    .map((line) => line.slice(1));

/**
 * Where one side of the hunk sits in `fileLines` now: the 0-based index nearest its original
 * place. `new` finds the agent's result, `old` what it replaced.
 */
export function locateHunk(
  hunk: PatchHunk,
  fileLines: ReadonlyArray<string>,
  side: "old" | "new" = "new",
): number | null {
  const lines = image(hunk, side);
  if (lines.length === 0) return null;
  const last = fileLines.length - lines.length;
  const expected = Math.min(Math.max(hunk.newStart - 1, 0), Math.max(last, 0));
  const matchesAt = (start: number) =>
    lines.every((line, offset) => fileLines[start + offset] === line);
  for (let distance = 0; distance <= Math.max(expected, last - expected); distance += 1) {
    if (expected - distance >= 0 && matchesAt(expected - distance)) return expected - distance;
    if (distance > 0 && expected + distance <= last && matchesAt(expected + distance)) {
      return expected + distance;
    }
  }
  return null;
}

/** Changed runs in the hunk, placed at `start`, the 0-based line its result begins on now. */
export function hunkChanges(
  hunk: PatchHunk,
  start: number,
  lineCount: number,
): ReadonlyArray<IdeAgentChange> {
  const changes: IdeAgentChange[] = [];
  let line = start;
  let index = 0;
  while (index < hunk.lines.length) {
    const kind = hunk.lines[index]![0];
    if (kind !== "-" && kind !== "+") {
      if (kind === " ") line += 1;
      index += 1;
      continue;
    }
    let removed = 0;
    let added = 0;
    while (index < hunk.lines.length && hunk.lines[index]![0] !== " ") {
      if (hunk.lines[index]![0] === "-") removed += 1;
      if (hunk.lines[index]![0] === "+") added += 1;
      index += 1;
    }
    changes.push({
      kind: added === 0 ? "removed" : removed === 0 ? "added" : "modified",
      line: Math.min(line, Math.max(lineCount - 1, 0)) + 1,
      count: added,
    });
    line += added;
  }
  return changes;
}

/**
 * A patch holding one hunk, which `git apply` can take forward or in reverse. `at` places it at
 * the 0-based line it sits on now: Git pins a hunk numbered from line 1 to the file's start.
 */
export function singleHunkPatch(file: PatchFile, hunk: PatchHunk, at: number): string {
  const header =
    file.created || file.deleted
      ? hunk.header
      : `@@ -${at + 1},${image(hunk, "old").length} +${at + 1},${image(hunk, "new").length} @@`;
  return [
    `diff --git ${quote(`a/${file.path}`)} ${quote(`b/${file.path}`)}`,
    ...(file.modeLine === null ? [] : [file.modeLine]),
    file.created ? "--- /dev/null" : `--- ${quote(`a/${file.path}`)}`,
    file.deleted ? "+++ /dev/null" : `+++ ${quote(`b/${file.path}`)}`,
    header,
    ...hunk.lines,
    "",
  ].join("\n");
}
