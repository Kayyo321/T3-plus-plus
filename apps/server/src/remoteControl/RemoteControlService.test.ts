import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  GuestDisplayName,
  GuestShareId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  REMOTE_CONTROL_CODE_DIGITS,
  REMOTE_CONTROL_DEVICE_UPLOAD_BYTES_PER_HOUR,
  REMOTE_CONTROL_INACTIVITY_TTL_MS,
  REMOTE_CONTROL_LINK_TTL_MS,
  REMOTE_CONTROL_MAX_FAILED_ATTEMPTS,
  REMOTE_CONTROL_PAIRING_TTL_MS,
  REMOTE_CONTROL_SESSION_TTL_MS,
  type RemoteControlAccessLevel,
  type RemoteControlDeviceAccess,
  type RemoteControlEndReason,
  type RemoteControlStreamEvent,
  RuntimeRequestId,
  type ServerDirectEndpoint,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { DEFAULT_TEAM_SHEET, teamMemberId } from "@t3tools/shared/teamSheets";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerUseService from "../computerUse/ComputerUseService.ts";
import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CloudManagedEndpointRuntime } from "../cloud/ManagedEndpointRuntime.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as OrchestratorAgent from "../orchestratorAgent/OrchestratorAgent.ts";
import { RemoteRelayTunnel } from "./RemoteRelayTunnel.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamworkStore from "../teamwork/TeamworkStore.ts";
import * as RemoteControl from "./RemoteControlService.ts";
import type { RemoteTransport } from "./remoteRoutes.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for remote control"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerCleanup = Layer.succeed(ResourceCleanupService.ResourceCleanupService, {
  cleanupScheduledTasks: () => Effect.void,
  cleanupTerminals: () => Effect.void,
  cleanupPreviews: () => Effect.void,
  cleanupAttachments: () => Effect.void,
});

const LAN: ServerDirectEndpoint = { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" };
const endpoints = Ref.makeUnsafe<ReadonlyArray<ServerDirectEndpoint>>([LAN]);
const layerEndpoints = Layer.succeed(DirectEndpoints.DirectEndpoints, {
  resolve: () => Ref.get(endpoints),
});
const layerRemoteRelay = Layer.mock(RemoteRelayTunnel)({ publicUrl: Effect.succeed(null) });
const orchestratorMessages: Array<string> = [];
const layerOrchestratorAgent = Layer.mock(OrchestratorAgent.OrchestratorAgent)({
  send: (input) =>
    Effect.sync(() => {
      orchestratorMessages.push(input.text);
      return { threadId: ThreadId.make("thread:orchestrator") };
    }),
});
const connectHost = Ref.makeUnsafe<string | null>(null);
const layerConnect = Layer.mock(CloudManagedEndpointRuntime)({
  inspectConnector: Effect.map(Ref.get(connectHost), (hostname) => ({
    readyConnections: 1,
    hostname,
    protocol: "http2",
  })),
});
const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
  getProviders: Effect.succeed([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated", email: "owner@example.com" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      runtimePaths: { homePath: "/home/owner/.codex", shadowHomePath: null },
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider,
  ]),
});
const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-control-" });

const layerOrchestration = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EventStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "remote-control-service" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerThreads = ThreadManagementService.layer.pipe(
  Layer.provideMerge(layerOrchestration),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(layerCleanup),
);

const computerState = (id: ThreadId) => ({
  threadId: id,
  status: "off" as const,
  target: null,
  startedAt: null,
  display: null,
  pendingApproval: null,
});
const layerComputer = Layer.mock(ComputerUseService.ComputerUseService)({
  subscribe: (id) =>
    Stream.make({ state: computerState(id), recentSteps: [] }).pipe(Stream.concat(Stream.never)),
  getScreenshot: ({ threadId: id }) =>
    Effect.succeed({ mimeType: "image/png", data: Buffer.from(id).toString("base64") }),
  answerApproval: ({ threadId: id }) => Effect.succeed(computerState(id)),
  stop: (id) => Effect.succeed(computerState(id)),
});

