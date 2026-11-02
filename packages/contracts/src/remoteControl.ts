import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ComputerUseAnswerApprovalInput } from "./computerUse.ts";
import { GuestDisplayName, ThreadGuestMessage } from "./guestShare.ts";
import { GuestThreadModel } from "./guestStream.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadStreamItem } from "./orchestrationV2.ts";
import { OrchestratorBrainAvailability, OrchestratorReaction } from "./orchestratorAgent.ts";
import { ProviderInteractionMode, RuntimeMode, ThreadCapabilityMode } from "./providerPolicy.ts";
import { ServerProvider } from "./server.ts";

/**
 * Remote control is a switch on one conversation. It serves a small page for that conversation to
 * devices that paired with it. Device credentials live only in the `remote_control_*` tables and
 * cookies scoped to `/api/remote`; they are never environment sessions.
 */
export const RemoteControlSwitchId = TrimmedNonEmptyString.pipe(
  Schema.brand("RemoteControlSwitchId"),
);
export type RemoteControlSwitchId = typeof RemoteControlSwitchId.Type;
export const RemoteControlDeviceId = TrimmedNonEmptyString.pipe(
  Schema.brand("RemoteControlDeviceId"),
);
export type RemoteControlDeviceId = typeof RemoteControlDeviceId.Type;
export const RemoteControlPairingId = TrimmedNonEmptyString.pipe(
  Schema.brand("RemoteControlPairingId"),
);
export type RemoteControlPairingId = typeof RemoteControlPairingId.Type;

const REMOTE_CONTROL_ACCESS_LEVELS = ["view", "chat", "approve", "full"] as const;
export const RemoteControlAccessLevel = Schema.Literals(REMOTE_CONTROL_ACCESS_LEVELS);
export type RemoteControlAccessLevel = typeof RemoteControlAccessLevel.Type;
export const REMOTE_CONTROL_DEFAULT_ACCESS_LEVEL: RemoteControlAccessLevel = "chat";

const levelRank = (level: RemoteControlAccessLevel) => REMOTE_CONTROL_ACCESS_LEVELS.indexOf(level);

export const remoteControlLevelAllows = (
  level: RemoteControlAccessLevel,
  required: RemoteControlAccessLevel,
) => levelRank(level) >= levelRank(required);

export const lowerRemoteControlLevel = (
  left: RemoteControlAccessLevel,
  right: RemoteControlAccessLevel,
): RemoteControlAccessLevel => (levelRank(left) <= levelRank(right) ? left : right);

/** Each level's name, and what it adds in the words the owner reads before raising it. */
export const REMOTE_CONTROL_LEVEL_INFO: Record<
  RemoteControlAccessLevel,
  { readonly label: string; readonly description: string }
> = {
  view: { label: "View", description: "Watch the conversation. Nothing else." },
  chat: { label: "Chat", description: "Also send messages to the agent." },
  approve: { label: "Approve", description: "Also answer the agent's approvals and questions." },
  full: { label: "Full", description: "Also stop a run and change how the conversation runs." },
};

/**
 * What a device may change, set one by one. Each is separate from the level, and none works on a
 * plain HTTP route. Only the orchestrator reaches past this conversation, so no level includes it.
 */
export const RemoteControlPermission = Schema.Literals([
  "model",
  "mode",
  "threadMode",
  "rename",
  "stop",
  "orchestrator",
]);
export type RemoteControlPermission = typeof RemoteControlPermission.Type;

export const REMOTE_CONTROL_PERMISSION_INFO: Record<
  RemoteControlPermission,
  { readonly label: string; readonly description: string }
> = {
  model: { label: "Model", description: "Change the model and its effort." },
  mode: { label: "Plan and permissions", description: "Switch plan mode and permission mode." },
  threadMode: { label: "Chat and Code", description: "Switch this conversation's mode." },
  rename: { label: "Rename", description: "Change this conversation's title." },
  stop: { label: "Stop", description: "Stop a run." },
  orchestrator: {
    label: "Orchestrator",
    description: "Message the orchestrator, which can act across this machine.",
  },
};

export const REMOTE_CONTROL_PERMISSIONS = Object.keys(
  REMOTE_CONTROL_PERMISSION_INFO,
) as ReadonlyArray<RemoteControlPermission>;

