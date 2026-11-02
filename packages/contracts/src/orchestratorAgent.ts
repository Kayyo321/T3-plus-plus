import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { chatModeEnforcementForDriver } from "./providerPolicy.ts";
import type { ServerProvider } from "./server.ts";

export const OrchestratorDomain = Schema.Literals([
  "conversations",
  "sessions",
  "projects",
  "workspace-ui",
  "git",
  "tasks",
  "supervision",
  "settings",
  "remote-control",
  "computer-use",
]);
export type OrchestratorDomain = typeof OrchestratorDomain.Type;

/** `off` refuses reads too. `ask` runs reads and asks before every change. */
export const OrchestratorGrantLevel = Schema.Literals(["off", "ask", "allow"]);
export type OrchestratorGrantLevel = typeof OrchestratorGrantLevel.Type;

export const OrchestratorToolEffect = Schema.Literals(["read", "write", "external", "destructive"]);
export type OrchestratorToolEffect = typeof OrchestratorToolEffect.Type;

/** Supervision steps are granted one by one, since a nudge and a stop differ in kind. */
export const OrchestratorSupervisionAction = Schema.Literals([
  "message",
  "answer",
  "interrupt",
  "restart",
  "stop",
  "rewind",
]);
export type OrchestratorSupervisionAction = typeof OrchestratorSupervisionAction.Type;

export const OrchestratorGrants = Schema.Struct({
  domains: Schema.Record(OrchestratorDomain, OrchestratorGrantLevel),
  /** Pushes, PRs, remote sharing: anything that leaves the machine, under any domain level. */
  askBeforeExternal: Schema.Boolean,
  /** Deletes and hard rollbacks, under any domain level. */
  askBeforeDestructive: Schema.Boolean,
  supervisionActions: Schema.Record(OrchestratorSupervisionAction, OrchestratorGrantLevel),
});
export type OrchestratorGrants = typeof OrchestratorGrants.Type;

export const DEFAULT_ORCHESTRATOR_GRANTS: OrchestratorGrants = {
  domains: {
    conversations: "allow",
    sessions: "allow",
    projects: "allow",
    "workspace-ui": "allow",
    git: "allow",
    tasks: "allow",
    supervision: "allow",
    settings: "ask",
    "remote-control": "ask",
    "computer-use": "off",
  },
  askBeforeExternal: true,
  askBeforeDestructive: true,
  supervisionActions: {
    message: "allow",
    answer: "ask",
    interrupt: "ask",
    restart: "ask",
    stop: "ask",
    rewind: "ask",
  },
};

export const OrchestratorBrainBlockReason = Schema.Literals([
  "provider_removed",
  "provider_disabled",
  "not_installed",
  "unavailable",
  "cannot_enforce_tools",
  "signed_out",
  "quota_exhausted",
  "model_retired",
  "provider_error",
]);
export type OrchestratorBrainBlockReason = typeof OrchestratorBrainBlockReason.Type;

export const OrchestratorBrainAvailability = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unconfigured") }),
  Schema.Struct({ status: Schema.Literal("available") }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    reason: OrchestratorBrainBlockReason,
    message: TrimmedNonEmptyString,
  }),
]);
export type OrchestratorBrainAvailability = typeof OrchestratorBrainAvailability.Type;

const blocked = (reason: OrchestratorBrainBlockReason, message: string) =>
  ({ status: "blocked", reason, message }) as const;

/**
 * Never suggests another provider: choosing one is the user's call, since it can spend money or
 * send context somewhere they did not pick.
 */
