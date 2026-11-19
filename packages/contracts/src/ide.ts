import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** A draft thread is not on the server yet, so the project folder stands in for it. */
export const IdeOpenInput = Schema.Struct({ threadId: ThreadId, projectId: ProjectId });
export type IdeOpenInput = typeof IdeOpenInput.Type;

export const IdeOpenResult = Schema.Struct({
  /** Server-relative URL of the editor for the thread's folder. It carries a capability. */
  path: Schema.String,
});
export type IdeOpenResult = typeof IdeOpenResult.Type;

export const IdeTokenColorRule = Schema.Struct({
  scope: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  settings: Schema.Struct({
    foreground: Schema.optional(Schema.String),
    fontStyle: Schema.optional(Schema.String),
  }),
});
export type IdeTokenColorRule = typeof IdeTokenColorRule.Type;

/** The client's resolved theme, translated into VS Code's color and token vocabulary. */
export const IdeThemeInput = Schema.Struct({
  appearance: Schema.Literals(["light", "dark"]),
  colors: Schema.Record(Schema.String, Schema.String),
  tokenColors: Schema.Array(IdeTokenColorRule),
});
export type IdeThemeInput = typeof IdeThemeInput.Type;

export class IdeError extends Schema.TaggedError<IdeError>()("IdeError", {
  reason: Schema.Literals([
    "unsupported_platform",
    "download_failed",
    "install_failed",
    "start_failed",
    "folder_missing",
    "change_unavailable",
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** A stable git-lane color per thread, so an agent keeps its color everywhere it shows. */
export function threadLane(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) >>> 0;
  }
  return hash % 8;
}

export function threadInitial(title: string): string {
  return /[\p{L}\p{N}]/u.exec(title)?.[0]?.toUpperCase() ?? "•";
}

const FilePath = Schema.String.check(Schema.isNonEmpty());

export const IdeAgentChange = Schema.Struct({
  kind: Schema.Literals(["added", "modified", "removed"]),
  /** 1-based line in the file as it is now. A removal marks the line that follows it. */
  line: PositiveInt,
  count: NonNegativeInt,
});
export type IdeAgentChange = typeof IdeAgentChange.Type;

export const IdeAgentHunk = Schema.Struct({
  /** Hash of the hunk's text: a stale id cannot apply to a newer turn. */
  id: TrimmedNonEmptyString,
  changes: Schema.Array(IdeAgentChange),
});
export type IdeAgentHunk = typeof IdeAgentHunk.Type;

export const IdeAgentFile = Schema.Struct({
  /** Absolute path on the environment. */
  path: FilePath,
  /** Hunks whose result is still in the file; edited or reverted ones drop out. */
  hunks: Schema.Array(IdeAgentHunk),
});
export type IdeAgentFile = typeof IdeAgentFile.Type;

export const IdeAgentThread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  initial: Schema.String,
  lane: NonNegativeInt,
  turn: PositiveInt,
});
export type IdeAgentThread = typeof IdeAgentThread.Type;

/** What the open thread's agent changed in its latest turn, for the editor's margin. */
export const IdeAgentChanges = Schema.Struct({
  version: Schema.String,
  thread: Schema.NullOr(IdeAgentThread),
  files: Schema.Array(IdeAgentFile),
});
export type IdeAgentChanges = typeof IdeAgentChanges.Type;

export const IdeAgentChangesInput = Schema.Struct({
  folder: FilePath,
  /** Waits until the feed moves past this version, or a while passes. */
  after: Schema.optional(Schema.String),
});
export type IdeAgentChangesInput = typeof IdeAgentChangesInput.Type;

export const IdeAgentHunkActionInput = Schema.Struct({
  folder: FilePath,
  threadId: ThreadId,
  turn: PositiveInt,
  path: FilePath,
  hunkId: TrimmedNonEmptyString,
  /** Revert takes the hunk out of the file; reapply puts it back. */
  action: Schema.Literals(["revert", "reapply"]),
});
export type IdeAgentHunkActionInput = typeof IdeAgentHunkActionInput.Type;
