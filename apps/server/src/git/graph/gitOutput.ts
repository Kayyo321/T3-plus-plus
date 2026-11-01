import { isAgentCoAuthor } from "@t3tools/source-control-core/server/mergeMessage";
import {
  GIT_GRAPH_MAX_HUNKS,
  type GitGraphBranch,
  type GitGraphChangedFile,
  type GitGraphCommitRisk,
  type GitGraphRiskReason,
  type GitGraphRowRef,
  type GitGraphStash,
} from "@t3tools/contracts";

const FIELD = "\u001f";
const RECORD = "\u001e";

export const LOG_FORMAT = [
  "%H",
  "%P",
  "%an",
  "%at",
  "%ct",
  "%D",
  "%s",
  "%(trailers:key=Co-authored-by,valueonly,separator=%x1d)",
]
  .join("%x1f")
  .concat("%x1e");

export interface LogCommit {
  readonly sha: string;
  readonly parents: ReadonlyArray<string>;
  readonly authorName: string;
  readonly authoredAt: number;
  readonly committedAt: number;
  readonly refs: ReadonlyArray<GitGraphRowRef>;
  readonly subject: string;
  readonly creditsAgent: boolean;
}

function parseDecoration(decoration: string): ReadonlyArray<GitGraphRowRef> {
  if (decoration.trim().length === 0) return [];
  return decoration.split(", ").flatMap((entry): ReadonlyArray<GitGraphRowRef> => {
    const pointed = /^HEAD -> refs\/heads\/(.+)$/u.exec(entry);
    if (pointed) return [{ kind: "head", name: pointed[1]! }];
    if (entry === "HEAD") return [{ kind: "head", name: "HEAD" }];
    const tag = /^tag: refs\/tags\/(.+)$/u.exec(entry);
    if (tag) return [{ kind: "tag", name: tag[1]! }];
    const branch = /^refs\/heads\/(.+)$/u.exec(entry);
    if (branch) return [{ kind: "branch", name: branch[1]! }];
    const remote = /^refs\/remotes\/(.+)$/u.exec(entry);
    if (remote && !remote[1]!.endsWith("/HEAD")) return [{ kind: "remote", name: remote[1]! }];
    return [];
  });
}

const creditsAgent = (trailers: string) =>
  trailers.split("\u001d").some((credit) => {
    const match = /^(.*?)\s*<([^<>]+)>\s*$/u.exec(credit.trim());
    return match !== null && isAgentCoAuthor(match[1]!, match[2]!);
  });

export function parseLog(stdout: string): ReadonlyArray<LogCommit> {
  return stdout.split(RECORD).flatMap((record) => {
    const fields = record.replace(/^\s+/u, "").split(FIELD);
    if (fields.length < 8) return [];
    const [sha, parents, authorName, authoredAt, committedAt, decoration, subject, trailers] =
      fields;
    return [
      {
        sha: sha!,
        parents: parents!.length === 0 ? [] : parents!.split(" "),
        authorName: authorName!,
        authoredAt: Number(authoredAt),
        committedAt: Number(committedAt),
        refs: parseDecoration(decoration!),
        subject: subject!,
        creditsAgent: creditsAgent(trailers!),
      },
    ];
  });
}

/** The name a lane started by this commit should keep across reloads. */
export const tipName = (commit: LogCommit) =>
  commit.refs.find((ref) => ref.kind === "head" && ref.name !== "HEAD")?.name ??
  commit.refs.find((ref) => ref.kind === "branch")?.name ??
  commit.refs.find((ref) => ref.kind === "remote")?.name ??
  null;

export function parseBranches(stdout: string): ReadonlyArray<GitGraphBranch> {
  return stdout.split("\n").flatMap((line) => {
    const [name, sha, upstream, track, head] = line.split("\u0000");
    if (!name || !sha) return [];
    const ahead = /ahead (\d+)/u.exec(track ?? "")?.[1];
    const behind = /behind (\d+)/u.exec(track ?? "")?.[1];
    return [
      {
        name,
        sha,
        upstream: upstream || null,
        ahead: Number(ahead ?? 0),
        behind: Number(behind ?? 0),
        isHead: head === "*",
      },
    ];
  });
}

export function parseWorktrees(stdout: string) {
  const entries: Array<{ path: string; sha: string | null; branch: string | null }> = [];
  for (const line of stdout.split("\u0000")) {
    if (line.startsWith("worktree ")) {
      entries.push({ path: line.slice("worktree ".length), sha: null, branch: null });
      continue;
    }
    const entry = entries.at(-1);
    if (entry === undefined) continue;
    if (line.startsWith("HEAD ")) entry.sha = line.slice("HEAD ".length);
    if (line.startsWith("branch refs/heads/")) {
      entry.branch = line.slice("branch refs/heads/".length);
    }
  }
  return entries;
}

