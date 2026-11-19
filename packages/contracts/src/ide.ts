import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

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
  ]),
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