export const orchestratorBrainAvailability = (
  brain: ModelSelection | null,
  providers: ReadonlyArray<ServerProvider>,
): OrchestratorBrainAvailability => {
  if (brain === null) return { status: "unconfigured" };
  const provider = providers.find((candidate) => candidate.instanceId === brain.instanceId);
  if (provider === undefined) {
    return blocked("provider_removed", `The provider ${brain.instanceId} is no longer configured.`);
  }
  const name = provider.displayName ?? provider.instanceId;
  if (!provider.enabled) return blocked("provider_disabled", `${name} is turned off in Settings.`);
  if (!provider.installed) return blocked("not_installed", `${name} is not installed here.`);
  if (provider.availability === "unavailable") {
    return blocked("unavailable", provider.unavailableReason ?? `${name} is unavailable.`);
  }
  // The dev Replay provider plays recorded turns, so it has no tools to withhold.
  if (
    chatModeEnforcementForDriver(provider.driver) !== "enforced" &&
    provider.instanceId !== "devReplay"
  ) {
    return blocked(
      "cannot_enforce_tools",
      `${name} cannot run without file and shell tools, so its grants could not hold.`,
    );
  }
  if (provider.auth.status === "unauthenticated") {
    return blocked("signed_out", `${name} is signed out.`);
  }
  if (provider.usageLimits?.windows.some((window) => window.usedPercent >= 100) === true) {
    return blocked("quota_exhausted", `${name} has used up its current quota.`);
  }
  if (provider.status === "error") {
    return blocked("provider_error", provider.message ?? `${name} reports an error.`);
  }
  if (provider.models.length > 0 && !provider.models.some((model) => model.slug === brain.model)) {
    return blocked("model_retired", `${name} no longer offers ${brain.model}.`);
  }
  return { status: "available" };
};

export const OrchestratorApprovalId = TrimmedNonEmptyString.pipe(
  Schema.brand("OrchestratorApprovalId"),
);
export type OrchestratorApprovalId = typeof OrchestratorApprovalId.Type;

export const OrchestratorApproval = Schema.Struct({
  id: OrchestratorApprovalId,
  tool: TrimmedNonEmptyString,
  domain: OrchestratorDomain,
  effect: OrchestratorToolEffect,
  /** Plain words for the prompt, built from the tool and its target. */
  summary: Schema.String,
  requestedAt: IsoDateTime,
});
export type OrchestratorApproval = typeof OrchestratorApproval.Type;

export const SupervisionThresholds = Schema.Struct({
  /** A run this long fires `long_running`. */
  maxRunMinutes: NonNegativeInt,
  silenceMinutes: NonNegativeInt,
  /** The same action fingerprint this many times in a row fires `loop`. */
  repeatedActionLimit: NonNegativeInt,
  retryLimit: NonNegativeInt,
  waitingMinutes: NonNegativeInt,
  nudgeCap: NonNegativeInt,
  cooldownMinutes: NonNegativeInt,
});
export type SupervisionThresholds = typeof SupervisionThresholds.Type;

export const DEFAULT_SUPERVISION_THRESHOLDS: SupervisionThresholds = {
  maxRunMinutes: 45,
  silenceMinutes: 10,
  repeatedActionLimit: 4,
  retryLimit: 3,
  waitingMinutes: 30,
  nudgeCap: 3,
  cooldownMinutes: 10,
};

/** Tighter thresholds and more nudges, scaled from the owner's own, plus a more hands-on review. */
export const supervisionThresholdsFor = (
  mode: SupervisionMode,
  base: SupervisionThresholds,
): SupervisionThresholds =>
  mode !== "aggressive"
    ? base
    : {
        maxRunMinutes: Math.ceil(base.maxRunMinutes / 3),
        silenceMinutes: Math.ceil(base.silenceMinutes / 2),
        repeatedActionLimit: Math.max(2, base.repeatedActionLimit - 1),
        retryLimit: Math.max(1, base.retryLimit - 1),
        waitingMinutes: Math.ceil(base.waitingMinutes / 3),
        nudgeCap: base.nudgeCap * 2,
        cooldownMinutes: Math.ceil(base.cooldownMinutes / 3),
      };

export const SupervisionSignalKind = Schema.Literals([
  "long_running",
  "silent",
  "loop",
  "retries",
  "long_wait",
  "over_budget",
  "child_blocking",
]);
export type SupervisionSignalKind = typeof SupervisionSignalKind.Type;

/** Off means "let it run". */
export const SupervisionMode = Schema.Literals(["off", "modest", "aggressive"]);
export type SupervisionMode = typeof SupervisionMode.Type;

export const SUPERVISION_MODES = SupervisionMode.literals;
export const DEFAULT_SUPERVISION_MODE: SupervisionMode = "modest";

export const SUPERVISION_MODE_INFO: Record<
  SupervisionMode,
  { readonly label: string; readonly description: string }
