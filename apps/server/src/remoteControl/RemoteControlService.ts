import {
  type ComputerUseSnapshot,
  type ComputerUseScreenshot,
  type ComputerUseState,
  type RemoteControlComputerApprovalRequest,
  type AuditActorKind,
  type AuditOutcome,
  CommandId,
  GuestMessageId,
  GuestShareId,
  type GuestSubmitRequest,
  GuestDisplayName,
  isProviderNativeSubagentThread,
  isRemoteControlShare,
  lowerRemoteControlLevel,
  MessageId,
  OrchestratorReactInput,
  type OrchestratorSnapshot,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ThreadHistoryPage,
  type OrchestrationV2ThreadStreamItem,
  REMOTE_CONTROL_CODE_DIGITS,
  REMOTE_CONTROL_DEFAULT_ACCESS_LEVEL,
  REMOTE_CONTROL_DEVICE_ACCESS_INFO,
  REMOTE_CONTROL_INACTIVITY_TTL_MS,
  REMOTE_CONTROL_LEVEL_INFO,
  REMOTE_CONTROL_LINK_TTL_MS,
  REMOTE_CONTROL_MAX_DEVICES,
  REMOTE_CONTROL_MAX_FAILED_ATTEMPTS,
  REMOTE_CONTROL_PAGE_PATH,
  REMOTE_CONTROL_PAIRING_TTL_MS,
  REMOTE_CONTROL_PERMISSION_INFO,
  REMOTE_CONTROL_SESSION_TTL_MS,
  REMOTE_CONTROL_SHARE_EXPIRES_AT,
  REMOTE_CONTROL_SHARE_HOST,
  REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP,
  type RemoteControlAccessFailureReason,
  type RemoteControlAccessLevel,
  RemoteControlAccessError,
  type RemoteControlDevice,
  RemoteControlDeviceId,
  type RemoteControlEnableInput,
  type RemoteControlEnableResult,
  type RemoteControlEndReason,
  RemoteControlError,
  type RemoteControlLink,
  type RemoteControlLinkStatus,
  type RemoteControlModeRequest,
  type RemoteControlPairCodeRequest,
  RemoteControlPairingId,
  type RemoteControlPairingProgress,
  type RemoteControlPairStartRequest,
  type RemoteControlPendingPairing,
  type RemoteControlReachability,
  type RemoteControlResolvePairingInput,
  type RemoteControlRespondRequest,
  type RemoteControlRevokeDeviceInput,
  type RemoteControlModelRequest,
  type RemoteControlOrchestratorEvent,
  type RemoteControlOrchestratorReactRequest,
  type RemoteControlOrchestratorSendRequest,
  type RemoteControlOrchestratorState,
  type RemoteControlPermission,
  type RemoteControlProviders,
  type RemoteControlRenameRequest,
  type RemoteControlSetDeviceAccessInput,
  type RemoteControlSnapshot,
  type RemoteControlStreamEvent,
  type RemoteControlSwitch,
  RemoteControlSwitchId,
  type RemoteControlThreadInput,
  type RemoteControlUpdateInput,
  type RemoteControlView,
  remoteControlLevelAllows,
  remoteControlLevelPermissions,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../audit/AuditTrail.ts";
import { base64UrlEncode, signPayload, timingSafeEqualBase64Url } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import { guestThreadModel } from "../guest/guestView.ts";
import type { GuestUpload } from "../guest/guestAttachments.ts";
import {
  makeSharedThreadAccess,
  type SharedThreadError,
  threadOfEvent,
} from "../guest/sharedThreadAccess.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { GUEST_FAILURE } from "../orchestration-v2/GuestShareDecider.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "../orchestration-v2/threadSubscription.ts";
import * as OrchestratorAgent from "../orchestratorAgent/OrchestratorAgent.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { CONFIRMATION_WORDS } from "./confirmationWords.ts";
import { RemoteRelayTunnel } from "./RemoteRelayTunnel.ts";
import { rankRemoteRoutes, type RemoteTransport } from "./remoteRoutes.ts";
import {
  makeRemoteControlStore,
  type StoredDevice,
  type StoredPairing,
  type StoredSwitch,
} from "./remoteControlStore.ts";

const AUDIT_DOMAIN = "remote-control";
const SIGNING_SECRET_NAME = "remote-control-signing-key";
const SWITCH_ID_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const SWEEP_INTERVAL = Duration.minutes(1);
// A device with the page open is active; writing that once a minute keeps the session alive.
const ACTIVE_STREAM_TOUCH_INTERVAL = Duration.minutes(1);
const TOUCH_THROTTLE_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
/** Who an owner action is recorded as. MCP tools pass the agent. */
export interface RemoteControlActor {
  readonly kind: Extract<AuditActorKind, "user" | "agent">;
  readonly label?: string;
}
const OWNER: RemoteControlActor = { kind: "user" };

/** A device's session cookie, with how this request reached the server. */
export interface RemoteDeviceCredential {
  readonly switchId: string;
  readonly token: string;
  readonly transport: RemoteTransport;
}

/** The pairing cookie a browser holds between asking to join and being let in. */
export interface RemotePairingCredential {
  readonly switchId: string;
  readonly secret: string;
  readonly transport: RemoteTransport;
}

/** A pairing step, plus the session when it finished. Only the HTTP route sees the token. */
export interface RemotePairingOutcome {
  readonly progress: RemoteControlPairingProgress;
  readonly sessionToken: string | null;
}

const access = (reason: RemoteControlAccessFailureReason) =>
  new RemoteControlAccessError({ reason });
const refused = (reason: RemoteControlError["reason"]) => new RemoteControlError({ reason });
const fromShared = <A, R>(effect: Effect.Effect<A, SharedThreadError, R>) =>
  Effect.mapError(effect, (error) => access(error.reason));

const dispatchFailureReason = (cause: unknown): RemoteControlAccessFailureReason =>
  cause === GUEST_FAILURE.busy
    ? "busy"
    : cause === GUEST_FAILURE.filesBusy
      ? "files_busy"
      : "rejected";

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

const linkStatusOf = (row: StoredSwitch, now: number): RemoteControlLinkStatus =>
  row.linkState !== "ready" ? row.linkState : now >= row.linkExpiresAt ? "expired" : "ready";

const decodeOrchestratorReact = Schema.decodeUnknownEffect(OrchestratorReactInput);

const NEVER = Number.MAX_SAFE_INTEGER;
// Browsers cap a cookie at 400 days. A forever session renews it each time the page opens.
const MAX_COOKIE_MS = 400 * 24 * 60 * 60 * 1000;
// Timers overflow past about 24 days, and this also picks up a limit the owner changed.
const MAX_EXPIRY_WAIT_MS = 60 * 60 * 1000;

/** Only the standard term ends on idling: time the owner chose is not undone by a phone sleeping. */
const idleExpiryOf = (device: Pick<StoredDevice, "access" | "lastSeenAt" | "expiresAt">) =>
  device.access === "forever"
    ? NEVER
    : device.access === "session"
      ? Math.min(device.lastSeenAt + REMOTE_CONTROL_INACTIVITY_TTL_MS, device.expiresAt)
      : device.expiresAt;

const isLiveDevice = (device: StoredDevice, now: number) => now < idleExpiryOf(device);

const isoOrNever = (millis: number) => (millis === NEVER ? null : iso(millis));

/** Device limits as the wire carries them. Null means the session never ends that way. */
const deviceExpiry = (device: StoredDevice) => ({
  idleExpiresAt: isoOrNever(idleExpiryOf(device)),
  expiresAt: device.access === "forever" ? null : iso(device.expiresAt),
});

/** Lets a phone offer the same picker. Accounts, paths, and usage stay on this machine. */
const providerForDevice = (provider: ServerProvider): ServerProvider => {
  const {
    runtimePaths: _paths,
    workspaceSnapshots: _workspaces,
    usageLimits: _usage,
    ...rest
  } = provider;
  return {
    ...rest,
    auth: { status: provider.auth.status },
    slashCommands: [],
    skills: [],
  };
};

/** Backoff after each failure, doubling, so guesses cannot be sent as fast as the network allows. */
const backoffMs = (failedAttempts: number) =>
  Math.min(1000 * 2 ** Math.max(failedAttempts - 1, 0), MAX_BACKOFF_MS);

const isEndingEvent = (event: OrchestrationV2DomainEvent) =>
  event.type === "thread.archived" || event.type === "thread.deleted";

export class RemoteControlService extends Context.Service<
  RemoteControlService,
  {
    readonly reachability: () => Effect.Effect<RemoteControlReachability>;
    /** Every switch, on subscribing and again after each change. */
    readonly changes: Stream.Stream<RemoteControlSnapshot>;
    readonly enable: (
      input: RemoteControlEnableInput,
      actor?: RemoteControlActor,
    ) => Effect.Effect<RemoteControlEnableResult, RemoteControlError>;
    readonly update: (
      input: RemoteControlUpdateInput,
      actor?: RemoteControlActor,
    ) => Effect.Effect<RemoteControlSwitch, RemoteControlError>;
    readonly disable: (
      input: RemoteControlThreadInput,
      actor?: RemoteControlActor,
    ) => Effect.Effect<void, RemoteControlError>;
    readonly rotateLink: (
      input: RemoteControlThreadInput,
      actor?: RemoteControlActor,
    ) => Effect.Effect<RemoteControlLink, RemoteControlError>;
    /** The unused link again, for an owner reopening the sheet, or null once it stopped working. */
    readonly revealLink: (
      input: RemoteControlThreadInput,
    ) => Effect.Effect<RemoteControlLink | null, RemoteControlError>;
    readonly revokeDevice: (
      input: RemoteControlRevokeDeviceInput,
      actor?: RemoteControlActor,
    ) => Effect.Effect<void, RemoteControlError>;
    readonly setDeviceAccess: (
      input: RemoteControlSetDeviceAccessInput,
    ) => Effect.Effect<void, RemoteControlError>;
    readonly resolvePairing: (
      input: RemoteControlResolvePairingInput,
    ) => Effect.Effect<void, RemoteControlError>;

    readonly startPairing: (
      request: RemoteControlPairStartRequest,
      transport: RemoteTransport,
    ) => Effect.Effect<
      RemotePairingOutcome & { readonly pairingSecret: string },
      RemoteControlAccessError
    >;
    readonly pairingStatus: (
      credential: RemotePairingCredential,
    ) => Effect.Effect<RemotePairingOutcome, RemoteControlAccessError>;
    readonly submitCode: (
      credential: RemotePairingCredential,
      request: RemoteControlPairCodeRequest,
    ) => Effect.Effect<RemotePairingOutcome, RemoteControlAccessError>;

    /** Succeeds while the session holds this level. Every route below repeats the check. */
    readonly session: (
      credential: RemoteDeviceCredential,
      required?: RemoteControlAccessLevel,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    /** How long this device's cookie should last from now. */
    readonly sessionLifetimeMs: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<number, RemoteControlAccessError>;
    readonly signOut: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    /** `afterSequence` is the last event the page holds; it resumes there when it still can. */
    readonly stream: (
      credential: RemoteDeviceCredential,
      afterSequence: number | undefined,
    ) => Effect.Effect<Stream.Stream<RemoteControlStreamEvent>, RemoteControlAccessError>;
    readonly item: (
      credential: RemoteDeviceCredential,
      itemId: string,
    ) => Effect.Effect<OrchestrationV2GetTurnItemResult, RemoteControlAccessError>;
    readonly history: (
      credential: RemoteDeviceCredential,
      cursor: string,
    ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, RemoteControlAccessError>;
    readonly commandOutput: (
      credential: RemoteDeviceCredential,
      itemId: string,
    ) => Effect.Effect<Stream.Stream<OrchestrationV2CommandOutputFrame>, RemoteControlAccessError>;
    readonly attachment: (
      credential: RemoteDeviceCredential,
      attachmentId: string,
    ) => Effect.Effect<
      Effect.Success<ReturnType<SharedThreadAccess["attachment"]>>,
      RemoteControlAccessError
    >;
    readonly media: (
      credential: RemoteDeviceCredential,
      path: string,
    ) => Effect.Effect<
      { readonly path: string; readonly mimeType: string },
      RemoteControlAccessError
    >;
    readonly render: (
      credential: RemoteDeviceCredential,
      itemId: string,
    ) => Effect.Effect<{ readonly path: string; readonly title: string }, RemoteControlAccessError>;
    readonly submit: (
      credential: RemoteDeviceCredential,
      request: GuestSubmitRequest,
      uploads: ReadonlyArray<GuestUpload>,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly respond: (
      credential: RemoteDeviceCredential,
      request: RemoteControlRespondRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly stop: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly computerStream: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<Stream.Stream<ComputerUseSnapshot>, RemoteControlAccessError>;
    readonly computerScreenshot: (
      credential: RemoteDeviceCredential,
      stepId: string,
    ) => Effect.Effect<ComputerUseScreenshot, RemoteControlAccessError>;
    readonly answerComputerApproval: (
      credential: RemoteDeviceCredential,
      request: RemoteControlComputerApprovalRequest,
    ) => Effect.Effect<ComputerUseState, RemoteControlAccessError>;
    readonly stopComputer: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<ComputerUseState, RemoteControlAccessError>;
    readonly setMode: (
      credential: RemoteDeviceCredential,
      request: RemoteControlModeRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly setModel: (
      credential: RemoteDeviceCredential,
      request: RemoteControlModelRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly rename: (
      credential: RemoteDeviceCredential,
      request: RemoteControlRenameRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly providers: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<RemoteControlProviders, RemoteControlAccessError>;
    readonly orchestratorStream: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<Stream.Stream<RemoteControlOrchestratorEvent>, RemoteControlAccessError>;
    readonly orchestratorSend: (
      credential: RemoteDeviceCredential,
      request: RemoteControlOrchestratorSendRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly orchestratorReact: (
      credential: RemoteDeviceCredential,
      request: RemoteControlOrchestratorReactRequest,
    ) => Effect.Effect<void, RemoteControlAccessError>;
    readonly orchestratorStop: (
      credential: RemoteDeviceCredential,
    ) => Effect.Effect<void, RemoteControlAccessError>;
  }
>()("t3pp/remoteControl/RemoteControlService") {}

import * as ComputerUseService from "../computerUse/ComputerUseService.ts";

type SharedThreadAccess = Effect.Success<typeof makeSharedThreadAccess>;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const computerUse = yield* Effect.serviceOption(ComputerUseService.ComputerUseService);
  const directEndpoints = yield* DirectEndpoints.DirectEndpoints;
  const managedEndpoint = yield* CloudManagedEndpointRuntime;
  const remoteRelay = yield* RemoteRelayTunnel;
  const orchestratorAgent = yield* OrchestratorAgent.OrchestratorAgent;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const audit = yield* AuditTrail.AuditTrail;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const shared = yield* makeSharedThreadAccess;
  const store = yield* makeRemoteControlStore;
  const threadServices = yield* Effect.context<
    | ThreadManagement.ThreadManagementService
    | OrchestrationEventStore.OrchestrationEventStore
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | DocumentText.DocumentText
  >();
  const signingKey = yield* Effect.cached(
    secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(Effect.orDie),
  );
  // Pairing decisions read then write, and a guess must never see a stale failure count.
  const pairingLock = yield* Semaphore.make(1);
  const serialized = pairingLock.withPermits(1);
  const changed = yield* PubSub.sliding<string>(64);
  const publishChange = (switchId: string) => PubSub.publish(changed, switchId).pipe(Effect.asVoid);

  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  const randomToken = (bytes: number) =>
    crypto.randomBytes(bytes).pipe(Effect.map(base64UrlEncode), Effect.orDie);
  const commandId = (label: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.map((uuid) => CommandId.make(`server:remote-control:${label}:${uuid}`)),
      Effect.orDie,
    );

  // Links and codes derive from the switch and its generation, so nothing secret is stored and
  // bumping the generation kills both. Session tokens are random and stored only as keyed hashes.
  const linkSignature = (switchId: string, generation: number) =>
    Effect.map(signingKey, (key) => signPayload(`remote-link:${switchId}:${generation}`, key));
  const linkCredential = (row: StoredSwitch) =>
    Effect.map(
      linkSignature(row.switchId, row.linkGeneration),
      (signature) => `${row.switchId}.${row.linkGeneration}.${signature}`,
    );
  const pairingCode = (row: StoredSwitch) =>
    Effect.map(signingKey, (key) => {
      const digest = Buffer.from(
        signPayload(`remote-code:${row.switchId}:${row.linkGeneration}`, key),
        "base64url",
      );
      return (digest.readBigUInt64BE(0) % 10n ** BigInt(REMOTE_CONTROL_CODE_DIGITS))
        .toString()
        .padStart(REMOTE_CONTROL_CODE_DIGITS, "0");
    });
  const secretHash = (purpose: string, secret: string) =>
    Effect.map(signingKey, (key) => signPayload(`remote-${purpose}:${secret}`, key));

  const connectHostname = managedEndpoint.inspectConnector.pipe(
    Effect.map((facts) => facts?.hostname ?? null),
    Effect.orElseSucceed(() => null),
  );
  const reachability = Effect.fn("RemoteControlService.reachability")(function* () {
    return rankRemoteRoutes({
      endpoints: yield* directEndpoints.resolve(),
      connectHostname: yield* connectHostname,
      relayUrl: yield* remoteRelay.publicUrl,
    });
  });

  const threadRecord = (threadId: ThreadId) =>
    orchestrator.getThreadRecords(threadId, []).pipe(
      Effect.map(({ thread }) => thread),
      Effect.orElseSucceed(() => null),
    );

  const recordAudit = (input: {
    readonly actor: RemoteControlActor | { readonly kind: "remote-guest"; readonly label: string };
    readonly action: string;
    readonly outcome?: AuditOutcome;
    readonly threadId: ThreadId;
    readonly target?: { readonly kind: string; readonly id: string; readonly label?: string };
    readonly request?: string;
    readonly result?: string;
  }) =>
    audit.record({
      actor: input.actor.kind,
      ...(input.actor.label === undefined ? {} : { actorLabel: input.actor.label }),
      domain: AUDIT_DOMAIN,
      action: input.action,
      outcome: input.outcome ?? "succeeded",
      threadId: input.threadId,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.result === undefined ? {} : { result: input.result }),
    });
  const asGuest = (label: string) => ({ kind: "remote-guest" as const, label });

  // Open pages, by device. Ending a device completes its deferreds, so reads stop at once.
  const watchers = new Set<{
    readonly switchId: string;
    readonly deviceId: string;
    readonly ended: Deferred.Deferred<RemoteControlEndReason>;
  }>();
  const endWatchers = (
    matches: (watcher: { readonly switchId: string; readonly deviceId: string }) => boolean,
    reason: RemoteControlEndReason,
  ) =>
    Effect.sync(() => {
      for (const watcher of watchers) {
        if (matches(watcher)) Deferred.doneUnsafe(watcher.ended, Effect.succeed(reason));
      }
    });
  const watchDevice = (device: StoredDevice) =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const watcher = {
          switchId: device.switchId,
          deviceId: device.id,
          ended: yield* Deferred.make<RemoteControlEndReason>(),
        };
        watchers.add(watcher);
        return watcher;
      }),
      (watcher) => Effect.sync(() => watchers.delete(watcher)),
    ).pipe(Effect.map((watcher) => watcher.ended));

  const connectedStreams = new Map<string, number>();
  const holdConnected = (device: StoredDevice) =>
    Effect.acquireRelease(
      Effect.suspend(() => {
        const open = connectedStreams.get(device.id) ?? 0;
        connectedStreams.set(device.id, open + 1);
        return open === 0 ? publishChange(device.switchId) : Effect.void;
      }),
      () =>
        Effect.suspend(() => {
          const open = (connectedStreams.get(device.id) ?? 1) - 1;
          if (open > 0) {
            connectedStreams.set(device.id, open);
            return Effect.void;
          }
          connectedStreams.delete(device.id);
          return publishChange(device.switchId);
        }),
    );

  const toDevice = (device: StoredDevice): RemoteControlDevice => ({
    id: RemoteControlDeviceId.make(device.id),
    label: GuestDisplayName.make(device.label),
    pairedAt: iso(device.pairedAt),
    access: device.access,
    ...deviceExpiry(device),
    connected: connectedStreams.has(device.id),
    lastAction: device.lastAction,
    lastActionAt: device.lastActionAt === null ? null : iso(device.lastActionAt),
  });
  const toPending = (pairing: StoredPairing): RemoteControlPendingPairing => ({
    id: RemoteControlPairingId.make(pairing.id),
    deviceLabel: GuestDisplayName.make(pairing.deviceLabel),
    confirmationWord: pairing.confirmationWord,
    requestedAt: iso(pairing.requestedAt),
    expiresAt: iso(pairing.expiresAt),
  });
  const toSwitch = (
    row: StoredSwitch,
    title: string,
    devices: ReadonlyArray<StoredDevice>,
    pairings: ReadonlyArray<StoredPairing>,
    now: number,
  ): RemoteControlSwitch => ({
    threadId: row.threadId,
    switchId: RemoteControlSwitchId.make(row.switchId),
    threadTitle: title,
    accessLevel: row.accessLevel,
    pairingMode: row.pairingMode,
    ownerReview: row.ownerReview,
    permissions: row.permissions,
    linkStatus: linkStatusOf(row, now),
    linkExpiresAt: iso(row.linkExpiresAt),
    createdAt: iso(row.createdAt),
    devices: devices
      .filter((device) => device.switchId === row.switchId && isLiveDevice(device, now))
      .map(toDevice),
    pendingPairings: pairings
      .filter(
        (pairing) =>
          pairing.switchId === row.switchId &&
          pairing.status === "pending" &&
          now < pairing.expiresAt,
      )
      .map(toPending),
  });

  const snapshot = Effect.gen(function* () {
    const [rows, devices, pairings, now] = yield* Effect.all([
      store.listSwitches,
      store.listDevices,
      store.listPairings,
      nowMillis,
    ]);
    const switches = yield* Effect.forEach(rows, (row) =>
      Effect.map(threadRecord(row.threadId), (thread) =>
        toSwitch(row, thread?.title ?? "Conversation", devices, pairings, now),
      ),
    );
    return { switches };
  });

  const switchFor = (threadId: ThreadId) =>
    store.switchByThread(threadId).pipe(
      Effect.filterOrFail(
        (row): row is StoredSwitch => row !== null,
        () => refused("not_enabled"),
      ),
    );
  const switchView = (row: StoredSwitch) =>
    Effect.map(snapshot, ({ switches }) => {
      const found = switches.find((candidate) => candidate.switchId === row.switchId);
      if (found === undefined) throw new Error("A switch vanished while it was being read.");
      return found;
    });

  /** The message queue behind a switch lives in the thread's guest share slot. */
  const ensureShare = Effect.fn("RemoteControlService.ensureShare")(function* (
    row: Pick<StoredSwitch, "shareId" | "threadId">,
    thread: OrchestrationV2AppThread,
  ) {
    const shareId = GuestShareId.make(row.shareId);
    if (thread.guestShare?.id === shareId && thread.guestShare.guestName !== null) return;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.open",
      commandId: yield* commandId("share-open"),
      threadId: row.threadId,
      shareId,
      host: REMOTE_CONTROL_SHARE_HOST,
      expiresAt: REMOTE_CONTROL_SHARE_EXPIRES_AT,
    });
    yield* orchestrator.dispatch({
      type: "thread.guest-share.redeem",
      commandId: yield* commandId("share-ready"),
      threadId: row.threadId,
      shareId,
      guestName: "Remote control",
    });
  });

  const buildLink = Effect.fn("RemoteControlService.buildLink")(function* (row: StoredSwitch) {
    const { routes } = yield* reachability();
    const [first, ...rest] = routes;
    if (first === undefined) return yield* refused("no_route");
    const credential = yield* linkCredential(row);
    const toLink = (route: typeof first) => ({
      kind: route.kind,
      encrypted: route.encrypted,
      url: `${route.baseUrl}${REMOTE_CONTROL_PAGE_PATH}#${credential}`,
    });
    return {
      routes: [toLink(first), ...rest.map(toLink)] as const,
      code: row.pairingMode === "code" ? yield* pairingCode(row) : null,
      expiresAt: iso(row.linkExpiresAt),
    } satisfies RemoteControlLink;
  });

  const rotate = Effect.fn("RemoteControlService.rotate")(function* (row: StoredSwitch) {
    const now = yield* nowMillis;
    yield* store.rotateLink({
      switchId: row.switchId,
      linkExpiresAt: now + REMOTE_CONTROL_LINK_TTL_MS,
    });
    const rotated = yield* store.switchById(row.switchId);
    return rotated ?? row;
  });

  const needsRaiseConfirmation = (
    current: RemoteControlAccessLevel,
    next: RemoteControlAccessLevel,
    confirmed: boolean | undefined,
  ) => next !== current && remoteControlLevelAllows(next, current) && confirmed !== true;

  const applySettings = Effect.fn("RemoteControlService.applySettings")(function* (
    row: StoredSwitch,
    input: RemoteControlUpdateInput,
    actor: RemoteControlActor,
  ) {
    const accessLevel = input.accessLevel ?? row.accessLevel;
    const pairingMode = input.pairingMode ?? row.pairingMode;
    const ownerReview = input.ownerReview ?? row.ownerReview;
    const permissions =
      input.permissions ??
      (accessLevel === row.accessLevel
        ? row.permissions
        : remoteControlLevelPermissions(accessLevel));
    const added = permissions.filter((permission) => !row.permissions.includes(permission));
    // Picking Full is already confirmed as a raise; anything added by hand needs its own yes.
    const addedByHand = input.permissions === undefined ? [] : added;
    if (
      needsRaiseConfirmation(row.accessLevel, accessLevel, input.confirmRaise) ||
      (addedByHand.length > 0 && input.confirmRaise !== true)
    ) {
      yield* recordAudit({
        actor,
        action: "level.raise",
        outcome: "denied",
        threadId: row.threadId,
        result: `${row.accessLevel} to ${accessLevel} without confirmation`,
      });
      return yield* refused("raise_needs_confirmation");
    }
    yield* store.updateSettings({
      switchId: row.switchId,
      accessLevel,
      pairingMode,
      ownerReview,
      permissions,
    });
    if (added.length > 0 || permissions.length !== row.permissions.length) {
      yield* recordAudit({
        actor,
        action: "permissions.changed",
        threadId: row.threadId,
        result:
          permissions.map((item) => REMOTE_CONTROL_PERMISSION_INFO[item].label).join(", ") ||
          "none",
      });
    }
    if (accessLevel !== row.accessLevel) {
      yield* recordAudit({
        actor,
        action: "level.changed",
        threadId: row.threadId,
        result: `${REMOTE_CONTROL_LEVEL_INFO[row.accessLevel].label} to ${REMOTE_CONTROL_LEVEL_INFO[accessLevel].label}`,
      });
    }
    if (ownerReview !== row.ownerReview) {
      yield* recordAudit({
        actor,
        action: ownerReview ? "review.on" : "review.off",
        threadId: row.threadId,
      });
    }
    // A code belongs to one link, so changing how devices pair starts a new one.
    const next = yield* store.switchById(row.switchId);
    return pairingMode !== row.pairingMode && next !== null ? yield* rotate(next) : (next ?? row);
  });

  const enable: RemoteControlService["Service"]["enable"] = Effect.fn(
    "RemoteControlService.enable",
  )(function* (input, actor = OWNER) {
    return yield* serialized(
      Effect.gen(function* () {
        const existing = yield* store.switchByThread(input.threadId);
        if (existing !== null) {
          const updated = yield* applySettings(existing, input, actor);
          const now = yield* nowMillis;
          const row = linkStatusOf(updated, now) === "ready" ? updated : yield* rotate(updated);
          yield* publishChange(row.switchId);
          return { remoteSwitch: yield* switchView(row), link: yield* buildLink(row) };
        }
        const accessLevel = input.accessLevel ?? REMOTE_CONTROL_DEFAULT_ACCESS_LEVEL;
        if (
          needsRaiseConfirmation(
            REMOTE_CONTROL_DEFAULT_ACCESS_LEVEL,
            accessLevel,
            input.confirmRaise,
          )
        ) {
          return yield* refused("raise_needs_confirmation");
        }
        const thread = yield* threadRecord(input.threadId);
        if (
          thread === null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          thread.lineage.orchestrator === true ||
          isProviderNativeSubagentThread(thread)
        ) {
          return yield* refused("thread_unavailable");
        }
        const now = yield* nowMillis;
        if (
          thread.guestShare &&
          !isRemoteControlShare(thread.guestShare) &&
          Date.parse(thread.guestShare.expiresAt) > now
        ) {
          return yield* refused("guest_link_active");
        }
        // Checked before anything changes, so a switch with no route is never left on.
        const { routes } = yield* reachability();
        if (routes.length === 0) return yield* refused("no_route");
        const row: StoredSwitch = {
          switchId: yield* randomToken(SWITCH_ID_BYTES),
          threadId: input.threadId,
          shareId: yield* randomToken(SWITCH_ID_BYTES),
          accessLevel,
          pairingMode: input.pairingMode ?? "approve",
          ownerReview: input.ownerReview ?? false,
          permissions: input.permissions ?? remoteControlLevelPermissions(accessLevel),
          linkGeneration: 1,
          linkState: "ready",
          linkExpiresAt: now + REMOTE_CONTROL_LINK_TTL_MS,
          failedAttempts: 0,
          nextAttemptAt: 0,
          createdAt: now,
        };
        yield* ensureShare(row, thread).pipe(Effect.mapError(() => refused("thread_unavailable")));
        yield* store.insertSwitch(row);
        yield* recordAudit({
          actor,
          action: "switch.on",
          threadId: row.threadId,
          result: `${accessLevel}, ${row.pairingMode}`,
        });
        yield* publishChange(row.switchId);
        return { remoteSwitch: yield* switchView(row), link: yield* buildLink(row) };
      }),
    );
  });

  const update: RemoteControlService["Service"]["update"] = Effect.fn(
    "RemoteControlService.update",
  )(function* (input, actor = OWNER) {
    return yield* serialized(
      Effect.gen(function* () {
        const row = yield* applySettings(yield* switchFor(input.threadId), input, actor);
        yield* publishChange(row.switchId);
        return yield* switchView(row);
      }),
    );
  });

  /** Ends the switch: its link, pairings, and every device, and any page they have open. */
  const endSwitch = Effect.fn("RemoteControlService.endSwitch")(function* (
    row: StoredSwitch,
    reason: Extract<RemoteControlEndReason, "switched_off" | "archived">,
    actor: RemoteControlActor,
  ) {
    // Two paths can notice the same archive; only the first ends anything.
    if ((yield* store.switchById(row.switchId)) === null) return;
    const devices = yield* store.devicesOf(row.switchId);
    yield* store.deleteSwitch(row.switchId);
    yield* endWatchers((watcher) => watcher.switchId === row.switchId, reason);
    yield* orchestrator
      .dispatch({
        type: "thread.guest-share.close",
        commandId: yield* commandId("share-close"),
        threadId: row.threadId,
      })
      .pipe(Effect.ignore);
    yield* Effect.forEach(
      devices,
      (device) =>
        recordAudit({
          actor: asGuest(device.label),
          action: "device.revoked",
          threadId: row.threadId,
          target: { kind: "device", id: device.id, label: device.label },
          request: reason === "archived" ? "conversation archived" : "switched off",
        }),
      { discard: true },
    );
    yield* recordAudit({
      actor,
      action: reason === "archived" ? "switch.ended" : "switch.off",
      threadId: row.threadId,
    });
    yield* publishChange(row.switchId);
  });

  const disable: RemoteControlService["Service"]["disable"] = Effect.fn(
    "RemoteControlService.disable",
  )(function* (input, actor = OWNER) {
    yield* serialized(
      Effect.gen(function* () {
        const row = yield* store.switchByThread(input.threadId);
        if (row !== null) yield* endSwitch(row, "switched_off", actor);
      }),
    );
  });

  const rotateLink: RemoteControlService["Service"]["rotateLink"] = Effect.fn(
    "RemoteControlService.rotateLink",
  )(function* (input, actor = OWNER) {
    return yield* serialized(
      Effect.gen(function* () {
        const row = yield* rotate(yield* switchFor(input.threadId));
        yield* recordAudit({ actor, action: "link.rotated", threadId: row.threadId });
        yield* publishChange(row.switchId);
        return yield* buildLink(row);
      }),
    );
  });

  const revealLink: RemoteControlService["Service"]["revealLink"] = Effect.fn(
    "RemoteControlService.revealLink",
  )(function* (input) {
    const row = yield* switchFor(input.threadId);
    return linkStatusOf(row, yield* nowMillis) === "ready" ? yield* buildLink(row) : null;
  });

  const endDevice = Effect.fn("RemoteControlService.endDevice")(function* (
    device: StoredDevice,
    threadId: ThreadId,
    reason: Extract<RemoteControlEndReason, "revoked" | "expired" | "signed_out">,
    request: string,
  ) {
    yield* store.deleteDevice(device.id);
    yield* endWatchers((watcher) => watcher.deviceId === device.id, reason);
    yield* recordAudit({
      actor: asGuest(device.label),
      action: reason === "expired" ? "device.expired" : "device.revoked",
      threadId,
      target: { kind: "device", id: device.id, label: device.label },
      request,
    });
    yield* publishChange(device.switchId);
  });

  const setDeviceAccess: RemoteControlService["Service"]["setDeviceAccess"] = Effect.fn(
    "RemoteControlService.setDeviceAccess",
  )(function* (input) {
    yield* serialized(
      Effect.gen(function* () {
        const row = yield* switchFor(input.threadId);
        const device = yield* store.deviceById(input.deviceId);
        if (device === null || device.switchId !== row.switchId) {
          return yield* refused("not_found");
        }
        // A plain HTTP session can be copied off the network, so it never outlives the standard.
        if (input.access !== "session" && device.boundPeer !== null) {
          return yield* refused("needs_encrypted");
        }
        if (input.access !== "session" && input.confirmRaise !== true) {
          return yield* refused("raise_needs_confirmation");
        }
        const now = yield* nowMillis;
        const { durationMs, label } = REMOTE_CONTROL_DEVICE_ACCESS_INFO[input.access];
        yield* store.setDeviceAccess({
          id: device.id,
          access: input.access,
          expiresAt:
            input.access === "forever"
              ? NEVER
              : now + (durationMs ?? REMOTE_CONTROL_SESSION_TTL_MS),
          lastSeenAt: now,
        });
        yield* recordAudit({
          actor: OWNER,
          action: "device.access",
          threadId: row.threadId,
          target: { kind: "device", id: device.id, label: device.label },
          result: label,
        });
        yield* publishChange(row.switchId);
      }),
    );
  });

  const revokeDevice: RemoteControlService["Service"]["revokeDevice"] = Effect.fn(
    "RemoteControlService.revokeDevice",
  )(function* (input, actor = OWNER) {
    yield* serialized(
      Effect.gen(function* () {
        const row = yield* switchFor(input.threadId);
        const device = yield* store.deviceById(input.deviceId);
        if (device === null || device.switchId !== row.switchId) {
          return yield* refused("not_found");
        }
        yield* endDevice(
          device,
          row.threadId,
          "revoked",
          actor.kind === "agent"
            ? `revoked by agent ${actor.label ?? ""}`.trim()
            : "revoked by owner",
        );
      }),
    );
  });

  const resolvePairing: RemoteControlService["Service"]["resolvePairing"] = Effect.fn(
    "RemoteControlService.resolvePairing",
  )(function* (input) {
    yield* serialized(
      Effect.gen(function* () {
        const row = yield* switchFor(input.threadId);
        const pairing = yield* store.pairingById(input.pairingId);
        const now = yield* nowMillis;
        if (
          pairing === null ||
          pairing.switchId !== row.switchId ||
          pairing.status !== "pending" ||
          now >= pairing.expiresAt
        ) {
          return yield* refused("not_found");
        }
        const approved = input.decision === "approve";
        yield* store.setPairingStatus(pairing.id, approved ? "approved" : "denied");
        yield* recordAudit({
          actor: OWNER,
          action: approved ? "pairing.approved" : "pairing.denied",
          threadId: row.threadId,
          target: { kind: "device", id: pairing.id, label: pairing.deviceLabel },
        });
        yield* publishChange(row.switchId);
      }),
    );
  });

  /** Counts a failed attempt. The last one allowed locks the link, and the pairing with it. */
  const recordFailedAttempt = Effect.fn("RemoteControlService.recordFailedAttempt")(function* (
    row: StoredSwitch,
    label: string,
    action: string,
  ) {
    const failedAttempts = row.failedAttempts + 1;
    const locked = failedAttempts >= REMOTE_CONTROL_MAX_FAILED_ATTEMPTS;
    const now = yield* nowMillis;
    yield* store.recordFailure({
      switchId: row.switchId,
      failedAttempts,
      nextAttemptAt: now + backoffMs(failedAttempts),
      locked,
    });
    yield* recordAudit({
      actor: asGuest(label),
      action,
      outcome: "denied",
      threadId: row.threadId,
      result: locked ? "link locked" : `attempt ${failedAttempts}`,
    });
    yield* publishChange(row.switchId);
    return { locked, attemptsLeft: REMOTE_CONTROL_MAX_FAILED_ATTEMPTS - failedAttempts };
  });

  const refuseWhileBackingOff = Effect.fn("RemoteControlService.refuseWhileBackingOff")(function* (
    row: StoredSwitch,
  ) {
    const now = yield* nowMillis;
    if (now < row.nextAttemptAt) {
      return yield* new RemoteControlAccessError({
        reason: "rate_limited",
        retryAfterMs: row.nextAttemptAt - now,
      });
    }
  });

  const parseLink = (credential: string) => {
    const [switchId, generation, signature, extra] = credential.split(".");
    const parsed = Number(generation);
    return switchId && signature && extra === undefined && Number.isSafeInteger(parsed)
      ? { switchId, generation: parsed, signature }
      : null;
  };

  const progressOf = (
    row: StoredSwitch,
    pairing: StoredPairing,
    status: RemoteControlPairingProgress["status"],
  ): RemoteControlPairingProgress => ({
    switchId: RemoteControlSwitchId.make(row.switchId),
    mode: pairing.confirmationWord === null ? "code" : "approve",
    confirmationWord: pairing.confirmationWord,
    status,
    expiresAt: iso(pairing.expiresAt),
  });

  const startPairing: RemoteControlService["Service"]["startPairing"] = Effect.fn(
    "RemoteControlService.startPairing",
  )(function* (request, _transport) {
    const parsed = parseLink(request.credential);
    if (parsed === null) return yield* access("invalid");
    return yield* serialized(
      Effect.gen(function* () {
        const row = yield* store.switchById(parsed.switchId);
        if (row === null) return yield* access("invalid");
        if (row.linkState === "locked") return yield* access("locked");
        yield* refuseWhileBackingOff(row);
        const expected = yield* linkSignature(parsed.switchId, parsed.generation);
        if (!timingSafeEqualBase64Url(parsed.signature, expected)) {
          const { locked } = yield* recordFailedAttempt(
            row,
            request.deviceLabel,
            "pairing.bad-link",
          );
          return yield* access(locked ? "locked" : "invalid");
        }
        // A genuine link from an earlier generation is stale, not a guess: nothing to count.
        if (parsed.generation !== row.linkGeneration || row.linkState === "spent") {
          yield* recordAudit({
            actor: asGuest(request.deviceLabel),
            action: "pairing.link-reused",
            outcome: "denied",
            threadId: row.threadId,
          });
          return yield* access("used");
        }
        const now = yield* nowMillis;
        if (now >= row.linkExpiresAt) return yield* access("link_expired");
        const live = (yield* store.devicesOf(row.switchId)).filter((device) =>
          isLiveDevice(device, now),
        );
        if (live.length >= REMOTE_CONTROL_MAX_DEVICES) return yield* access("full");
        if (!(yield* store.spendLink({ switchId: row.switchId, generation: parsed.generation }))) {
          return yield* access("used");
        }
        const pairingSecret = yield* randomToken(SESSION_TOKEN_BYTES);
        const word =
          row.pairingMode === "approve"
            ? CONFIRMATION_WORDS[
                new DataView((yield* crypto.randomBytes(2).pipe(Effect.orDie)).buffer).getUint16(
                  0,
                ) % CONFIRMATION_WORDS.length
              ]!
            : null;
        const pairing: StoredPairing = {
          id: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
          switchId: row.switchId,
          secretHash: yield* secretHash("pairing", pairingSecret),
          deviceLabel: request.deviceLabel,
          confirmationWord: word,
          status: "pending",
          requestedAt: now,
          expiresAt: now + REMOTE_CONTROL_PAIRING_TTL_MS,
        };
        yield* store.insertPairing(pairing);
        yield* recordAudit({
          actor: asGuest(request.deviceLabel),
          action: "pairing.requested",
          outcome: "pending",
          threadId: row.threadId,
        });
        yield* publishChange(row.switchId);
        return { progress: progressOf(row, pairing, "waiting"), sessionToken: null, pairingSecret };
      }),
    );
  });

  /** Turns an allowed pairing into a device session, once. */
  const issueDevice = Effect.fn("RemoteControlService.issueDevice")(function* (
    row: StoredSwitch,
    pairing: StoredPairing,
    transport: RemoteTransport,
  ) {
    const token = yield* randomToken(SESSION_TOKEN_BYTES);
    const now = yield* nowMillis;
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const action = "Joined";
    yield* store.withTransaction(
      Effect.all(
        [
          store.insertDevice({
            id,
            switchId: row.switchId,
            tokenHash: yield* secretHash("session", token),
            label: pairing.deviceLabel,
            // A plain HTTP session can be copied off the network, so it stays at this address.
            boundPeer: transport.encrypted ? null : transport.peer,
            pairedAt: now,
            lastSeenAt: now,
            access: "session",
            expiresAt: now + REMOTE_CONTROL_SESSION_TTL_MS,
            lastAction: action,
            lastActionAt: now,
          }),
          store.deletePairing(pairing.id),
        ],
        { discard: true },
      ),
    );
    yield* recordAudit({
      actor: asGuest(pairing.deviceLabel),
      action: "device.joined",
      threadId: row.threadId,
      target: { kind: "device", id, label: pairing.deviceLabel },
      result: transport.encrypted ? "encrypted route" : "unencrypted route",
    });
    yield* publishChange(row.switchId);
    return token;
  });

  const openPairing = Effect.fn("RemoteControlService.openPairing")(function* (
    credential: RemotePairingCredential,
  ) {
    const pairing = yield* store.pairingBySecretHash(
      yield* secretHash("pairing", credential.secret),
    );
    if (pairing === null || pairing.switchId !== credential.switchId) {
      return yield* access("invalid");
    }
    const row = yield* store.switchById(pairing.switchId);
    if (row === null) return yield* access("ended");
    if (row.linkState === "locked") return yield* access("locked");
    if ((yield* nowMillis) >= pairing.expiresAt) return yield* access("pairing_expired");
    return { row, pairing };
  });

  const pairingStatus: RemoteControlService["Service"]["pairingStatus"] = Effect.fn(
    "RemoteControlService.pairingStatus",
  )(function* (credential) {
    return yield* serialized(
      Effect.gen(function* () {
        const { row, pairing } = yield* openPairing(credential);
        if (pairing.status === "denied") return yield* access("denied");
        if (pairing.status === "pending") {
          return { progress: progressOf(row, pairing, "waiting"), sessionToken: null };
        }
        const sessionToken = yield* issueDevice(row, pairing, credential.transport);
        return { progress: progressOf(row, pairing, "paired"), sessionToken };
      }),
    );
  });

  const submitCode: RemoteControlService["Service"]["submitCode"] = Effect.fn(
    "RemoteControlService.submitCode",
  )(function* (credential, request) {
    return yield* serialized(
      Effect.gen(function* () {
        const { row, pairing } = yield* openPairing(credential);
        if (pairing.confirmationWord !== null) return yield* access("invalid");
        yield* refuseWhileBackingOff(row);
        const expected = yield* pairingCode(row);
        const entered = request.code.replaceAll(/\s/g, "");
        if (
          !timingSafeEqualBase64Url(
            base64UrlEncode(entered.padEnd(expected.length, " ")),
            base64UrlEncode(expected),
          )
        ) {
          const { locked, attemptsLeft } = yield* recordFailedAttempt(
            row,
            pairing.deviceLabel,
            "pairing.wrong-code",
          );
          return yield* new RemoteControlAccessError(
            locked ? { reason: "locked" } : { reason: "wrong_code", attemptsLeft },
          );
        }
        const sessionToken = yield* issueDevice(row, pairing, credential.transport);
        return { progress: progressOf(row, pairing, "paired"), sessionToken };
      }),
    );
  });

  /**
   * Every remote route starts here, so a session is never trusted past its last check: it must
   * exist, belong to the switch the page names, be within both expiries, and hold the level the
   * route needs now. Lowering a level or ending a session takes effect on the next request.
   */
  const authorize = Effect.fn("RemoteControlService.authorize")(function* (
    credential: RemoteDeviceCredential,
    required: RemoteControlAccessLevel,
  ) {
    if (credential.token === "") return yield* access("ended");
    const device = yield* store.deviceByTokenHash(yield* secretHash("session", credential.token));
    if (device === null || device.switchId !== credential.switchId) {
      return yield* access("ended");
    }
    const row = yield* store.switchById(device.switchId);
    if (row === null) return yield* access("ended");
    const now = yield* nowMillis;
    if (!isLiveDevice(device, now)) {
      yield* endDevice(device, row.threadId, "expired", "session expired");
      return yield* access("session_expired");
    }
    if (device.boundPeer !== null && device.boundPeer !== credential.transport.peer) {
      yield* recordAudit({
        actor: asGuest(device.label),
        action: "session.wrong-address",
        outcome: "denied",
        threadId: row.threadId,
      });
      return yield* access("ended");
    }
    const thread = yield* threadRecord(row.threadId);
    if (
      thread === null ||
      thread.lineage.orchestrator === true ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    ) {
      yield* serialized(endSwitch(row, "archived", { kind: "user" }));
      return yield* access("ended");
    }
    const level = credential.transport.encrypted
      ? row.accessLevel
      : lowerRemoteControlLevel(row.accessLevel, REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP);
    if (!remoteControlLevelAllows(level, required)) {
      yield* recordAudit({
        actor: asGuest(device.label),
        action: `${required}.refused`,
        outcome: "denied",
        threadId: row.threadId,
        result: `level ${level}`,
      });
      return yield* access(
        remoteControlLevelAllows(row.accessLevel, required) ? "unencrypted" : "forbidden",
      );
    }
    if (now - device.lastSeenAt >= TOUCH_THROTTLE_MS) yield* store.touchDevice(device.id, now);
    return { device, row, thread, level, transport: credential.transport };
  });

  /** A level check, then the owner's own choice. Every permission needs an encrypted route. */
  const authorizePermission = Effect.fn("RemoteControlService.authorizePermission")(function* (
    credential: RemoteDeviceCredential,
    permission: RemoteControlPermission,
  ) {
    const authorized = yield* authorize(credential, "view");
    const allowed = authorized.row.permissions.includes(permission);
    if (!allowed || !credential.transport.encrypted) {
      yield* recordAudit({
        actor: asGuest(authorized.device.label),
        action: `${permission}.refused`,
        outcome: "denied",
        threadId: authorized.row.threadId,
      });
      return yield* access(allowed ? "unencrypted" : "forbidden");
    }
    return authorized;
  });

  /** Records what a device just did, in the trail and where the owner sees it. */
  const noteAction = Effect.fn("RemoteControlService.noteAction")(function* (
    device: StoredDevice,
    threadId: ThreadId,
    input: {
      readonly action: string;
      readonly label: string;
      readonly request?: string;
      readonly result?: string;
    },
  ) {
    yield* store.recordDeviceAction(device.id, input.label, yield* nowMillis);
    yield* recordAudit({
      actor: asGuest(device.label),
      action: input.action,
      threadId,
      target: { kind: "device", id: device.id, label: device.label },
      ...(input.request === undefined ? {} : { request: input.request }),
      ...(input.result === undefined ? {} : { result: input.result }),
    });
    yield* publishChange(device.switchId);
  });

  const session: RemoteControlService["Service"]["session"] = Effect.fn(
    "RemoteControlService.session",
  )(function* (credential, required = "view") {
    yield* authorize(credential, required);
  });

  const signOut: RemoteControlService["Service"]["signOut"] = Effect.fn(
    "RemoteControlService.signOut",
  )(function* (credential) {
    const { device, row } = yield* authorize(credential, "view");
    yield* endDevice(device, row.threadId, "signed_out", "signed out on the device");
  });

  const sessionLifetimeMs: RemoteControlService["Service"]["sessionLifetimeMs"] = Effect.fn(
    "RemoteControlService.sessionLifetimeMs",
  )(function* (credential) {
    const { device } = yield* authorize(credential, "view");
    const now = yield* nowMillis;
    return device.access === "forever"
      ? MAX_COOKIE_MS
      : Math.min(device.expiresAt - now, MAX_COOKIE_MS);
  });

  const viewOf = Effect.fn("RemoteControlService.viewOf")(function* (
    deviceId: string,
    switchId: string,
    transport: RemoteTransport,
    thread: OrchestrationV2AppThread,
  ) {
    const row = yield* store.switchById(switchId);
    const device = yield* store.deviceById(deviceId);
    if (row === null || device === null) return null;
    const providers = yield* providerRegistry.getProviders;
    const peers = yield* store.devicesOf(switchId);
    const now = yield* nowMillis;
    const queue = thread.guestShare?.id === row.shareId ? thread.guestShare.messages : [];
    return {
      shareId: RemoteControlSwitchId.make(row.switchId),
      title: thread.title,
      deviceId: RemoteControlDeviceId.make(device.id),
      deviceLabel: GuestDisplayName.make(device.label),
      level: transport.encrypted
        ? row.accessLevel
        : lowerRemoteControlLevel(row.accessLevel, REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP),
      grantedLevel: row.accessLevel,
      encrypted: transport.encrypted,
      ownerReview: row.ownerReview,
      permissions: transport.encrypted ? row.permissions : [],
      grantedPermissions: row.permissions,
      ...deviceExpiry(device),
      capabilityMode: thread.capabilityMode ?? "code",
      modelSelection: thread.modelSelection,
      messages: queue,
      model: guestThreadModel(thread.modelSelection, providers),
      otherDevices: peers
        .filter((peer) => peer.id !== device.id && isLiveDevice(peer, now))
        .map((peer) => ({
          label: GuestDisplayName.make(peer.label),
          connected: connectedStreams.has(peer.id),
        })),
    } satisfies RemoteControlView;
  });

  const readerKey = (device: StoredDevice) => `remote:${device.id}`;

  const rememberItem = (key: string, item: OrchestrationV2ThreadStreamItem) => {
    if (item.kind === "snapshot") {
      shared.rememberSent(
        key,
        item.projection.visibleTurnItems.map((row) => row.item),
      );
    } else if (item.kind === "event" && item.event.type === "turn-item.updated") {
      shared.rememberSent(key, [item.event.payload]);
    }
  };

  /** Resolves when the device's session ends, however it ends. */
  const sessionEnd = Effect.fn("RemoteControlService.sessionEnd")(function* (device: StoredDevice) {
    const ended = yield* watchDevice(device);
    // Read each time: the owner can change this device's limit while its page stays open.
    const expiry: Effect.Effect<RemoteControlEndReason> = Effect.gen(function* () {
      while (true) {
        const current = yield* store.deviceById(device.id);
        if (current === null) return "expired" as const;
        const remaining =
          current.access === "forever"
            ? MAX_EXPIRY_WAIT_MS
            : current.expiresAt - (yield* nowMillis);
        if (remaining <= 0) return "expired" as const;
        yield* Effect.sleep(Duration.millis(Math.min(remaining, MAX_EXPIRY_WAIT_MS)));
      }
    });
    return Effect.raceFirst(Deferred.await(ended), expiry);
  });

  const stream: RemoteControlService["Service"]["stream"] = Effect.fn(
    "RemoteControlService.stream",
  )(function* (credential, afterSequence) {
    const { device, thread, transport } = yield* authorize(credential, "view");
    const initialView = yield* viewOf(device.id, device.switchId, transport, thread);
    if (initialView === null) return yield* access("ended");
    const key = readerKey(device);
    // After a restart the page's images are no longer on record, so it gets a snapshot again.
    const resumeFrom = shared.hasSentRecord(key) ? afterSequence : undefined;
    const items = yield* subscribeOrchestrationV2Thread({
      threadId: thread.id,
      ...(resumeFrom === undefined ? {} : { afterSequence: resumeFrom }),
      acceptBoundedSnapshot: true,
    }).pipe(
      Effect.provideContext(threadServices),
      Effect.mapError(() => access("unavailable")),
    );
    const refreshedView = Effect.fn("RemoteControlService.refreshedView")(function* (
      current: OrchestrationV2AppThread | null,
    ) {
      const latest = current ?? (yield* threadRecord(thread.id));
      if (latest === null) return [];
      const view = yield* viewOf(device.id, device.switchId, transport, latest);
      return view === null ? [] : [{ type: "view" as const, view }];
    });

    const threadEvents = items.pipe(
      // A failed read closes the response without `ended`: the page reconnects and the session
      // check decides what happens next.
      Stream.catchCause(() => Stream.empty),
      Stream.mapEffect((item) =>
        Effect.gen(function* () {
          rememberItem(key, item);
          if (item.kind !== "event") {
            return [{ type: "thread" as const, item }] as ReadonlyArray<RemoteControlStreamEvent>;
          }
          if (isEndingEvent(item.event)) {
            return [{ type: "ended" as const, reason: "archived" as const }];
          }
          const updated = threadOfEvent(item.event);
          const view = updated === null ? [] : yield* refreshedView(updated);
          return [{ type: "thread" as const, item }, ...view];
        }),
      ),
      Stream.flattenIterable,
    );
    // The watchers and counters belong to the stream's run, so a HEAD response touches nothing.
    return Stream.unwrap(
      Effect.gen(function* () {
        const end = yield* sessionEnd(device);
        const switchChanges = yield* PubSub.subscribe(changed);
        yield* shared.holdSentRecord(key);
        yield* holdConnected(device);
        yield* Effect.forkScoped(
          nowMillis.pipe(
            Effect.flatMap((now) => store.touchDevice(device.id, now)),
            Effect.delay(ACTIVE_STREAM_TOUCH_INTERVAL),
            Effect.forever,
          ),
        );
        // A session ended between the first check and the watcher starting would otherwise slip by.
        const stillOpen = yield* authorize(credential, "view").pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        const viewChanges = Stream.fromSubscription(switchChanges).pipe(
          Stream.filter((switchId) => switchId === device.switchId),
          Stream.mapEffect(() => refreshedView(null)),
          Stream.flattenIterable,
        );
        const ending = Stream.fromEffect(end).pipe(
          Stream.map((reason): RemoteControlStreamEvent => ({ type: "ended", reason })),
        );
        const opening = Stream.make<ReadonlyArray<RemoteControlStreamEvent>>({
          type: "view",
          view: initialView,
        });
        return stillOpen
          ? opening.pipe(
              Stream.concat(
                Stream.merge(Stream.merge(threadEvents, viewChanges), ending, {
                  haltStrategy: "either",
                }),
              ),
              Stream.takeUntil((event) => event.type === "ended"),
            )
          : Stream.make<ReadonlyArray<RemoteControlStreamEvent>>({
              type: "ended",
              reason: "revoked",
            });
      }),
    );
  });

  const computerService = Effect.fromOption(computerUse).pipe(
    Effect.mapError(() => access("unavailable")),
  );
  const computerStream: RemoteControlService["Service"]["computerStream"] = Effect.fn(
    "RemoteControlService.computerStream",
  )(function* (credential) {
    const { thread, device } = yield* authorize(credential, "view");
    const computer = yield* computerService;
    return Stream.unwrap(
      Effect.gen(function* () {
        const end = yield* sessionEnd(device);
        yield* authorize(credential, "view");
        yield* holdConnected(device);
        return computer.subscribe(thread.id).pipe(
          Stream.interruptWhen(end),
          Stream.catchCause(() => Stream.empty),
        );
      }),
    ).pipe(Stream.catchCause(() => Stream.empty));
  });
  const computerScreenshot: RemoteControlService["Service"]["computerScreenshot"] = Effect.fn(
    "RemoteControlService.computerScreenshot",
  )(function* (credential, stepId) {
    const { thread } = yield* authorize(credential, "view");
    return yield* (yield* computerService)
      .getScreenshot({ threadId: thread.id, stepId })
      .pipe(Effect.mapError(() => access("unavailable")));
  });
  const answerComputerApproval: RemoteControlService["Service"]["answerComputerApproval"] =
    Effect.fn("RemoteControlService.answerComputerApproval")(function* (credential, request) {
      const { thread, device } = yield* authorize(credential, "approve");
      const result = yield* (yield* computerService)
        .answerApproval({ ...request, threadId: thread.id })
        .pipe(Effect.mapError(() => access("rejected")));
      yield* noteAction(device, thread.id, {
        action: "computer.approval",
        label: "Answered a computer approval",
        result: request.approved ? "approved" : "denied",
      });
      return result;
    });
  const stopComputer: RemoteControlService["Service"]["stopComputer"] = Effect.fn(
    "RemoteControlService.stopComputer",
  )(function* (credential) {
    const { thread, device } = yield* authorize(credential, "full");
    const result = yield* (yield* computerService).stop(thread.id);
    yield* noteAction(device, thread.id, {
      action: "computer.stop",
      label: "Stopped computer use",
    });
    return result;
  });

  const item: RemoteControlService["Service"]["item"] = Effect.fn("RemoteControlService.item")(
    function* (credential, itemId) {
      const { thread } = yield* authorize(credential, "view");
      return yield* fromShared(shared.item(thread.id, itemId));
    },
  );

  const history: RemoteControlService["Service"]["history"] = Effect.fn(
    "RemoteControlService.history",
  )(function* (credential, cursor) {
    const { thread, device } = yield* authorize(credential, "view");
    return yield* fromShared(shared.history(thread.id, cursor, readerKey(device)));
  });

  const commandOutput: RemoteControlService["Service"]["commandOutput"] = Effect.fn(
    "RemoteControlService.commandOutput",
  )(function* (credential, itemId) {
    const { thread, device } = yield* authorize(credential, "view");
    return Stream.unwrap(
      Effect.gen(function* () {
        const end = yield* sessionEnd(device);
        // A session ended before the watcher started must not leave output flowing.
        yield* authorize(credential, "view");
        return yield* fromShared(shared.commandOutput(thread.id, itemId, end));
      }).pipe(Effect.orElseSucceed(() => Stream.empty)),
    );
  });

  const attachment: RemoteControlService["Service"]["attachment"] = Effect.fn(
    "RemoteControlService.attachment",
  )(function* (credential, attachmentId) {
    const { thread, row } = yield* authorize(credential, "view");
    const queue = thread.guestShare?.id === row.shareId ? thread.guestShare.messages : [];
    return yield* fromShared(shared.attachment(thread.id, queue, attachmentId));
  });

  const media: RemoteControlService["Service"]["media"] = Effect.fn("RemoteControlService.media")(
    function* (credential, path) {
      const { device } = yield* authorize(credential, "view");
      return yield* fromShared(shared.media(readerKey(device), path));
    },
  );

  const render: RemoteControlService["Service"]["render"] = Effect.fn(
    "RemoteControlService.render",
  )(function* (credential, itemId) {
    const { thread } = yield* authorize(credential, "view");
    return yield* fromShared(shared.render(thread.id, itemId));
  });

  const dispatchThroughIntake = (command: OrchestrationV2Command) =>
    ThreadMessageIntake.dispatchCommand(command).pipe(Effect.provideContext(threadServices));

  const submit: RemoteControlService["Service"]["submit"] = Effect.fn(
    "RemoteControlService.submit",
  )(function* (credential, request, uploads) {
    const { device, row, thread } = yield* authorize(credential, "chat");
    if (request.shareId !== row.switchId) return yield* access("ended");
    if (request.text === "" && uploads.length === 0) return yield* access("empty");
    const attachments = yield* fromShared(shared.storeUploads(thread.id, uploads));
    yield* Effect.gen(function* () {
      yield* ensureShare(row, thread).pipe(Effect.mapError(() => access("rejected")));
      const guestMessageId = GuestMessageId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      yield* orchestrator
        .dispatch({
          type: "thread.guest-message.submit",
          commandId: yield* commandId("message"),
          threadId: thread.id,
          shareId: GuestShareId.make(row.shareId),
          guestMessageId,
          text: request.text,
          senderName: device.label,
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(row.ownerReview ? {} : { unreviewed: true as const }),
        })
        .pipe(
          Effect.mapError((error) =>
            access(dispatchFailureReason("cause" in error ? error.cause : undefined)),
          ),
        );
      if (row.ownerReview) return;
      const sendId = yield* commandId("send");
      // A send that fails after the message was stored leaves it waiting for the owner.
      yield* dispatchThroughIntake({
        type: "message.dispatch",
        commandId: sendId,
        threadId: thread.id,
        messageId: MessageId.make(sendId),
        guestMessageId,
        text: "",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not send a remote message", { cause }),
        ),
      );
    }).pipe(Effect.onError(() => shared.removeStored(attachments)));
    yield* noteAction(device, thread.id, {
      action: "message.sent",
      label: "Sent a message",
      request: request.text,
      result: row.ownerReview ? "waiting for owner review" : "sent to the agent",
    });
  });

  const respond: RemoteControlService["Service"]["respond"] = Effect.fn(
    "RemoteControlService.respond",
  )(function* (credential, request) {
    const { device, thread } = yield* authorize(credential, "approve");
    if ((request.decision === undefined) === (request.answers === undefined)) {
      return yield* access("rejected");
    }
    const { runtimeRequests } = yield* orchestrator
      .getThreadRecords(thread.id, ["runtimeRequests"])
      .pipe(Effect.mapError(() => access("unavailable")));
    const pending = runtimeRequests.find((candidate) => candidate.id === request.requestId);
    if (
      pending === undefined ||
      pending.kind === "auth_refresh" ||
      pending.kind === "dynamic_tool_call"
    ) {
      return yield* access("unavailable");
    }
    if (pending.status !== "pending") return yield* access("answered");
    yield* dispatchThroughIntake({
      type: "runtime-request.respond",
      commandId: yield* commandId("respond"),
      threadId: thread.id,
      requestId: request.requestId,
      ...(request.decision === undefined ? {} : { decision: request.decision }),
      ...(request.answers === undefined ? {} : { answers: request.answers }),
    }).pipe(Effect.mapError(() => access("answered")));
    yield* noteAction(device, thread.id, {
      action: "approval.answered",
      label:
        request.decision === "accept"
          ? "Approved a request"
          : request.decision === "decline"
            ? "Denied a request"
            : "Answered a question",
      result: request.decision ?? "answered",
    });
  });

  const stop: RemoteControlService["Service"]["stop"] = Effect.fn("RemoteControlService.stop")(
    function* (credential) {
      const { device, thread } = yield* authorizePermission(credential, "stop");
      yield* orchestrator
        .dispatch({
          type: "thread.stop",
          commandId: yield* commandId("stop"),
          threadId: thread.id,
        })
        .pipe(Effect.mapError(() => access("rejected")));
      yield* noteAction(device, thread.id, { action: "run.stopped", label: "Stopped the run" });
    },
  );

  const setMode: RemoteControlService["Service"]["setMode"] = Effect.fn(
    "RemoteControlService.setMode",
  )(function* (credential, request) {
    const changingRun = request.interactionMode !== undefined || request.runtimeMode !== undefined;
    if (!changingRun && request.capabilityMode === undefined) return yield* access("rejected");
    const { device, thread } = yield* authorizePermission(
      credential,
      changingRun ? "mode" : "threadMode",
    );
    if (changingRun && request.capabilityMode !== undefined) {
      yield* authorizePermission(credential, "threadMode");
    }
    const dispatch = (command: OrchestrationV2Command) =>
      orchestrator.dispatch(command).pipe(Effect.mapError(() => access("rejected")));
    if (request.interactionMode !== undefined) {
      yield* dispatch({
        type: "thread.interaction-mode.set",
        commandId: yield* commandId("interaction-mode"),
        threadId: thread.id,
        interactionMode: request.interactionMode,
      });
    }
    if (request.runtimeMode !== undefined) {
      yield* dispatch({
        type: "thread.runtime-mode.set",
        commandId: yield* commandId("runtime-mode"),
        threadId: thread.id,
        runtimeMode: request.runtimeMode,
      });
    }
    if (request.capabilityMode !== undefined) {
      yield* dispatch({
        type: "thread.capability-mode.set",
        commandId: yield* commandId("capability-mode"),
        threadId: thread.id,
        capabilityMode: request.capabilityMode,
      });
    }
    yield* noteAction(device, thread.id, {
      action: "mode.changed",
      label: "Changed the mode",
      result: [request.interactionMode, request.runtimeMode, request.capabilityMode]
        .filter(Boolean)
        .join(", "),
    });
  });

  const providers: RemoteControlService["Service"]["providers"] = Effect.fn(
    "RemoteControlService.providers",
  )(function* (credential) {
    yield* authorizePermission(credential, "model");
    const all = yield* providerRegistry.getProviders;
    return { providers: all.filter((item) => item.enabled).map(providerForDevice) };
  });

  const setModel: RemoteControlService["Service"]["setModel"] = Effect.fn(
    "RemoteControlService.setModel",
  )(function* (credential, request) {
    const { device, thread } = yield* authorizePermission(credential, "model");
    const { modelSelection } = request;
    const offered = (yield* providerRegistry.getProviders).some(
      (provider) => provider.enabled && provider.instanceId === modelSelection.instanceId,
    );
    if (!offered) return yield* access("rejected");
    yield* orchestrator
      .dispatch({
        type: "thread.model-selection.set",
        commandId: yield* commandId("model-selection"),
        threadId: thread.id,
        modelSelection,
      })
      .pipe(Effect.mapError(() => access("rejected")));
    yield* noteAction(device, thread.id, {
      action: "model.changed",
      label: "Changed the model",
      result: modelSelection.model,
    });
  });

  const rename: RemoteControlService["Service"]["rename"] = Effect.fn(
    "RemoteControlService.rename",
  )(function* (credential, request) {
    const { device, thread } = yield* authorizePermission(credential, "rename");
    yield* orchestrator
      .dispatch({
        type: "thread.metadata.update",
        commandId: yield* commandId("rename"),
        threadId: thread.id,
        title: request.title,
      })
      .pipe(Effect.mapError(() => access("rejected")));
    yield* noteAction(device, thread.id, { action: "thread.renamed", label: "Renamed this" });
  });

  const orchestratorStateOf = (snapshot: OrchestratorSnapshot): RemoteControlOrchestratorState => ({
    threadId: snapshot.threadId,
    hasBrain: snapshot.brain !== null,
    availability: snapshot.availability,
    reactions: snapshot.reactions ?? {},
    ownerReadAt: snapshot.ownerReadAt ?? null,
    pendingApprovals: snapshot.pendingApprovals.length,
  });

  const orchestratorStream: RemoteControlService["Service"]["orchestratorStream"] = Effect.fn(
    "RemoteControlService.orchestratorStream",
  )(function* (credential) {
    const { device } = yield* authorizePermission(credential, "orchestrator");
    const first = yield* orchestratorAgent.snapshot.pipe(
      Effect.mapError(() => access("unavailable")),
    );
    const items =
      first.threadId === null
        ? Stream.empty
        : yield* subscribeOrchestrationV2Thread({
            threadId: first.threadId,
            acceptBoundedSnapshot: true,
          }).pipe(
            Effect.provideContext(threadServices),
            Effect.mapError(() => access("unavailable")),
          );
    const states = orchestratorAgent.changes.pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.map((snapshot): RemoteControlOrchestratorEvent => ({
        type: "state",
        state: orchestratorStateOf(snapshot),
      })),
    );
    const thread = items.pipe(
      Stream.catchCause(() => Stream.empty),
      Stream.map((item): RemoteControlOrchestratorEvent => ({ type: "thread", item })),
    );
    return Stream.unwrap(
      Effect.gen(function* () {
        const end = yield* sessionEnd(device);
        const switchChanges = yield* PubSub.subscribe(changed);
        // Turning the permission off closes a page that is already open.
        const revoked = Stream.fromSubscription(switchChanges).pipe(
          Stream.filter((switchId) => switchId === device.switchId),
          Stream.mapEffect(() =>
            authorizePermission(credential, "orchestrator").pipe(
              Effect.as(false),
              Effect.orElseSucceed(() => true),
            ),
          ),
          Stream.filter(Boolean),
        );
        const closing = Stream.merge(Stream.fromEffect(end), revoked).pipe(
          Stream.take(1),
          Stream.drain,
        );
        return Stream.merge(Stream.merge(states, thread), closing, { haltStrategy: "either" });
      }),
    );
  });

  const orchestratorSend: RemoteControlService["Service"]["orchestratorSend"] = Effect.fn(
    "RemoteControlService.orchestratorSend",
  )(function* (credential, request) {
    const { device, thread } = yield* authorizePermission(credential, "orchestrator");
    yield* orchestratorAgent
      .send({ commandId: yield* commandId("orchestrator"), text: request.text })
      .pipe(Effect.mapError(() => access("rejected")));
    yield* noteAction(device, thread.id, {
      action: "orchestrator.messaged",
      label: "Messaged the orchestrator",
    });
  });

  const orchestratorReact: RemoteControlService["Service"]["orchestratorReact"] = Effect.fn(
    "RemoteControlService.orchestratorReact",
  )(function* (credential, request) {
    yield* authorizePermission(credential, "orchestrator");
    const input = yield* decodeOrchestratorReact(request).pipe(
      Effect.mapError(() => access("rejected")),
    );
    yield* orchestratorAgent.react(input).pipe(Effect.mapError(() => access("rejected")));
  });

  const orchestratorStop: RemoteControlService["Service"]["orchestratorStop"] = Effect.fn(
    "RemoteControlService.orchestratorStop",
  )(function* (credential) {
    const { device, thread } = yield* authorizePermission(credential, "orchestrator");
    yield* orchestratorAgent.interrupt.pipe(Effect.mapError(() => access("rejected")));
    yield* noteAction(device, thread.id, {
      action: "orchestrator.stopped",
      label: "Stopped the orchestrator",
    });
  });

  const sweep = Effect.gen(function* () {
    const now = yield* nowMillis;
    const [rows, devices, pairings] = yield* Effect.all([
      store.listSwitches,
      store.listDevices,
      store.listPairings,
    ]);
    for (const row of rows) {
      const thread = yield* threadRecord(row.threadId);
      if (
        thread === null ||
        thread.lineage.orchestrator === true ||
        thread.archivedAt !== null ||
        thread.deletedAt !== null
      ) {
        yield* serialized(endSwitch(row, "archived", { kind: "user" }));
        continue;
      }
      for (const device of devices) {
        if (device.switchId === row.switchId && !isLiveDevice(device, now)) {
          yield* endDevice(device, row.threadId, "expired", "session expired");
        }
      }
      // An expired pairing stays a while, so a device still polling hears why it ended.
      for (const pairing of pairings) {
        if (pairing.switchId !== row.switchId || now < pairing.expiresAt) continue;
        if (now >= pairing.expiresAt + REMOTE_CONTROL_PAIRING_TTL_MS) {
          yield* store.deletePairing(pairing.id);
        } else if (pairing.status === "pending") {
          yield* store.setPairingStatus(pairing.id, "expired");
          yield* publishChange(row.switchId);
        }
      }
    }
  });

  yield* Effect.forkScoped(
    sweep.pipe(
      // One bad pass must not end expiry for the life of the server.
      Effect.catchCause((cause) => Effect.logWarning("Remote control sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
    ),
  );

  // Archiving ends the switch for good; unarchiving brings nothing back.
  yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(isEndingEvent),
    Stream.runForEach((event) =>
      Effect.flatMap(store.switchByThread(event.threadId), (row) =>
        row === null ? Effect.void : serialized(endSwitch(row, "archived", { kind: "user" })),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  // Subscribed before the first read, so a change between them is never missed.
  const changes = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromEffect(snapshot).pipe(
        Stream.concat(Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot))),
      ),
    ),
  );

  return RemoteControlService.of({
    reachability,
    changes,
    enable,
    update,
    disable,
    rotateLink,
    revealLink,
    revokeDevice,
    setDeviceAccess,
    resolvePairing,
    startPairing,
    pairingStatus,
    submitCode,
    session,
    sessionLifetimeMs,
    signOut,
    stream,
    item,
    history,
    commandOutput,
    attachment,
    media,
    render,
    submit,
    respond,
    stop,
    setMode,
    setModel,
    rename,
    providers,
    orchestratorStream,
    orchestratorSend,
    orchestratorReact,
    orchestratorStop,
    computerStream,
    computerScreenshot,
    answerComputerApproval,
    stopComputer,
  });
});

export const layer = Layer.effect(RemoteControlService, make);