/** What a level brings when the owner picks it. Full is everything in this conversation. */
export const remoteControlLevelPermissions = (
  level: RemoteControlAccessLevel,
): ReadonlyArray<RemoteControlPermission> =>
  level === "full" ? REMOTE_CONTROL_PERMISSIONS.filter((item) => item !== "orchestrator") : [];

/** How long a device stays signed in. `session` keeps the standard limits below. */
export const RemoteControlDeviceAccess = Schema.Literals(["session", "1d", "7d", "30d", "forever"]);
export type RemoteControlDeviceAccess = typeof RemoteControlDeviceAccess.Type;

export const REMOTE_CONTROL_DEVICE_ACCESS_INFO: Record<
  RemoteControlDeviceAccess,
  { readonly label: string; readonly durationMs: number | null }
> = {
  session: { label: "Standard", durationMs: null },
  "1d": { label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
  "7d": { label: "7 days", durationMs: 7 * 24 * 60 * 60 * 1000 },
  "30d": { label: "30 days", durationMs: 30 * 24 * 60 * 60 * 1000 },
  forever: { label: "Forever", durationMs: null },
};

/**
 * The most a plain HTTP LAN session may do. Traffic on that route can be read and replayed by
 * anyone on the network, so answering approvals and stopping runs need an encrypted route.
 */
export const REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP: RemoteControlAccessLevel = "chat";

export const RemoteControlPairingMode = Schema.Literals(["approve", "code"]);
export type RemoteControlPairingMode = typeof RemoteControlPairingMode.Type;

/** A session ends after this long with no request and no open stream. */
export const REMOTE_CONTROL_INACTIVITY_TTL_MS = 2 * 60 * 60 * 1000;
/** A session ends this long after pairing, however active it is. */
export const REMOTE_CONTROL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** An unused link stops working after this long. */
export const REMOTE_CONTROL_LINK_TTL_MS = 30 * 60 * 1000;
/** How long the owner has to answer a device that asked to join. */
export const REMOTE_CONTROL_PAIRING_TTL_MS = 5 * 60 * 1000;
export const REMOTE_CONTROL_MAX_FAILED_ATTEMPTS = 5;
export const REMOTE_CONTROL_CODE_DIGITS = 8;
export const REMOTE_CONTROL_MAX_DEVICES = 8;

export const RemoteControlRouteKind = Schema.Literals(["relay", "lan", "tailnet", "connect"]);
export type RemoteControlRouteKind = typeof RemoteControlRouteKind.Type;

export const RemoteControlRoute = Schema.Struct({
  kind: RemoteControlRouteKind,
  baseUrl: TrimmedNonEmptyString,
  /** False only for plain HTTP on a local network. */
  encrypted: Schema.Boolean,
});
export type RemoteControlRoute = typeof RemoteControlRoute.Type;

/** A way to reach this machine that is not set up, and what would set it up. */
export const RemoteControlRouteOption = Schema.Struct({
  kind: RemoteControlRouteKind,
  hint: TrimmedNonEmptyString,
});
export type RemoteControlRouteOption = typeof RemoteControlRouteOption.Type;

export const RemoteControlReachability = Schema.Struct({
  /** Best first. Never a loopback address, which would open the wrong machine. */
  routes: Schema.Array(RemoteControlRoute),
  unavailable: Schema.Array(RemoteControlRouteOption),
});
export type RemoteControlReachability = typeof RemoteControlReachability.Type;

export const RemoteControlLinkStatus = Schema.Literals(["ready", "spent", "expired", "locked"]);
export type RemoteControlLinkStatus = typeof RemoteControlLinkStatus.Type;

export const RemoteControlDevice = Schema.Struct({
  id: RemoteControlDeviceId,
  label: GuestDisplayName,
  pairedAt: IsoDateTime,
  access: RemoteControlDeviceAccess,
  /** When the session ends with no further activity, or null when idling never ends it. */
  idleExpiresAt: Schema.NullOr(IsoDateTime),
  /** When the session ends regardless of activity, or null when it never does. */
  expiresAt: Schema.NullOr(IsoDateTime),
  /** Whether this device has the conversation open right now. */
  connected: Schema.Boolean,
  lastAction: Schema.NullOr(TrimmedNonEmptyString),
  lastActionAt: Schema.NullOr(IsoDateTime),
});
export type RemoteControlDevice = typeof RemoteControlDevice.Type;

export const RemoteControlPendingPairing = Schema.Struct({
  id: RemoteControlPairingId,
  deviceLabel: GuestDisplayName,
  /** Shown on both screens in approve mode. Null when the device pairs with a code. */
  confirmationWord: Schema.NullOr(TrimmedNonEmptyString),
  requestedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type RemoteControlPendingPairing = typeof RemoteControlPendingPairing.Type;

/** The switch as owners see it. It carries no link, code, or session credential. */
export const RemoteControlSwitch = Schema.Struct({
  threadId: ThreadId,
  switchId: RemoteControlSwitchId,
  threadTitle: Schema.String,
  accessLevel: RemoteControlAccessLevel,
  pairingMode: RemoteControlPairingMode,
  ownerReview: Schema.Boolean,
  permissions: Schema.Array(RemoteControlPermission),
  linkStatus: RemoteControlLinkStatus,
  linkExpiresAt: IsoDateTime,
  createdAt: IsoDateTime,
  devices: Schema.Array(RemoteControlDevice),
  pendingPairings: Schema.Array(RemoteControlPendingPairing),
});
export type RemoteControlSwitch = typeof RemoteControlSwitch.Type;

export const RemoteControlSnapshot = Schema.Struct({
  switches: Schema.Array(RemoteControlSwitch),
});
export type RemoteControlSnapshot = typeof RemoteControlSnapshot.Type;

export const RemoteControlLinkRoute = Schema.Struct({
  kind: RemoteControlRouteKind,
  encrypted: Schema.Boolean,
  url: TrimmedNonEmptyString,
});
export type RemoteControlLinkRoute = typeof RemoteControlLinkRoute.Type;

/** A pairing link on every route that works, best first. Only owners who can share access get it. */
export const RemoteControlLink = Schema.Struct({
  routes: Schema.NonEmptyArray(RemoteControlLinkRoute),
  /** The code a device must type, in code mode. */
  code: Schema.NullOr(TrimmedNonEmptyString),
  expiresAt: IsoDateTime,
});
export type RemoteControlLink = typeof RemoteControlLink.Type;

const ConfirmRaise = Schema.optional(Schema.Boolean);

export const RemoteControlThreadInput = Schema.Struct({ threadId: ThreadId });
export type RemoteControlThreadInput = typeof RemoteControlThreadInput.Type;

export const RemoteControlEnableInput = Schema.Struct({
  threadId: ThreadId,
  accessLevel: Schema.optional(RemoteControlAccessLevel),
  pairingMode: Schema.optional(RemoteControlPairingMode),
  ownerReview: Schema.optional(Schema.Boolean),
  /** Required for a level above the default: the owner agreed to it in a confirmation. */
  permissions: Schema.optional(Schema.Array(RemoteControlPermission)),
  confirmRaise: ConfirmRaise,
});
export type RemoteControlEnableInput = typeof RemoteControlEnableInput.Type;

export const RemoteControlEnableResult = Schema.Struct({
  remoteSwitch: RemoteControlSwitch,
  link: RemoteControlLink,
});
export type RemoteControlEnableResult = typeof RemoteControlEnableResult.Type;

export const RemoteControlUpdateInput = Schema.Struct({
  threadId: ThreadId,
  accessLevel: Schema.optional(RemoteControlAccessLevel),
  pairingMode: Schema.optional(RemoteControlPairingMode),
  ownerReview: Schema.optional(Schema.Boolean),
  /** Required to raise the level: the owner agreed to it in a confirmation. */
  permissions: Schema.optional(Schema.Array(RemoteControlPermission)),
  confirmRaise: ConfirmRaise,
});
export type RemoteControlUpdateInput = typeof RemoteControlUpdateInput.Type;

export const RemoteControlRevokeDeviceInput = Schema.Struct({
  threadId: ThreadId,
  deviceId: RemoteControlDeviceId,
});
export type RemoteControlRevokeDeviceInput = typeof RemoteControlRevokeDeviceInput.Type;

export const RemoteControlSetDeviceAccessInput = Schema.Struct({
  threadId: ThreadId,
  deviceId: RemoteControlDeviceId,
  access: RemoteControlDeviceAccess,
  confirmRaise: ConfirmRaise,
});
export type RemoteControlSetDeviceAccessInput = typeof RemoteControlSetDeviceAccessInput.Type;

export const RemoteControlResolvePairingInput = Schema.Struct({
  threadId: ThreadId,
  pairingId: RemoteControlPairingId,
  decision: Schema.Literals(["approve", "deny"]),
});
export type RemoteControlResolvePairingInput = typeof RemoteControlResolvePairingInput.Type;

/** Connected only once the relay has answered this machine's secret. It never carries the secret. */
export const RemoteRelayState = Schema.Struct({
  url: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["off", "connecting", "connected", "failing"]),
  /** Where the setup script saves a relay for this server to pick up. */
  home: TrimmedNonEmptyString,
});
export type RemoteRelayState = typeof RemoteRelayState.Type;

export const RemoteRelayConfigureInput = Schema.Struct({
  url: TrimmedNonEmptyString,
  secret: TrimmedNonEmptyString,
});
export type RemoteRelayConfigureInput = typeof RemoteRelayConfigureInput.Type;

const REMOTE_CONTROL_MESSAGES = {
  no_route: "This machine has no address another device can reach.",
  thread_unavailable: "Remote control cannot be used on this conversation.",
  guest_link_active: "This conversation has a guest link. End it first.",
  not_enabled: "Remote control is off for this conversation.",
  raise_needs_confirmation: "Raising the access level needs your confirmation.",
  not_found: "That device or request is gone.",
  storage_failed: "Remote control could not save its state.",
  invalid_relay: "Enter the relay's https address, with no path.",
  needs_encrypted: "This device joined over plain HTTP, so it keeps the standard time limit.",
} as const;

export class RemoteControlError extends Schema.TaggedError<RemoteControlError>()(
  "RemoteControlError",
  {
    reason: Schema.Literals([
      "no_route",
      "thread_unavailable",
      "guest_link_active",
      "not_enabled",
      "raise_needs_confirmation",
      "not_found",
      "storage_failed",
      "invalid_relay",
      "needs_encrypted",
    ]),
  },
) {
  override get message(): string {
    return REMOTE_CONTROL_MESSAGES[this.reason];
  }
}

export const REMOTE_CONTROL_ROUTE_PREFIX = "/api/remote";
/** The remote page and its routes name the switch they mean with this query parameter. */
export const REMOTE_CONTROL_SWITCH_PARAM = "switch";
export const REMOTE_CONTROL_PAGE_PATH = "/remote";

export const REMOTE_CONTROL_PAIR_START_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/pair/start`;
export const REMOTE_CONTROL_PAIR_STATUS_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/pair/status`;
export const REMOTE_CONTROL_PAIR_CODE_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/pair/code`;
export const REMOTE_CONTROL_SESSION_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/session`;
export const REMOTE_CONTROL_SIGN_OUT_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/sign-out`;
export const REMOTE_CONTROL_STREAM_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/stream`;
export const REMOTE_CONTROL_ITEM_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/item`;
export const REMOTE_CONTROL_HISTORY_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/history`;
export const REMOTE_CONTROL_COMMAND_OUTPUT_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/command-output`;
export const REMOTE_CONTROL_ATTACHMENT_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/attachment`;
export const REMOTE_CONTROL_MEDIA_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/media`;
export const REMOTE_CONTROL_RENDER_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/render`;
export const REMOTE_CONTROL_MESSAGES_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/messages`;
export const REMOTE_CONTROL_RESPOND_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/respond`;
export const REMOTE_CONTROL_STOP_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/stop`;
export const REMOTE_CONTROL_MODE_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/mode`;
export const REMOTE_CONTROL_MODEL_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/model`;
export const REMOTE_CONTROL_RENAME_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/rename`;
export const REMOTE_CONTROL_PROVIDERS_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/providers`;
export const REMOTE_CONTROL_ORCHESTRATOR_STREAM_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/orchestrator/stream`;
export const REMOTE_CONTROL_ORCHESTRATOR_SEND_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/orchestrator/send`;
export const REMOTE_CONTROL_ORCHESTRATOR_REACT_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/orchestrator/react`;
export const REMOTE_CONTROL_ORCHESTRATOR_STOP_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/orchestrator/stop`;

export const remoteControlSessionCookieName = (switchId: string) => `t3_remote_${switchId}`;
export const remoteControlPairingCookieName = (switchId: string) => `t3_remote_pair_${switchId}`;

export const RemoteControlPairStartRequest = Schema.Struct({
  credential: TrimmedNonEmptyString,
  deviceLabel: GuestDisplayName,
});
export type RemoteControlPairStartRequest = typeof RemoteControlPairStartRequest.Type;

export const RemoteControlPairingProgress = Schema.Struct({
  switchId: RemoteControlSwitchId,
  mode: RemoteControlPairingMode,
  /** Compare this with the word on the owner's screen. Null in code mode. */
  confirmationWord: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["waiting", "paired"]),
  expiresAt: IsoDateTime,
});
export type RemoteControlPairingProgress = typeof RemoteControlPairingProgress.Type;

export const RemoteControlPairCodeRequest = Schema.Struct({
  code: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
});
export type RemoteControlPairCodeRequest = typeof RemoteControlPairCodeRequest.Type;

export const RemoteControlRespondRequest = Schema.Struct({
  requestId: RuntimeRequestId,
  /** Approvals take a decision; questions take answers. Standing approvals stay with the owner. */
  decision: Schema.optional(Schema.Literals(["accept", "decline"])),
  answers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type RemoteControlRespondRequest = typeof RemoteControlRespondRequest.Type;

export const RemoteControlModeRequest = Schema.Struct({
  interactionMode: Schema.optional(ProviderInteractionMode),
  runtimeMode: Schema.optional(RuntimeMode),
  capabilityMode: Schema.optional(ThreadCapabilityMode),
});
export type RemoteControlModeRequest = typeof RemoteControlModeRequest.Type;

export const RemoteControlModelRequest = Schema.Struct({ modelSelection: ModelSelection });
export type RemoteControlModelRequest = typeof RemoteControlModelRequest.Type;

export const RemoteControlRenameRequest = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type RemoteControlRenameRequest = typeof RemoteControlRenameRequest.Type;

export const RemoteControlProviders = Schema.Struct({ providers: Schema.Array(ServerProvider) });
export type RemoteControlProviders = typeof RemoteControlProviders.Type;

export const RemoteControlOrchestratorSendRequest = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
});
export type RemoteControlOrchestratorSendRequest = typeof RemoteControlOrchestratorSendRequest.Type;

export const RemoteControlOrchestratorReactRequest = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  emoji: TrimmedNonEmptyString,
  excerpt: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
});
export type RemoteControlOrchestratorReactRequest =
  typeof RemoteControlOrchestratorReactRequest.Type;

/** Why a remote page's session ended, so it can say so. */
export const RemoteControlEndReason = Schema.Literals([
  "revoked",
  "switched_off",
  "archived",
  "expired",
  "signed_out",
]);
export type RemoteControlEndReason = typeof RemoteControlEndReason.Type;

const REMOTE_CONTROL_ACCESS_MESSAGES = {
  invalid: "This link is not valid.",
  used: "This link was already used. Ask the owner for a new one.",
  link_expired: "This link expired. Ask the owner for a new one.",
  locked: "Too many failed attempts. Ask the owner for a new link.",
  rate_limited: "Too many attempts. Wait a moment and try again.",
  wrong_code: "That code is not right.",
  denied: "The owner did not allow this device.",
  pairing_expired: "The owner did not answer in time. Ask for a new link.",
  full: "Too many devices are connected. The owner must disconnect one.",
  ended: "This conversation is no longer shared with this device.",
  session_expired: "This session expired. Ask the owner for a new link.",
  forbidden: "Your access level does not allow this.",
  unencrypted: "This action needs an encrypted connection, such as Tailscale or T3 Connect.",
  unavailable: "This item is not available.",
  rejected: "The owner's server rejected this request.",
  empty: "Write a message or attach a file.",
  too_many_files: "Attach up to 4 files to a message.",
  too_large: "Attached files can total up to 10 MB per message.",
  unsupported_file: "This file cannot be attached. Images must be PNG, JPEG, GIF, or WebP.",
  busy: "Wait for the owner to answer your earlier messages.",
  files_busy: "Wait for the owner to answer your earlier messages before you attach more files.",
  answered: "Someone already answered this.",
} as const;

export const RemoteControlAccessFailureReason = Schema.Literals(
  Object.keys(REMOTE_CONTROL_ACCESS_MESSAGES) as [
    keyof typeof REMOTE_CONTROL_ACCESS_MESSAGES,
    ...Array<keyof typeof REMOTE_CONTROL_ACCESS_MESSAGES>,
  ],
);
export type RemoteControlAccessFailureReason = typeof RemoteControlAccessFailureReason.Type;

/** What a remote device is told. The message comes from `reason`, never from a cause. */
export class RemoteControlAccessError extends Schema.TaggedError<RemoteControlAccessError>()(
  "RemoteControlAccessError",
  {
    reason: RemoteControlAccessFailureReason,
    attemptsLeft: Schema.optional(NonNegativeInt),
    retryAfterMs: Schema.optional(NonNegativeInt),
  },
) {
  override get message(): string {
    return REMOTE_CONTROL_ACCESS_MESSAGES[this.reason];
  }
}

/** The JSON body of a refused remote route. */
export const RemoteControlFailureBody = Schema.Struct({
  reason: RemoteControlAccessFailureReason,
  message: Schema.String,
  attemptsLeft: Schema.optional(NonNegativeInt),
  retryAfterMs: Schema.optional(NonNegativeInt),
});
export type RemoteControlFailureBody = typeof RemoteControlFailureBody.Type;

/** The conversation as one device sees it. `level` is what this device can do right now. */
export const RemoteControlView = Schema.Struct({
  /** The page follows the switch it names, as a guest page follows its share. */
  shareId: RemoteControlSwitchId,
  title: Schema.String,
  deviceId: RemoteControlDeviceId,
  deviceLabel: GuestDisplayName,
  level: RemoteControlAccessLevel,
  /** The owner's choice, which a plain HTTP route can hold this device under. */
  grantedLevel: RemoteControlAccessLevel,
  encrypted: Schema.Boolean,
  ownerReview: Schema.Boolean,
  /** What this device can change right now. */
  permissions: Schema.Array(RemoteControlPermission),
  /** The owner's choice, which a plain HTTP route holds back entirely. */
  grantedPermissions: Schema.Array(RemoteControlPermission),
  /** Null when idling never ends this session. */
  idleExpiresAt: Schema.NullOr(IsoDateTime),
  /** Null when this session never ends by itself. */
  expiresAt: Schema.NullOr(IsoDateTime),
  capabilityMode: ThreadCapabilityMode,
  modelSelection: ModelSelection,
  messages: Schema.Array(ThreadGuestMessage),
  model: GuestThreadModel,
  /** Other paired devices, so people sharing a conversation can see who else is here. */
  otherDevices: Schema.Array(Schema.Struct({ label: GuestDisplayName, connected: Schema.Boolean })),
});
export type RemoteControlView = typeof RemoteControlView.Type;

export const RemoteControlStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("view"), view: RemoteControlView }),
  Schema.Struct({ type: Schema.Literal("thread"), item: OrchestrationV2ThreadStreamItem }),
  Schema.Struct({ type: Schema.Literal("ended"), reason: RemoteControlEndReason }),
]);
export type RemoteControlStreamEvent = typeof RemoteControlStreamEvent.Type;

/** The orchestrator as a device sees it. Its approvals stay with the owner's own clients. */
export const RemoteControlOrchestratorState = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  hasBrain: Schema.Boolean,
  availability: OrchestratorBrainAvailability,
  reactions: Schema.Record(Schema.String, Schema.Array(OrchestratorReaction)),
  ownerReadAt: Schema.NullOr(IsoDateTime),
  pendingApprovals: NonNegativeInt,
});
export type RemoteControlOrchestratorState = typeof RemoteControlOrchestratorState.Type;

export const RemoteControlOrchestratorEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("state"), state: RemoteControlOrchestratorState }),
  Schema.Struct({ type: Schema.Literal("thread"), item: OrchestrationV2ThreadStreamItem }),
]);
export type RemoteControlOrchestratorEvent = typeof RemoteControlOrchestratorEvent.Type;

export const REMOTE_CONTROL_COMPUTER_STREAM_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/computer/stream`;
export const REMOTE_CONTROL_COMPUTER_SCREENSHOT_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/computer/screenshot`;
export const REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/computer/approval`;
export const REMOTE_CONTROL_COMPUTER_STOP_ROUTE = `${REMOTE_CONTROL_ROUTE_PREFIX}/computer/stop`;
export const RemoteControlComputerApprovalRequest = ComputerUseAnswerApprovalInput.mapFields(
  ({ threadId: _threadId, ...fields }) => fields,
);
export type RemoteControlComputerApprovalRequest = typeof RemoteControlComputerApprovalRequest.Type;