> = {
  off: { label: "Off", description: "No automatic reviews." },
  modest: { label: "Modest", description: "Steps in when a conversation looks stuck." },
  aggressive: {
    label: "Aggressive",
    description: "Reviews sooner and steps in more often. Uses more of the orchestrator's model.",
  },
};

/** Where a thread's effective mode came from: project, then thread, then the global default. */
export const SupervisionModeSource = Schema.Literals(["project", "thread", "default"]);
export type SupervisionModeSource = typeof SupervisionModeSource.Type;

export interface ResolvedSupervisionMode {
  readonly mode: SupervisionMode;
  readonly source: SupervisionModeSource;
}

export const SupervisionThreadState = Schema.Struct({
  /** The thread's own choice. Null follows its project and the global default. */
  mode: Schema.NullOr(SupervisionMode),
  reviews: NonNegativeInt,
  nudges: Schema.optional(NonNegativeInt),
  lastNudgeAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  lastReviewAt: Schema.NullOr(IsoDateTime),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  /** The run these counts belong to; a new run starts them over. */
  runId: Schema.NullOr(RunId),
  /** The cap was reached and the owner has been told. */
  escalatedAt: Schema.NullOr(IsoDateTime),
});
export type SupervisionThreadState = typeof SupervisionThreadState.Type;

export const SupervisionSetThreadInput = Schema.Struct({
  threadId: ThreadId,
  /** Null clears the thread's choice. */
  mode: Schema.NullOr(SupervisionMode),
});
export type SupervisionSetThreadInput = typeof SupervisionSetThreadInput.Type;

export const SupervisionResolvedThreadState = Schema.Struct({
  ...SupervisionThreadState.fields,
  effectiveMode: SupervisionMode,
  modeSource: SupervisionModeSource,
});
export type SupervisionResolvedThreadState = typeof SupervisionResolvedThreadState.Type;

export const SupervisionGetThreadInput = Schema.Struct({ threadId: ThreadId });
export type SupervisionGetThreadInput = typeof SupervisionGetThreadInput.Type;

export const SupervisionState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("active"), watching: NonNegativeInt }),
  Schema.Struct({ status: Schema.Literal("paused"), reason: TrimmedNonEmptyString }),
]);
export type SupervisionState = typeof SupervisionState.Type;

export const OrchestratorNeedsAttention = Schema.Struct({
  status: Schema.Literal("needs_attention"),
  reason: TrimmedNonEmptyString,
});

/** The reply that says there is nothing to tell the owner. */
export const ORCHESTRATOR_SILENT_REPLY = "(silent)";
/** A line holding only this splits the orchestrator's reply into separate messages. */
export const ORCHESTRATOR_MESSAGE_BREAK = "---";

export const OrchestratorReactionEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(16));

export const OrchestratorReaction = Schema.Struct({
  emoji: OrchestratorReactionEmoji,
  by: Schema.Literals(["owner", "orchestrator"]),
});
export type OrchestratorReaction = typeof OrchestratorReaction.Type;

export const OrchestratorReactInput = Schema.Struct({
  /** The turn item id of the message, as clients see it. */
  messageId: TrimmedNonEmptyString,
  emoji: OrchestratorReactionEmoji,
  /** The start of the message, so the orchestrator can tell what was reacted to. */
  excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
});
export type OrchestratorReactInput = typeof OrchestratorReactInput.Type;

export const OrchestratorMarkReadInput = Schema.Struct({ through: IsoDateTime });
export type OrchestratorMarkReadInput = typeof OrchestratorMarkReadInput.Type;

export const OrchestratorSnapshot = Schema.Struct({
  brain: Schema.NullOr(ModelSelection),
  needsAttention: Schema.optional(Schema.NullOr(OrchestratorNeedsAttention)),
  availability: OrchestratorBrainAvailability,
  threadId: Schema.NullOr(ThreadId),
  grants: OrchestratorGrants,
  thresholds: SupervisionThresholds,
  supervision: SupervisionState,
  pendingApprovals: ForwardCompatibleArray(OrchestratorApproval),
  reactions: Schema.optional(Schema.Record(Schema.String, Schema.Array(OrchestratorReaction))),
  ownerReadAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** The ISO time of the orchestrator's latest reply; null while it is silent or absent. */
  latestMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Each thread's own choice, so every client sees a change at once. */
  supervisionThreadModes: Schema.optional(Schema.Record(Schema.String, SupervisionMode)),
  /** The thread a review turn is working on right now. */
  supervisionReviewing: Schema.optional(Schema.NullOr(ThreadId)),
});
export type OrchestratorSnapshot = typeof OrchestratorSnapshot.Type;