const layerTest = RemoteControl.layer.pipe(
  Layer.provide(layerComputer),
  Layer.provideMerge(TeamworkStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(CommandOutputHub.layer.pipe(Layer.provideMerge(layerThreads))),
  Layer.provideMerge(AuditTrail.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(OrchestrationEventStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(Layer.mock(DocumentText.DocumentText)({})),
  Layer.provide(layerEndpoints),
  Layer.provide(layerRemoteRelay),
  Layer.provide(layerOrchestratorAgent),
  Layer.provide(layerConnect),
  Layer.provide(layerProviders),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const ENCRYPTED: RemoteTransport = { peer: "127.0.0.1", https: true, encrypted: true };
const PLAIN: RemoteTransport = { peer: "192.168.1.20", https: false, encrypted: false };
const threadId = ThreadId.make("thread:remote-control");
const otherThreadId = ThreadId.make("thread:remote-control-other");
const label = GuestDisplayName.make("Pixel 8");

const createThread = Effect.fn(function* (id: ThreadId, orchestratorAgent = false) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId: id,
    projectId: ProjectId.make("project:remote-control"),
    title: "Ship it",
    ...(orchestratorAgent ? { orchestratorAgent: true } : {}),
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

const service = RemoteControl.RemoteControlService;

const setup = Effect.fn(function* () {
  yield* Ref.set(endpoints, [LAN]);
  yield* Ref.set(connectHost, null);
  yield* createThread(threadId);
  return yield* service;
});

const credentialOf = (url: string) => url.slice(url.indexOf("#") + 1);

const deviceFor = (switchId: string, token: string, transport: RemoteTransport = ENCRYPTED) => ({
  switchId,
  token,
  transport,
});

/** Turns the switch on and pairs one device with the owner's approval. */
const pairDevice = Effect.fn(function* (
  input: {
    readonly accessLevel?: RemoteControlAccessLevel;
    readonly ownerReview?: boolean;
    readonly transport?: RemoteTransport;
    readonly thread?: ThreadId;
  } = {},
) {
  const remote = yield* service;
  const target = input.thread ?? threadId;
  const transport = input.transport ?? ENCRYPTED;
  const { remoteSwitch, link } = yield* remote.enable({
    threadId: target,
    ...(input.accessLevel === undefined ? {} : { accessLevel: input.accessLevel }),
    ...(input.ownerReview === undefined ? {} : { ownerReview: input.ownerReview }),
    confirmRaise: true,
  });
  const started = yield* remote.startPairing(
    { credential: credentialOf(link.routes[0].url), deviceLabel: label },
    transport,
  );
  const snapshot = yield* Stream.runHead(remote.changes);
  const pending = Option.getOrThrow(snapshot).switches.find(
    (candidate) => candidate.threadId === target,
  )?.pendingPairings[0];
  assert.isDefined(pending);
  yield* remote.resolvePairing({ threadId: target, pairingId: pending!.id, decision: "approve" });
  const outcome = yield* remote.pairingStatus({
    switchId: remoteSwitch.switchId,
    secret: started.pairingSecret,
    transport,
  });
  assert.isNotNull(outcome.sessionToken);
  return deviceFor(remoteSwitch.switchId, outcome.sessionToken!, transport);
});

const failureReason = <A, R>(
  effect: Effect.Effect<A, { readonly reason: string }, R>,
): Effect.Effect<string, never, R> =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => {
      if (Exit.isSuccess(exit)) return "ok";
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
      return failure?._tag === "Fail" ? failure.error.reason : "defect";
    }),
  );

const auditActions = Effect.gen(function* () {
  const trail = yield* AuditTrail.AuditTrail;
  const { entries } = yield* trail.list({ domain: "remote-control", limit: 200 });
  return entries.toReversed();
});

it.effect("spends a link once, so a replay or a second browser never gets in", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link } = yield* remote.enable({ threadId });
    const credential = credentialOf(link.routes[0].url);
    yield* remote.startPairing({ credential, deviceLabel: label }, ENCRYPTED);
    const eve = GuestDisplayName.make("Eve");
    assert.equal(
      yield* failureReason(remote.startPairing({ credential, deviceLabel: eve }, ENCRYPTED)),
      "used",
    );
    // The spent link is gone from the owner's sheet too.
    assert.isNull(yield* remote.revealLink({ threadId }));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not let a leaked link in until the owner allows that device", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId });
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    assert.isNull(started.sessionToken);
    const pairing = {
      switchId: remoteSwitch.switchId,
      secret: started.pairingSecret,
      transport: ENCRYPTED,
    };
    const waiting = yield* remote.pairingStatus(pairing);
    assert.isNull(waiting.sessionToken);
    assert.equal(waiting.progress.status, "waiting");
    assert.isString(waiting.progress.confirmationWord);

    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    const pending = snapshot.switches[0]!.pendingPairings[0]!;
    assert.equal(pending.confirmationWord, waiting.progress.confirmationWord);

    yield* remote.resolvePairing({ threadId, pairingId: pending.id, decision: "deny" });
    assert.equal(yield* failureReason(remote.pairingStatus(pairing)), "denied");
    // A guess at the pairing secret reaches nothing.
    assert.equal(
      yield* failureReason(remote.pairingStatus({ ...pairing, secret: "not-the-secret" })),
      "invalid",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("issues a session once, to the browser that asked", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    assert.equal(yield* failureReason(remote.session(device)), "ok");
    // The pairing cookie cannot mint a second session.
    const { remoteSwitch } = yield* remote.enable({ threadId });
    assert.equal(
      yield* failureReason(remote.session({ ...device, switchId: "another-switch" })),
      "ended",
    );
    assert.equal(remoteSwitch.devices.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("locks the link after repeated wrong codes, and rate limits each guess", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId, pairingMode: "code" });
    assert.lengthOf(link.code ?? "", REMOTE_CONTROL_CODE_DIGITS);
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    assert.isNull(started.progress.confirmationWord);
    const pairing = {
      switchId: remoteSwitch.switchId,
      secret: started.pairingSecret,
      transport: ENCRYPTED,
    };
    const wrong = link.code === "00000000" ? "11111111" : "00000000";
    for (let attempt = 1; attempt < REMOTE_CONTROL_MAX_FAILED_ATTEMPTS; attempt += 1) {
      const exit = yield* Effect.exit(remote.submitCode(pairing, { code: wrong }));
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(
        yield* failureReason(remote.submitCode(pairing, { code: link.code! })),
        "rate_limited",
      );
      yield* TestClock.adjust(Duration.seconds(20));
    }
    assert.equal(yield* failureReason(remote.submitCode(pairing, { code: wrong })), "locked");
    // Even the right code is refused now, and only a new link helps.
    assert.equal(yield* failureReason(remote.submitCode(pairing, { code: link.code! })), "invalid");
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    assert.equal(snapshot.switches[0]!.linkStatus, "locked");

    const fresh = yield* remote.rotateLink({ threadId });
    assert.notEqual(fresh.code, link.code);
    const retried = yield* remote.startPairing(
      { credential: credentialOf(fresh.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    const paired = yield* remote.submitCode(
      { ...pairing, secret: retried.pairingSecret },
      { code: fresh.code! },
    );
    assert.isNotNull(paired.sessionToken);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reports attempts left on a wrong code", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId, pairingMode: "code" });
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    const error = yield* remote
      .submitCode(
        { switchId: remoteSwitch.switchId, secret: started.pairingSecret, transport: ENCRYPTED },
        { code: "12" },
      )
      .pipe(Effect.flip);
    assert.equal(error.reason, "wrong_code");
    assert.equal(error.attemptsLeft, REMOTE_CONTROL_MAX_FAILED_ATTEMPTS - 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a refused code-mode device out, even with the right code", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId, pairingMode: "code" });
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    const pending = snapshot.switches[0]!.pendingPairings[0]!;
    // The code is this mode's approval, so the owner can only refuse.
    assert.equal(
      yield* failureReason(
        remote.resolvePairing({ threadId, pairingId: pending.id, decision: "approve" }),
      ),
      "not_found",
    );
    yield* remote.resolvePairing({ threadId, pairingId: pending.id, decision: "deny" });
    assert.equal(
      yield* failureReason(
        remote.submitCode(
          { switchId: remoteSwitch.switchId, secret: started.pairingSecret, transport: ENCRYPTED },
          { code: link.code! },
        ),
      ),
      "denied",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("counts forged links against the switch and locks it", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { remoteSwitch, link } = yield* remote.enable({ threadId });
    const forged = `${remoteSwitch.switchId}.1.${"A".repeat(43)}`;
    for (let attempt = 1; attempt < REMOTE_CONTROL_MAX_FAILED_ATTEMPTS; attempt += 1) {
      assert.equal(
        yield* failureReason(
          remote.startPairing({ credential: forged, deviceLabel: label }, PLAIN),
        ),
        "invalid",
      );
      yield* TestClock.adjust(Duration.minutes(2));
    }
    assert.equal(
      yield* failureReason(remote.startPairing({ credential: forged, deviceLabel: label }, PLAIN)),
      "locked",
    );
    // Repeated failures disable the real link too.
    assert.equal(
      yield* failureReason(
        remote.startPairing(
          { credential: credentialOf(link.routes[0].url), deviceLabel: label },
          ENCRYPTED,
        ),
      ),
      "locked",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("kills a pending link and its pairings when the owner rotates", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId });
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    const fresh = yield* remote.rotateLink({ threadId });
    assert.notEqual(fresh.routes[0].url, link.routes[0].url);
    assert.equal(
      yield* failureReason(
        remote.pairingStatus({
          switchId: remoteSwitch.switchId,
          secret: started.pairingSecret,
          transport: ENCRYPTED,
        }),
      ),
      "invalid",
    );
    assert.equal(
      yield* failureReason(
        remote.startPairing(
          { credential: credentialOf(link.routes[0].url), deviceLabel: label },
          ENCRYPTED,
        ),
      ),
      "used",
    );
    // A link from an earlier generation is stale, not a guess, so it costs no attempts.
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    assert.equal(snapshot.switches[0]!.linkStatus, "ready");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("expires an unused link and an unanswered pairing", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const { link, remoteSwitch } = yield* remote.enable({ threadId });
    const credential = credentialOf(link.routes[0].url);
    yield* TestClock.adjust(Duration.millis(REMOTE_CONTROL_LINK_TTL_MS));
    assert.equal(
      yield* failureReason(remote.startPairing({ credential, deviceLabel: label }, ENCRYPTED)),
      "link_expired",
    );
    assert.isNull(yield* remote.revealLink({ threadId }));

    const fresh = yield* remote.rotateLink({ threadId });
    const started = yield* remote.startPairing(
      { credential: credentialOf(fresh.routes[0].url), deviceLabel: label },
      ENCRYPTED,
    );
    yield* TestClock.adjust(Duration.millis(REMOTE_CONTROL_PAIRING_TTL_MS));
    assert.equal(
      yield* failureReason(
        remote.pairingStatus({
          switchId: remoteSwitch.switchId,
          secret: started.pairingSecret,
          transport: ENCRYPTED,
        }),
      ),
      "pairing_expired",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ends a session after inactivity, and after its lifetime however active it is", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const idle = yield* pairDevice();
    yield* TestClock.adjust(Duration.millis(REMOTE_CONTROL_INACTIVITY_TTL_MS));
    assert.equal(yield* failureReason(remote.session(idle)), "ended");
    assert.lengthOf(
      Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!.devices,
      0,
    );

    yield* remote.disable({ threadId });
    const active = yield* pairDevice();
    const step = REMOTE_CONTROL_INACTIVITY_TTL_MS - 60_000;
    for (let elapsed = 0; elapsed + step < REMOTE_CONTROL_SESSION_TTL_MS; elapsed += step) {
      yield* TestClock.adjust(Duration.millis(step));
      assert.equal(yield* failureReason(remote.session(active)), "ok");
    }
    yield* TestClock.adjust(Duration.millis(step));
    assert.equal(yield* failureReason(remote.session(active)), "ended");
  }).pipe(Effect.provide(layerTest)),
);

const collectUntilEnded = (events: Stream.Stream<RemoteControlStreamEvent>) =>
  Effect.gen(function* () {
    const collected: Array<RemoteControlStreamEvent> = [];
    yield* Stream.runForEach(events, (event) => Effect.sync(() => collected.push(event)));
    return collected;
  });

const endOf = (events: ReadonlyArray<RemoteControlStreamEvent>) => {
  const last = events.at(-1);
  return last?.type === "ended" ? last.reason : null;
};

const expectStreamEnds = Effect.fn(function* <E>(
  device: RemoteControl.RemoteDeviceCredential,
  end: Effect.Effect<void, E>,
  reason: RemoteControlEndReason,
) {
  const remote = yield* service;
  const events = yield* remote.stream(device, undefined);
  const reader = yield* Effect.forkScoped(collectUntilEnded(events));
  // The session is live and the page has its first frames before anything ends it.
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(100));
  yield* end;
  const collected = yield* Fiber.join(reader);
  assert.equal(endOf(collected), reason);
});

it.effect("ends an open stream the moment one device is revoked, leaving others", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const first = yield* pairDevice();
    const link = yield* remote.rotateLink({ threadId });
    const started = yield* remote.startPairing(
      { credential: credentialOf(link.routes[0].url), deviceLabel: GuestDisplayName.make("iPad") },
      ENCRYPTED,
    );
    const pending = Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!
      .pendingPairings[0]!;
    yield* remote.resolvePairing({ threadId, pairingId: pending.id, decision: "approve" });
    const secondOutcome = yield* remote.pairingStatus({
      switchId: first.switchId,
      secret: started.pairingSecret,
      transport: ENCRYPTED,
    });
    const second = deviceFor(first.switchId, secondOutcome.sessionToken!);

    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    const target = snapshot.switches[0]!.devices.find((device) => device.label === label)!;
    const computerStarted = yield* Deferred.make<void>();
    const computer = yield* (yield* remote.computerStream(first)).pipe(
      Stream.tap((snapshot) => {
        assert.equal(snapshot.state.threadId, threadId);
        return Deferred.succeed(computerStarted, undefined);
      }),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* Deferred.await(computerStarted);
    yield* expectStreamEnds(
      first,
      remote.revokeDevice({ threadId, deviceId: target.id }),
      "revoked",
    );
    assert.equal((yield* Fiber.join(computer)).length, 1);
    assert.equal(yield* failureReason(remote.computerScreenshot(first, "step")), "ended");
    assert.equal(yield* failureReason(remote.session(first)), "ended");
    assert.equal(yield* failureReason(remote.session(second)), "ok");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends every stream when the switch goes off", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    yield* expectStreamEnds(device, remote.disable({ threadId }), "switched_off");
    assert.equal(yield* failureReason(remote.session(device)), "ended");
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    assert.lengthOf(snapshot.switches, 0);
    // The queue behind the switch went with it.
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    assert.isTrue(thread.guestShare === null || thread.guestShare === undefined);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("ends the stream at the session's absolute expiry", () =>
  Effect.gen(function* () {
    yield* setup();
    const device = yield* pairDevice();
    yield* expectStreamEnds(
      device,
      TestClock.adjust(Duration.millis(REMOTE_CONTROL_SESSION_TTL_MS)),
      "expired",
    );
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("archiving ends the switch for good", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* expectStreamEnds(
      device,
      orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-remote-thread"),
          threadId,
        })
        .pipe(Effect.asVoid),
      "archived",
    );
    assert.equal(yield* failureReason(remote.session(device)), "ended");
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("unarchive-remote-thread"),
      threadId,
    });
    assert.equal(yield* failureReason(remote.session(device)), "ended");
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    assert.lengthOf(snapshot.switches, 0);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

/** Every action a route offers, and the lowest level that may take it. */
const ACTIONS: ReadonlyArray<{
  readonly name: string;
  readonly required: RemoteControlAccessLevel;
  readonly run: (
    remote: RemoteControl.RemoteControlService["Service"],
    device: RemoteControl.RemoteDeviceCredential,
  ) => Effect.Effect<unknown, { readonly reason: string }>;
}> = [
  { name: "session", required: "view", run: (remote, device) => remote.session(device) },
  {
    name: "stream",
    required: "view",
    run: (remote, device) => remote.stream(device, undefined),
  },
  { name: "item", required: "view", run: (remote, device) => remote.item(device, "no-item") },
  {
    name: "command output",
    required: "view",
    run: (remote, device) => remote.commandOutput(device, "no-item"),
  },
  { name: "history", required: "view", run: (remote, device) => remote.history(device, "x") },
  {
    name: "attachment",
    required: "view",
    run: (remote, device) => remote.attachment(device, "no-file"),
  },
  { name: "media", required: "view", run: (remote, device) => remote.media(device, "/a.png") },
  { name: "render", required: "view", run: (remote, device) => remote.render(device, "no-item") },
  {
    name: "message",
    required: "chat",
    run: (remote, device) =>
      remote.submit(device, { shareId: GuestShareId.make("x"), text: "hello" }, []),
  },
  {
    name: "respond",
    required: "approve",
    run: (remote, device) =>
      remote.respond(device, {
        requestId: RuntimeRequestId.make("no-request"),
        decision: "accept",
      }),
  },
  {
    name: "computer stream",
    required: "view",
    run: (remote, device) => remote.computerStream(device),
  },
  {
    name: "computer screenshot",
    required: "view",
    run: (remote, device) => remote.computerScreenshot(device, "step"),
  },
  {
    name: "computer approval",
    required: "approve",
    run: (remote, device) =>
      remote.answerComputerApproval(device, { approvalId: "approval", approved: true }),
  },
  { name: "computer stop", required: "full", run: (remote, device) => remote.stopComputer(device) },
  { name: "stop", required: "full", run: (remote, device) => remote.stop(device) },
  {
    name: "mode",
    required: "full",
    run: (remote, device) => remote.setMode(device, { interactionMode: "plan" }),
  },
];

const LEVEL_ORDER: ReadonlyArray<RemoteControlAccessLevel> = ["view", "chat", "approve", "full"];
const reaches = (level: RemoteControlAccessLevel, required: RemoteControlAccessLevel) =>
  LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(required);

it.effect("enforces the access level on every action", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice({ accessLevel: "view" });
    const screenshot = yield* remote.computerScreenshot(device, "step");
    assert.equal(Buffer.from(screenshot.data, "base64").toString(), threadId);
    for (const level of LEVEL_ORDER) {
      yield* remote.update({ threadId, accessLevel: level, confirmRaise: true });
      for (const action of ACTIONS) {
        const outcome = yield* failureReason(action.run(remote, device));
        assert.equal(
          outcome === "forbidden",
          !reaches(level, action.required),
          `${action.name} at ${level} was ${outcome}`,
        );
      }
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("holds a plain HTTP session at Chat whatever the owner granted", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice({ accessLevel: "full", transport: PLAIN });
    for (const action of ACTIONS) {
      const outcome = yield* failureReason(action.run(remote, device));
      assert.equal(
        outcome === "unencrypted",
        !reaches("chat", action.required),
        `${action.name} on plain HTTP was ${outcome}`,
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("ties a plain HTTP session to its address, and an encrypted one to nothing", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const plain = yield* pairDevice({ transport: PLAIN });
    const copied = { ...plain, transport: { ...PLAIN, peer: "192.168.1.66" } };
    assert.equal(yield* failureReason(remote.session(plain)), "ok");
    assert.equal(yield* failureReason(remote.session(copied)), "ended");

    yield* remote.disable({ threadId });
    const encrypted = yield* pairDevice();
    assert.equal(
      yield* failureReason(
        remote.session({ ...encrypted, transport: { ...ENCRYPTED, peer: "100.64.0.9" } }),
      ),
      "ok",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("needs the owner's confirmation to raise, and applies a lower level at once", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    assert.equal(
      yield* failureReason(remote.enable({ threadId, accessLevel: "approve" })),
      "raise_needs_confirmation",
    );
    assert.equal(
      yield* failureReason(remote.enable({ threadId, accessLevel: "full", confirmRaise: false })),
      "raise_needs_confirmation",
    );
    const device = yield* pairDevice();
    assert.equal(
      yield* failureReason(remote.update({ threadId, accessLevel: "full" })),
      "raise_needs_confirmation",
    );
    assert.equal(yield* failureReason(remote.stop(device)), "forbidden");
    yield* remote.update({ threadId, accessLevel: "view" });
    assert.equal(
      yield* failureReason(
        remote.submit(device, { shareId: GuestShareId.make(device.switchId), text: "hi" }, []),
      ),
      "forbidden",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never hands out a link with no route, and leaves the switch off", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    yield* Ref.set(endpoints, [
      { kind: "lan", httpBaseUrl: "http://127.0.0.1:3773/" },
      { kind: "lan", httpBaseUrl: "http://localhost:3773/" },
      { kind: "lan", httpBaseUrl: "http://[::1]:3773/" },
    ]);
    assert.equal(yield* failureReason(remote.enable({ threadId })), "no_route");
    assert.lengthOf(Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches, 0);
    const { routes, unavailable } = yield* remote.reachability();
    assert.lengthOf(routes, 0);
    assert.deepEqual(
      unavailable.map((option) => option.kind),
      ["relay", "lan", "tailnet", "connect"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reaches exactly one conversation", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    yield* createThread(otherThreadId);
    const device = yield* pairDevice();
    const other = yield* pairDevice({ thread: otherThreadId });
    // One switch's session opens nothing on another, even with the right cookie for a wrong page.
    assert.equal(
      yield* failureReason(remote.session({ ...device, switchId: other.switchId })),
      "ended",
    );
    assert.equal(
      yield* failureReason(
        remote.submit(device, { shareId: GuestShareId.make(other.switchId), text: "x" }, []),
      ),
      "ended",
    );
    // A request id from another conversation is not found here.
    yield* remote.update({ threadId, accessLevel: "approve", confirmRaise: true });
    assert.equal(
      yield* failureReason(
        remote.respond(device, {
          requestId: RuntimeRequestId.make("request-in-another-thread"),
          decision: "accept",
        }),
      ),
      "unavailable",
    );
    // An environment session is not a device session.
    assert.equal(
      yield* failureReason(remote.session({ ...device, token: "environment-session-token" })),
      "ended",
    );
    assert.equal(yield* failureReason(remote.session({ ...device, token: "" })), "ended");
  }).pipe(Effect.provide(layerTest)),
);

const memberThreadId = ThreadId.make("thread:remote-control-member");

/** Starts a team run on the conversation with one member session, as teamwork staffs it. */
const startTeamRun = Effect.fn(function* () {
  yield* createThread(memberThreadId);
  const store = yield* TeamworkStore.TeamworkStore;
  const run = yield* store.beginRun({
    threadId,
    sheet: DEFAULT_TEAM_SHEET,
    request: "Ship it",
    leadModel: { instanceId, model: "gpt-5.1-codex" },
  });
  const build = DEFAULT_TEAM_SHEET.nodes.find((node) => node.kind === "build")!;
  yield* store.saveRun({
    ...run,
    members: [
      ...run.members,
      {
        id: teamMemberId(build.id, "m1"),
        nodeId: build.id,
        slot: "m1",
        kind: "build",
        name: "Builder",
        threadId: memberThreadId,
        state: "invoked",
      },
    ],
  });
});

/** Leaves a question waiting in a thread, as a provider does. */
const askQuestion = Effect.fn(function* (target: ThreadId, id: string) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make(`event:${id}`),
    type: "runtime-request.updated",
    threadId: target,
    occurredAt: now,
    payload: {
      id: RuntimeRequestId.make(id),
      nodeId: NodeId.make(`node:${id}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
      resolvedAt: null,
    },
  });
});

it.effect("reports an answer the agent cannot take as rejected, not as already answered", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice({ accessLevel: "approve" });
    yield* askQuestion(threadId, "request:malformed");
    assert.equal(
      yield* failureReason(
        remote.respond(device, {
          requestId: RuntimeRequestId.make("request:malformed"),
          answers: { scope: 42 },
        }),
      ),
      "rejected",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("answers a team member's question, and nothing outside the team", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice({ accessLevel: "approve" });
    yield* startTeamRun();
    yield* askQuestion(memberThreadId, "request:member");
    const first = Option.getOrThrow(yield* Stream.runHead(yield* remote.stream(device, undefined)));
    assert.deepEqual(
      first.type === "view"
        ? first.view.teamRequests.map((member) => [
            member.memberName,
            member.runtimeRequests.map((request) => request.id),
          ])
        : [],
      [["Builder", ["request:member"]]],
    );
    yield* createThread(otherThreadId);
    yield* askQuestion(otherThreadId, "request:outside");
    assert.equal(
      yield* failureReason(
        remote.respond(device, {
          requestId: RuntimeRequestId.make("request:outside"),
          threadId: otherThreadId,
          answers: { scope: "yes" },
        }),
      ),
      "unavailable",
    );
    assert.equal(
      yield* failureReason(
        remote.respond(device, {
          requestId: RuntimeRequestId.make("request:member"),
          threadId: memberThreadId,
          decision: "decline",
        }),
      ),
      "ok",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a thread with a guest link, and refuses a guest link while on", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.guest-share.open",
      commandId: CommandId.make("open-guest-link"),
      threadId,
      shareId: GuestShareId.make("guest-link"),
      host: "env.t3.test",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    assert.equal(yield* failureReason(remote.enable({ threadId })), "guest_link_active");
    yield* orchestrator.dispatch({
      type: "thread.guest-share.close",
      commandId: CommandId.make("close-guest-link"),
      threadId,
    });
    assert.equal(yield* failureReason(remote.enable({ threadId })), "ok");
  }).pipe(Effect.provide(layerTest)),
);

it("holds each device to its hourly file budget", () => {
  const full = RemoteControl.chargeUploadWindow(
    undefined,
    0,
    REMOTE_CONTROL_DEVICE_UPLOAD_BYTES_PER_HOUR,
  );
  assert.isNotNull(full);
  assert.isNull(RemoteControl.chargeUploadWindow(full!, 60_000, 1));
  assert.isNotNull(RemoteControl.chargeUploadWindow(full!, 60 * 60 * 1000, 1));
});

it.effect("sends a message as its device, and records who sent what", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    yield* remote.submit(
      device,
      { shareId: GuestShareId.make(device.switchId), text: "Please run the tests" },
      [],
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages, thread } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    const sent = messages.findLast((message) => message.role === "user");
    assert.equal(
      sent?.text,
      "Message from remote device Pixel 8, not reviewed by the owner:\n\nPlease run the tests",
    );
    assert.equal(thread.guestShare?.messages[0]?.status, "sent");
    assert.equal(thread.guestShare?.messages[0]?.senderName, "Pixel 8");

    const entries = yield* auditActions;
    const message = entries.find((entry) => entry.action === "message.sent");
    assert.equal(message?.actor, "remote-guest");
    assert.equal(message?.actorLabel, "Pixel 8");
    assert.equal(message?.request, "Please run the tests");
    assert.isTrue(entries.some((entry) => entry.action === "device.joined"));
    assert.isTrue(
      Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!.devices[0]!
        .lastAction === "Sent a message",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("holds a message for the owner when review is on", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice({ ownerReview: true });
    yield* remote.submit(
      device,
      { shareId: GuestShareId.make(device.switchId), text: "Delete the build" },
      [],
    );
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages, thread } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    assert.isFalse(messages.some((message) => message.text.includes("Delete the build")));
    const queued = thread.guestShare?.messages[0];
    assert.equal(queued?.status, "pending");
    assert.isUndefined(queued?.unreviewed);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("resumes from the last event the page holds, without a new snapshot", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const first = yield* remote.stream(device, undefined);
    const opened = yield* Stream.runCollect(Stream.take(first, 2));
    const snapshotItem = Array.from(opened).find((event) => event.type === "thread");
    assert.equal(snapshotItem?.type === "thread" && snapshotItem.item.kind, "snapshot");
    const sequence = yield* orchestrator.getThreadEventSequence(threadId);

    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make("rename-remote-thread"),
      threadId,
      title: "Renamed while asleep",
    });
    const resumed = yield* remote.stream(device, sequence);
    const replayed = Array.from(yield* Stream.runCollect(Stream.take(resumed, 2)));
    assert.deepEqual(
      replayed.map((event) => (event.type === "thread" ? event.item.kind : event.type)),
      ["view", "event"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("audits a revoke against the device, with the owner as its cause", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    yield* pairDevice();
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    yield* remote.revokeDevice({ threadId, deviceId: snapshot.switches[0]!.devices[0]!.id });
    const entry = (yield* auditActions).find((candidate) => candidate.action === "device.revoked");
    assert.equal(entry?.actor, "remote-guest");
    assert.equal(entry?.actorLabel, "Pixel 8");
    assert.equal(entry?.request, "revoked by owner");
  }).pipe(Effect.provide(layerTest)),
);

const HOUR = Duration.hours(1);

it.effect("keeps a device signed in for as long as the owner chose, past the standard limits", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const { deviceId } = yield* remote.session(device).pipe(
      Effect.andThen(Stream.runHead(remote.changes)),
      Effect.map((snapshot) => ({
        deviceId: Option.getOrThrow(snapshot).switches[0]!.devices[0]!.id,
      })),
    );
    const choose = (access: RemoteControlDeviceAccess, confirmRaise?: boolean) =>
      remote.setDeviceAccess({
        threadId,
        deviceId,
        access,
        ...(confirmRaise === undefined ? {} : { confirmRaise }),
      });

    assert.equal(yield* failureReason(choose("forever")), "raise_needs_confirmation");
    yield* choose("forever", true);
    const listed = Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!
      .devices[0]!;
    assert.equal(listed.access, "forever");
    assert.isNull(listed.expiresAt);
    assert.isNull(listed.idleExpiresAt);

    // Far past both the 2 hour idle limit and the 12 hour limit.
    yield* TestClock.adjust(Duration.days(90));
    assert.equal(yield* failureReason(remote.session(device)), "ok");

    // A fixed term ignores idling, then ends when it says it will.
    yield* choose("1d", true);
    yield* TestClock.adjust(Duration.hours(23));
    assert.equal(yield* failureReason(remote.session(device)), "ok");
    yield* TestClock.adjust(HOUR);
    assert.notEqual(yield* failureReason(remote.session(device)), "ok");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("still ends a forever session when the owner disconnects it", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    const deviceId = snapshot.switches[0]!.devices[0]!.id;
    yield* remote.setDeviceAccess({ threadId, deviceId, access: "forever", confirmRaise: true });
    yield* remote.revokeDevice({ threadId, deviceId });
    assert.equal(yield* failureReason(remote.session(device)), "ended");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps a plain HTTP device to the standard limit", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    yield* pairDevice({ transport: PLAIN });
    const snapshot = Option.getOrThrow(yield* Stream.runHead(remote.changes));
    const deviceId = snapshot.switches[0]!.devices[0]!.id;
    assert.equal(
      yield* failureReason(
        remote.setDeviceAccess({ threadId, deviceId, access: "forever", confirmRaise: true }),
      ),
      "needs_encrypted",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("lets a device change only what the owner granted, and only when encrypted", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const modelSelection = { instanceId, model: "gpt-5.1-codex" };
    const asked = { modelSelection };
    const orchestratorAsk = { text: "Check the build" };

    assert.equal(yield* failureReason(remote.setModel(device, asked)), "forbidden");
    assert.equal(
      yield* failureReason(remote.orchestratorSend(device, orchestratorAsk)),
      "forbidden",
    );
    assert.equal(
      yield* failureReason(remote.update({ threadId, permissions: ["model"] })),
      "raise_needs_confirmation",
    );

    yield* remote.update({ threadId, permissions: ["model"], confirmRaise: true });
    assert.equal(yield* failureReason(remote.setModel(device, asked)), "ok");
    assert.equal(yield* failureReason(remote.rename(device, { title: "Renamed" })), "forbidden");
    assert.equal(
      yield* failureReason(remote.setModel({ ...device, transport: PLAIN }, asked)),
      "unencrypted",
    );

    yield* remote.update({ threadId, permissions: ["orchestrator"], confirmRaise: true });
    assert.equal(yield* failureReason(remote.setModel(device, asked)), "forbidden");
    assert.equal(yield* failureReason(remote.orchestratorSend(device, orchestratorAsk)), "ok");
    assert.isTrue(orchestratorMessages.includes("Check the build"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("gives Full everything in the conversation but never the orchestrator", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    yield* pairDevice({ accessLevel: "full" });
    const full = Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!;
    assert.isTrue(full.permissions.includes("model"));
    assert.isFalse(full.permissions.includes("orchestrator"));

    yield* remote.update({ threadId, accessLevel: "chat" });
    const lowered = Option.getOrThrow(yield* Stream.runHead(remote.changes)).switches[0]!;
    assert.deepEqual(lowered.permissions, []);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("shows a device the conversation's real mode, not its access level", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const events = yield* remote.stream(device, undefined);
    const first = Option.getOrThrow(yield* Stream.runHead(events));
    assert.equal(first.type, "view");
    if (first.type !== "view") return;
    assert.equal(first.view.level, "chat");
    assert.equal(first.view.capabilityMode, "code");
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);

it.effect("never gives a device the owner's accounts or paths", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    yield* remote.update({ threadId, permissions: ["model"], confirmRaise: true });
    const { providers } = yield* remote.providers(device);
    const text = JSON.stringify(providers);
    assert.isFalse(text.includes("owner@example.com"));
    assert.isFalse(text.includes("/home/owner"));
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never puts a credential in what owners or the audit trail can read", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const device = yield* pairDevice();
    const { link } = yield* remote.enable({ threadId });
    const snapshot = JSON.stringify(yield* Stream.runHead(remote.changes));
    const trail = JSON.stringify(yield* auditActions);
    for (const secret of [device.token, credentialOf(link.routes[0].url)]) {
      assert.notInclude(snapshot, secret);
      assert.notInclude(trail, secret);
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never shares the owner orchestrator with remote guests", () =>
  Effect.gen(function* () {
    const remote = yield* setup();
    const id = ThreadId.make("private-orchestrator");
    yield* createThread(id, true);
    const error = yield* remote.enable({ threadId: id }).pipe(Effect.flip);
    assert.equal(error.reason, "thread_unavailable");
  }).pipe(Effect.provide(layerTest)),
);