export function parseStashes(stdout: string): ReadonlyArray<GitGraphStash> {
  return stdout.split(RECORD).flatMap((record) => {
    const [sha, ref, createdAt, message] = record.replace(/^\s+/u, "").split(FIELD);
    if (!sha || !ref) return [];
    return [{ sha, ref, createdAt: Number(createdAt), message: message ?? "" }];
  });
}

/** Porcelain v1 with `-z`: a rename's old path follows it as its own field. */
export function parseStatus(stdout: string): ReadonlyArray<GitGraphChangedFile> {
  const fields = stdout.split("\u0000");
  const files: Array<GitGraphChangedFile> = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const staged = field[0]!;
    const unstaged = field[1]!;
    files.push({ path: field.slice(3), staged, unstaged });
    if (staged === "R" || staged === "C") index += 1;
  }
  return files;
}

export function isConflicted(file: GitGraphChangedFile): boolean {
  const pair = `${file.staged}${file.unstaged}`;
  return pair === "DD" || pair === "AA" || pair.includes("U");
}

export interface FileHunk {
  readonly fileHeader: string;
  readonly header: string;
  readonly body: ReadonlyArray<string>;
}

export function parseHunks(diff: string): {
  readonly hunks: ReadonlyArray<FileHunk>;
  readonly truncated: boolean;
} {
  const hunks: Array<FileHunk> = [];
  let fileHeader: Array<string> = [];
  let current: { header: string; body: Array<string> } | null = null;
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const flush = () => {
    if (current) hunks.push({ fileHeader: fileHeader.join("\n"), ...current });
    current = null;
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      fileHeader = [line];
    } else if (line.startsWith("@@ ")) {
      flush();
      current = { header: line, body: [] };
    } else if (current) {
      current.body.push(line);
    } else {
      fileHeader.push(line);
    }
  }
  flush();
  return {
    hunks: hunks.slice(0, GIT_GRAPH_MAX_HUNKS),
    truncated: hunks.length > GIT_GRAPH_MAX_HUNKS,
  };
}

export const hunkPatch = (hunk: FileHunk) =>
  `${hunk.fileHeader}\n${hunk.header}\n${hunk.body.join("\n")}\n`;

const SENSITIVE_PATHS = [
  /(^|\/)\.env(\.|$)/iu,
  /\.(pem|key|p12|pfx|keystore)$/iu,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/iu,
  /(^|\/)(secrets?|credentials?)(\.|\/|$)/iu,
  /(^|\/)\.github\/workflows\//iu,
  /(^|\/)\.npmrc$/iu,
  /(^|\/)\.ssh\//iu,
];
const LARGE_COMMIT_LINES = 1_000;
const LARGE_COMMIT_FILES = 50;

export function assessRisk(
  sha: string,
  files: ReadonlyArray<{
    readonly path: string;
    readonly additions: number;
    readonly deletions: number;
  }>,
): GitGraphCommitRisk | null {
  const sensitivePaths = files
    .map((file) => file.path)
    .filter((path) => SENSITIVE_PATHS.some((pattern) => pattern.test(path)))
    .slice(0, 10);
  const changedLines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
  const large = changedLines >= LARGE_COMMIT_LINES || files.length >= LARGE_COMMIT_FILES;
  const reasons: ReadonlyArray<GitGraphRiskReason> = [
    ...(sensitivePaths.length > 0 ? (["sensitive-path"] as const) : []),
    ...(large ? (["large-commit"] as const) : []),
  ];
  if (reasons.length === 0) return null;
  return { sha, reasons, sensitivePaths, changedLines, changedFiles: files.length };
}

/** `git log --format=%x1e%H --numstat --no-renames`: binary files report `-`, counted as zero. */
export function parseNumstatLog(stdout: string) {
  return stdout.split(RECORD).flatMap((record) => {
    const [sha, ...lines] = record.trim().split("\n");
    if (!sha) return [];
    return [
      {
        sha,
        files: lines.flatMap((line) => {
          const [additions, deletions, path] = line.split("\t");
          if (additions === undefined || deletions === undefined || path === undefined) return [];
          return [{ path, additions: Number(additions) || 0, deletions: Number(deletions) || 0 }];
        }),
      },
    ];
  });
}