/** What the owner is looking at, so "this conversation" means something. */
export const OrchestratorFocus = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  projectId: Schema.optional(ProjectId),
  workspaceName: Schema.optional(Schema.String),
  layoutName: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
});
export type OrchestratorFocus = typeof OrchestratorFocus.Type;

export const OrchestratorSetBrainInput = Schema.Struct({
  brain: ModelSelection,
  /** A run in progress is interrupted first. Without it the change is refused and says so. */
  interruptRun: Schema.optional(Schema.Boolean),
});
export type OrchestratorSetBrainInput = typeof OrchestratorSetBrainInput.Type;

export const OrchestratorSetGrantsInput = Schema.Struct({ grants: OrchestratorGrants });
export const OrchestratorSetThresholdsInput = Schema.Struct({ thresholds: SupervisionThresholds });

export const OrchestratorSendInput = Schema.Struct({
  commandId: CommandId,
  text: TrimmedNonEmptyString,
  focus: Schema.optional(OrchestratorFocus),
});
export type OrchestratorSendInput = typeof OrchestratorSendInput.Type;

export const OrchestratorSendResult = Schema.Struct({ threadId: ThreadId });
export type OrchestratorSendResult = typeof OrchestratorSendResult.Type;

export const OrchestratorAnswerApprovalInput = Schema.Struct({
  id: OrchestratorApprovalId,
  allow: Schema.Boolean,
});
export type OrchestratorAnswerApprovalInput = typeof OrchestratorAnswerApprovalInput.Type;

export const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "preview",
  "device",
  "terminal",
  "pull-request",
  "pull-requests",
  "side-chat",
  "git-graph",
  "documents",
  "teamwork",
  "document",
  "computer-use",
] as const;
export const RightPanelKind = Schema.Literals(RIGHT_PANEL_KINDS);
export type RightPanelKind = typeof RightPanelKind.Type;

/** A page of the app's settings, by the last part of its route. */
export const OrchestratorSettingsPage = Schema.Literals([
  "projects",
  "general",
  "diagnostics",
  "appearance",
  "chat",
  "diffs",
  "keybindings",
  "snap-shot",
  "layouts",
  "providers",
  "threads",
  "browser",
  "devices",
  "scheduled-tasks",
  "source-control",
  "worktrees",
  "connections",
  "access",
  "secrets",
  "workspaces",
  "maintenance",
  "labs",
  "about",
  "archived",
]);
export type OrchestratorSettingsPage = typeof OrchestratorSettingsPage.Type;

/** Requests the owner's clients act on, so the UI shows the orchestrator's hands. */
export const OrchestratorUiDirective = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open-panel"), panel: RightPanelKind }),
  Schema.Struct({ type: Schema.Literal("close-panel"), panel: RightPanelKind }),
  Schema.Struct({
    type: Schema.Literal("open-settings"),
    page: Schema.optional(OrchestratorSettingsPage),
  }),
  Schema.Struct({ type: Schema.Literal("apply-layout"), name: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("open-thread"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("split-thread"), threadId: ThreadId }),
  /** The orchestrator needs the owner: a toast everywhere, a push where the platform allows. */
  Schema.Struct({
    type: Schema.Literal("escalate"),
    threadId: Schema.optional(ThreadId),
    message: TrimmedNonEmptyString,
  }),
]);
export type OrchestratorUiDirective = typeof OrchestratorUiDirective.Type;

export const OrchestratorErrorReason = Schema.Literals([
  "blocked",
  "run_active",
  "approval_gone",
  "store_failed",
  "start_failed",
]);

export class OrchestratorAgentError extends Schema.TaggedError<OrchestratorAgentError>()(
  "OrchestratorAgentError",
  {
    reason: OrchestratorErrorReason,
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail ?? `The orchestrator could not do that (${this.reason}).`;
  }
}
