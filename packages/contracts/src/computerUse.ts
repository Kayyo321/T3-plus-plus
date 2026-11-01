import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ComputerUseTarget = Schema.Literals(["browser", "virtual-display"]);
export type ComputerUseTarget = typeof ComputerUseTarget.Type;

export const ComputerUseStatus = Schema.Literals(["off", "active", "taken-over"]);
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseSensitivity = Schema.Literals([
  "credentials",
  "purchase",
  "message",
  "delete",
]);
export type ComputerUseSensitivity = typeof ComputerUseSensitivity.Type;

export const ComputerUseAction = Schema.Literals([
  "click",
  "double_click",
  "type",
  "key",
  "scroll",
  "navigate",
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export const ComputerUseActInput = Schema.Struct({
  action: ComputerUseAction,
  intent: TrimmedNonEmptyString.check(Schema.isMaxLength(300)).annotate({
    description: "What this step does, in plain words. The user reads it in the step log.",
  }),
  sensitivity: Schema.optional(ComputerUseSensitivity).annotate({
    description: "Say so if this step buys, sends, or deletes. It then needs the user's approval.",
  }),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  locator: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Browser only: a locator from `computer_status` or `preview_snapshot`.",
  }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(10_000))),
  key: Schema.optional(TrimmedNonEmptyString).annotate({ description: "Such as Enter." }),
  deltaX: Schema.optional(Schema.Finite),
  deltaY: Schema.optional(Schema.Finite),
  url: Schema.optional(TrimmedNonEmptyString).annotate({ description: "Browser only." }),
});
export type ComputerUseActInput = typeof ComputerUseActInput.Type;

export const ComputerUseActResult = Schema.Struct({
  stepId: TrimmedNonEmptyString,
  result: Schema.String,
});
export type ComputerUseActResult = typeof ComputerUseActResult.Type;

export const ComputerUseApproval = Schema.Struct({
  id: TrimmedNonEmptyString,
  action: ComputerUseAction,
  intent: Schema.String,
  sensitivity: ComputerUseSensitivity,
  requestedAt: IsoDateTime,
});
export type ComputerUseApproval = typeof ComputerUseApproval.Type;

export const ComputerUseState = Schema.Struct({
  threadId: ThreadId,
  status: ComputerUseStatus,
  target: Schema.NullOr(ComputerUseTarget),
  startedAt: Schema.NullOr(IsoDateTime),
  /** The X display of a virtual display, for starting apps on it. */
  display: Schema.NullOr(Schema.String),
  pendingApproval: Schema.NullOr(ComputerUseApproval),
});
export type ComputerUseState = typeof ComputerUseState.Type;

export const ComputerUseStepStatus = Schema.Literals(["ok", "failed", "refused", "denied"]);
export type ComputerUseStepStatus = typeof ComputerUseStepStatus.Type;

export const ComputerUseStep = Schema.Struct({
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  sequence: Schema.Int,
  at: IsoDateTime,
  target: ComputerUseTarget,
  action: Schema.Union([ComputerUseAction, Schema.Literal("screenshot")]),
  intent: Schema.String,
  sensitivity: Schema.NullOr(ComputerUseSensitivity),
  status: ComputerUseStepStatus,
  result: Schema.NullOr(Schema.String),
  hasScreenshot: Schema.Boolean,
});
export type ComputerUseStep = typeof ComputerUseStep.Type;

/** What a watcher sees: re-sent on every change, with only the newest steps. */
export const COMPUTER_USE_RECENT_STEPS = 20;

export const ComputerUseSnapshot = Schema.Struct({
  state: ComputerUseState,
  recentSteps: Schema.Array(ComputerUseStep),
});
export type ComputerUseSnapshot = typeof ComputerUseSnapshot.Type;

export const ComputerUseThreadInput = Schema.Struct({ threadId: ThreadId });
export type ComputerUseThreadInput = typeof ComputerUseThreadInput.Type;

export const ComputerUseStartInput = Schema.Struct({
  threadId: ThreadId,
  target: ComputerUseTarget,
});
export type ComputerUseStartInput = typeof ComputerUseStartInput.Type;

export const ComputerUseAnswerApprovalInput = Schema.Struct({
  threadId: ThreadId,
  approvalId: TrimmedNonEmptyString,
  approved: Schema.Boolean,
});
export type ComputerUseAnswerApprovalInput = typeof ComputerUseAnswerApprovalInput.Type;

export const COMPUTER_USE_STEP_PAGE_SIZE = 50;

export const ComputerUseListStepsInput = Schema.Struct({
  threadId: ThreadId,
  beforeSequence: Schema.optional(Schema.Int),
});
export type ComputerUseListStepsInput = typeof ComputerUseListStepsInput.Type;

export const ComputerUseListStepsResult = Schema.Struct({
  steps: Schema.Array(ComputerUseStep),
  hasMore: Schema.Boolean,
});
export type ComputerUseListStepsResult = typeof ComputerUseListStepsResult.Type;

export const ComputerUseScreenshotInput = Schema.Struct({
  threadId: ThreadId,
  stepId: TrimmedNonEmptyString,
});
export type ComputerUseScreenshotInput = typeof ComputerUseScreenshotInput.Type;

export const ComputerUseScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
});
export type ComputerUseScreenshot = typeof ComputerUseScreenshot.Type;

export const ComputerUseSupportResult = Schema.Struct({
  /** Off until someone turns computer use on in Settings. */
  enabled: Schema.Boolean,
  virtualDisplay: Schema.Struct({
    available: Schema.Boolean,
    /** Programs to install before a virtual display can run here. */
    missing: Schema.Array(Schema.String),
  }),
});
export type ComputerUseSupportResult = typeof ComputerUseSupportResult.Type;

export const ComputerUseErrorCode = Schema.Literals([
  "off",
  "taken_over",
  "refused",
  "denied",
  "unavailable",
  "failed",
]);
export type ComputerUseErrorCode = typeof ComputerUseErrorCode.Type;

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  code: ComputerUseErrorCode,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * How each provider reaches the screen. No provider's harness hands T3++ a native computer-use
 * loop, so `adapter-tool` is the T3 MCP tools; drivers that cannot reach them are absent.
 */
export type ComputerUseProviderSupport = "adapter-tool";

const COMPUTER_USE_SUPPORT: Readonly<Record<string, ComputerUseProviderSupport>> = {
  claudeAgent: "adapter-tool",
  codex: "adapter-tool",
  cursor: "adapter-tool",
  opencode: "adapter-tool",
  grok: "adapter-tool",
  acpRegistry: "adapter-tool",
  pi: "adapter-tool",
  muse: "adapter-tool",
  fx: "adapter-tool",
};

/** @public */
export const computerUseSupportForDriver = (driver: string): ComputerUseProviderSupport | null =>
  COMPUTER_USE_SUPPORT[driver] ?? null;
