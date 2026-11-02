import {
  type AuditOutcome,
  CommandId,
  DEFAULT_ORCHESTRATOR_GRANTS,
  DEFAULT_SUPERVISION_THRESHOLDS,
  IsoDateTime,
  MessageId,
  ORCHESTRATOR_SILENT_REPLY,
  type OrchestrationV2ThreadShell,
  ModelSelection,
  type OrchestratorAnswerApprovalInput,
  OrchestratorAgentError,
  OrchestratorApproval,
  OrchestratorApprovalId,
  type OrchestratorBrainAvailability,
  OrchestratorGrants,
  OrchestratorMcpFailure,
  type OrchestratorMarkReadInput,
  OrchestratorNeedsAttention,
  OrchestratorReaction,
  type OrchestratorReactInput,
  type OrchestratorSendInput,
  type OrchestratorSendResult,
  type OrchestratorSetBrainInput,
  type OrchestratorSnapshot,
  type OrchestratorUiDirective,
  orchestratorBrainAvailability,
  type ServerProvider,
  type ScheduledTaskId,
  RunId,
  type SupervisionMode,
  SupervisionThresholds,
  ThreadId,
} from "@t3tools/contracts";
import { derive as deriveId } from "@t3tools/provider-core/server/IdAllocator";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestratorTurnContext from "./OrchestratorTurnContext.ts";
import {
  grantDecision,
  ORCHESTRATOR_TOOL_POLICY,
  type OrchestratorToolPolicy,
  type StartedThread,
  startedThreadsFrom,
} from "./toolPolicy.ts";

const APPROVAL_WAIT = Duration.minutes(10);
const REFRESH_WAIT = Duration.seconds(5);
const AUDIT_PARAMS_MAX_CHARS = 400;
const REACTION_CAP = 200;
const FOLLOWED_CAP = 20;

const ReviewContext = Schema.Struct({ threadId: ThreadId, runId: RunId });
type ReviewContext = typeof ReviewContext.Type;

const FollowedThread = Schema.Struct({ runId: Schema.NullOr(RunId) });

const StoredState = Schema.Struct({
  brain: Schema.NullOr(ModelSelection),
  threadId: Schema.NullOr(ThreadId),
  grants: OrchestratorGrants,
  thresholds: SupervisionThresholds,
  needsAttention: Schema.optional(Schema.NullOr(OrchestratorNeedsAttention)),
  reviewContexts: Schema.optional(Schema.Record(Schema.String, ReviewContext)),
  /** Keyed by the turn item id of the message, as clients see it. */
  reactions: Schema.optional(Schema.Record(Schema.String, Schema.Array(OrchestratorReaction))),
  ownerReadAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Threads the orchestrator started or messaged, until their work ends. */
  followedThreads: Schema.optional(Schema.Record(Schema.String, FollowedThread)),
});
type StoredState = typeof StoredState.Type;
const StoredStateJson = Schema.fromJsonString(StoredState);
const decodeState = Schema.decodeUnknownOption(StoredStateJson);
const encodeState = Schema.encodeSync(StoredStateJson);

const INITIAL_STATE: StoredState = {
  brain: null,
  threadId: null,
  grants: DEFAULT_ORCHESTRATOR_GRANTS,
  thresholds: DEFAULT_SUPERVISION_THRESHOLDS,
};

const refusal = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

const summarizeToolCall = (tool: string, params: unknown): string => {
  const json = JSON.stringify(params) ?? "";
  return `${tool} ${json.length > AUDIT_PARAMS_MAX_CHARS ? `${json.slice(0, AUDIT_PARAMS_MAX_CHARS)}…` : json}`;
};

interface PendingApproval {
  readonly approval: OrchestratorApproval;
  readonly answer: Deferred.Deferred<boolean>;
}

export class OrchestratorAgent extends Context.Service<
  OrchestratorAgent,
  {
    readonly snapshot: Effect.Effect<OrchestratorSnapshot, OrchestratorAgentError>;
    readonly changes: Stream.Stream<OrchestratorSnapshot, OrchestratorAgentError>;
    readonly checkAvailability: Effect.Effect<OrchestratorBrainAvailability>;
    readonly setBrain: (
      input: OrchestratorSetBrainInput,
    ) => Effect.Effect<void, OrchestratorAgentError>;
    readonly setGrants: (grants: OrchestratorGrants) => Effect.Effect<void, OrchestratorAgentError>;
    readonly setThresholds: (
      thresholds: SupervisionThresholds,
    ) => Effect.Effect<void, OrchestratorAgentError>;
    readonly send: (
      input: OrchestratorSendInput,
      scheduled?: { readonly id: ScheduledTaskId; readonly messageId: MessageId },
    ) => Effect.Effect<OrchestratorSendResult, OrchestratorAgentError>;
    /** A supervision review queued behind any work in progress, on the same brain. */
    readonly review: (
      text: string,
      context?: ReviewContext,
    ) => Effect.Effect<void, OrchestratorAgentError>;
    /** A system prompt that is not a review, such as a follow-up on work the orchestrator started. */
    readonly wake: (text: string) => Effect.Effect<void, OrchestratorAgentError>;
    /** One pass per tick: pushes the latest reply when it changes, and wakes for followed work. */
    readonly checkOrchestrator: Effect.Effect<void>;
    readonly supervisionReview: Effect.Effect<ReviewContext | null, OrchestratorMcpFailure>;
    /** The owner's reaction to a message. Adding the same emoji again removes it. */
    readonly react: (input: OrchestratorReactInput) => Effect.Effect<void, OrchestratorAgentError>;
    /** The orchestrator's reaction to the owner's latest message, with the same toggling. */
    readonly reactToOwner: (
      emoji: string,
    ) => Effect.Effect<
      { readonly emoji: string; readonly reacted: boolean },
      OrchestratorMcpFailure
    >;
    /** Moves the owner's read position forward. It never moves back. */
    readonly markRead: (
      input: OrchestratorMarkReadInput,
    ) => Effect.Effect<void, OrchestratorAgentError>;
    readonly interrupt: Effect.Effect<void, OrchestratorAgentError>;
    /** Deletes the conversation and stops its run. The brain, grants, and audit trail stay. */
    readonly clearConversation: Effect.Effect<void, OrchestratorAgentError>;
    readonly answerApproval: (
      input: OrchestratorAnswerApprovalInput,
    ) => Effect.Effect<void, OrchestratorAgentError>;
    /** Wraps a tool call from the orchestrator's session: grants first, audit either way. */
    readonly governTool: <A, E, R>(
      tool: string,
      params: unknown,
      run: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | OrchestratorMcpFailure, R>;
    /** Sends a request to the owner's clients and says how many are listening. */
    readonly directive: (directive: OrchestratorUiDirective) => Effect.Effect<number>;
    readonly directives: Stream.Stream<OrchestratorUiDirective>;
    /** Reported by supervision, which owns the count. */
    readonly setWatching: (count: number) => Effect.Effect<void>;
    /** Reported by supervision, which owns each thread's choice. */
    readonly setSupervisionThreadModes: (
      modes: Readonly<Record<string, SupervisionMode>>,
    ) => Effect.Effect<void>;
  }
>()("t3pp/orchestratorAgent/OrchestratorAgent") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const audit = yield* AuditTrail.AuditTrail;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const turnContext = yield* OrchestratorTurnContext.OrchestratorTurnContext;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;

  const rows = yield* sql<{ readonly stateJson: string }>`
    SELECT state_json AS "stateJson" FROM orchestrator_agent_state WHERE id = 1
  `.pipe(Effect.orDie);
  const state = yield* Ref.make(
    Option.getOrElse(
      Option.fromNullishOr(rows[0]).pipe(Option.flatMap((row) => decodeState(row.stateJson))),
      () => INITIAL_STATE,
    ),
  );
  const pending = new Map<OrchestratorApprovalId, PendingApproval>();
  const watching = yield* Ref.make(0);
  const supervisionThreadModes = yield* Ref.make<Readonly<Record<string, SupervisionMode>>>({});
  const supervisionReviewing = yield* Ref.make<ThreadId | null>(null);
  const pushedLatestReplyAt = yield* Ref.make<string | null>(null);
  // The last real reply's time, kept through silent replies so one cannot clear an unread reply.
  const lastRealReplyAt = yield* Ref.make<string | null>(null);
  const changed = yield* PubSub.sliding<void>(1);
  const directivesHub = yield* PubSub.sliding<OrchestratorUiDirective>(16);
  const notify = PubSub.publish(changed, undefined);
  let directiveListeners = 0;

  const persist = Effect.fn("OrchestratorAgent.persist")(function* (next: StoredState) {
    const stateJson = encodeState(next);
    yield* sql`
      INSERT INTO orchestrator_agent_state (id, state_json) VALUES (1, ${stateJson})
      ON CONFLICT (id) DO UPDATE SET state_json = excluded.state_json
    `.pipe(
      Effect.mapError((cause) => new OrchestratorAgentError({ reason: "store_failed", cause })),
    );
    yield* Ref.set(state, next);
    yield* notify;
  });

  /** A run that hit its limit blocks until the reset, which a provider snapshot may not show yet. */
  const availabilityFrom = Effect.fn("OrchestratorAgent.availabilityFrom")(function* (
    current: StoredState,
    list: ReadonlyArray<ServerProvider>,
  ) {
    const availability = orchestratorBrainAvailability(current.brain, list);
    if (availability.status !== "available" || current.threadId === null) return availability;
    const shell = yield* threads
      .getThreadShell(current.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    const resetAt = shell?.usageLimitResetAt;
    if (resetAt == null || Date.parse(resetAt) <= DateTime.toEpochMillis(yield* DateTime.now)) {
      return availability;
    }
    return {
      status: "blocked",
      reason: "quota_exhausted",
      message: `The provider's limit was reached. It resets at ${resetAt}.`,
    } satisfies OrchestratorBrainAvailability;
  });

  const readAvailability = Effect.gen(function* () {
    return yield* availabilityFrom(yield* Ref.get(state), yield* providers.getProviders);
  });

  const checkAvailability = Effect.gen(function* () {
    const { brain } = yield* Ref.get(state);
    if (brain !== null) {
      yield* providers
        .refreshInstance(brain.instanceId)
        .pipe(Effect.timeoutOption(REFRESH_WAIT), Effect.ignore);
    }
    yield* notify;
    return yield* readAvailability;
  }).pipe(Effect.withSpan("OrchestratorAgent.checkAvailability"));

  /** The orchestrator's latest reply as an ISO time, or null when it is silent or not an assistant message. */
  /**
   * The orchestrator's latest reply as an ISO time. A silent reply keeps the last real reply's time,
   * so it cannot clear an unread reply. Null when there is none, or the latest message is the owner's.
   */
  const latestReplyAt = Effect.fn("OrchestratorAgent.latestReplyAt")(function* (
    threadId: ThreadId | null,
  ) {
    if (threadId === null) return null;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const message = shell?.latestVisibleMessage;
    if (message == null || message.role !== "assistant") return null;
    if (message.text.trim() === ORCHESTRATOR_SILENT_REPLY) return yield* Ref.get(lastRealReplyAt);
    const at = DateTime.formatIso(message.updatedAt);
    yield* Ref.set(lastRealReplyAt, at);
    return at;
  });

  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const availability = yield* readAvailability;
    const latestMessageAt = yield* latestReplyAt(current.threadId);
    return {
      brain: current.brain,
      needsAttention: current.needsAttention ?? null,
      availability,
      threadId: current.threadId,
      grants: current.grants,
      thresholds: current.thresholds,
      supervision:
        availability.status === "available"
          ? { status: "active" as const, watching: yield* Ref.get(watching) }
          : {
              status: "paused" as const,
              reason:
                availability.status === "blocked"
                  ? availability.message
                  : "Choose the orchestrator's model to start supervising.",
            },
      pendingApprovals: [...pending.values()].map((entry) => entry.approval),
      reactions: current.reactions ?? {},
      ownerReadAt: current.ownerReadAt ?? null,
      latestMessageAt,
      supervisionThreadModes: yield* Ref.get(supervisionThreadModes),
      supervisionReviewing: yield* Ref.get(supervisionReviewing),
    } satisfies OrchestratorSnapshot;
  }).pipe(Effect.withSpan("OrchestratorAgent.snapshot"));

  const changes = Stream.fromEffect(snapshot).pipe(
    Stream.concat(
      Stream.merge(
        Stream.fromPubSub(changed),
        providers.streamChanges.pipe(Stream.map(() => undefined)),
      ).pipe(Stream.mapEffect(() => snapshot)),
    ),
  );

  const interruptRun = Effect.fn("OrchestratorAgent.interruptRun")(function* (threadId: ThreadId) {
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell === null) return;
    yield* threads
      .interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`server:orchestrator:interrupt:${yield* uuid}`),
        threadId,
      })
      .pipe(
        Effect.mapError((cause) => new OrchestratorAgentError({ reason: "start_failed", cause })),
      );
  });

  const setBrain: OrchestratorAgent["Service"]["setBrain"] = Effect.fn(
    "OrchestratorAgent.setBrain",
  )(function* (input) {
    const current = yield* Ref.get(state);
    const availability = orchestratorBrainAvailability(input.brain, yield* providers.getProviders);
    if (availability.status === "blocked") {
      return yield* new OrchestratorAgentError({ reason: "blocked", detail: availability.message });
    }
    if (current.threadId !== null) {
      const shell = yield* threads
        .getThreadShell(current.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell?.activeRunId != null) {
        if (input.interruptRun !== true) {
          return yield* new OrchestratorAgentError({
            reason: "run_active",
            detail: "The orchestrator is working. Interrupt it or wait for it to finish first.",
          });
        }
        yield* interruptRun(current.threadId);
      }
    }
    yield* persist({ ...current, brain: input.brain });
    yield* audit.record({
      actor: "user",
      domain: "orchestrator",
      action: "brain.set",
      outcome: "succeeded",
      result: `${input.brain.instanceId} ${input.brain.model}`,
    });
    if (current.brain === null && current.threadId === null) {
      // Forked: the wake waits on the provider's availability check, which the picker must not.
      yield* wake(
        `The owner just picked you as their orchestrator. This one is for them: greet them in one short message and say what you can do for them here.`,
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not greet the owner", cause)),
        Effect.forkDetach,
        Effect.asVoid,
      );
    }
  });

  const setGrants: OrchestratorAgent["Service"]["setGrants"] = Effect.fn(
    "OrchestratorAgent.setGrants",
  )(function* (grants) {
    yield* persist({ ...(yield* Ref.get(state)), grants });
    yield* audit.record({
      actor: "user",
      domain: "orchestrator",
      action: "grants.set",
      outcome: "succeeded",
    });
  });

  const setThresholds: OrchestratorAgent["Service"]["setThresholds"] = Effect.fn(
    "OrchestratorAgent.setThresholds",
  )(function* (thresholds) {
    yield* persist({ ...(yield* Ref.get(state)), thresholds });
  });

  const ensureThread = Effect.fn("OrchestratorAgent.ensureThread")(function* (
    brain: ModelSelection,
  ) {
    const current = yield* Ref.get(state);
    if (current.threadId !== null) {
      const shell = yield* threads
        .getThreadShell(current.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell !== null && shell.deletedAt === null) {
        return { threadId: current.threadId, projectId: shell.projectId };
      }
    }
    const { projectId } = yield* folders.ensureScratchProject.pipe(
      // Scratch errors carry fixed messages, written for people.
      Effect.mapError(
        (cause) =>
          new OrchestratorAgentError({ reason: "start_failed", detail: cause.message, cause }),
      ),
    );
    const threadId = ThreadId.make(`orchestrator-${yield* uuid}`);
    yield* orchestrator
      .dispatch({
        type: "thread.create",
        createdBy: "system",
        creationSource: "server",
        commandId: CommandId.make(`server:orchestrator:create:${threadId}`),
        threadId,
        projectId,
        title: "Orchestrator",
        modelSelection: brain,
        runtimeMode: "full-access",
        interactionMode: "default",
        capabilityMode: "chat",
        orchestratorAgent: true,
        branch: null,
        worktreePath: null,
      })
      .pipe(
        Effect.mapError((cause) => new OrchestratorAgentError({ reason: "start_failed", cause })),
      );
    yield* persist({ ...current, threadId });
    return { threadId, projectId };
  });

  const requireBrain = Effect.fn("OrchestratorAgent.requireBrain")(function* () {
    const availability = yield* checkAvailability;
    const current = yield* Ref.get(state);
    if (availability.status !== "available" || current.brain === null) {
      const reason =
        availability.status === "blocked"
          ? availability.message
          : "Choose the orchestrator's model before sending work.";
      yield* persist({ ...current, needsAttention: { status: "needs_attention", reason } });
      yield* audit.record({
        actor: "system",
        domain: "orchestrator",
        action: "request.needs-attention",
        outcome: "denied",
        result: reason,
      });
      return yield* new OrchestratorAgentError({ reason: "blocked", detail: reason });
    }
    if (current.needsAttention != null) yield* persist({ ...current, needsAttention: null });
    return current.brain;
  });

  const send: OrchestratorAgent["Service"]["send"] = Effect.fn("OrchestratorAgent.send")(
    function* (input, scheduled) {
      const brain = yield* requireBrain();
      const { threadId, projectId } = yield* ensureThread(brain);
      yield* turnContext.setFocus(threadId, input.focus);
      yield* threads
        .sendToThread({
          projectId,
          commandId: input.commandId,
          threadId,
          messageId: scheduled?.messageId ?? MessageId.make(`orchestrator-${yield* uuid}`),
          ...(scheduled === undefined ? {} : { scheduledTaskId: scheduled.id }),
          text: input.text,
          attachments: [],
          modelSelection: brain,
          mode: scheduled === undefined ? "auto" : "queue",
          createdBy: scheduled === undefined ? "user" : "system",
          creationSource: "server",
        })
        .pipe(
          Effect.mapError((cause) => new OrchestratorAgentError({ reason: "start_failed", cause })),
        );
      return { threadId };
    },
  );

  const queueSystemPrompt = Effect.fn("OrchestratorAgent.queueSystemPrompt")(function* (
    kind: "review" | "wake",
    text: string,
    context?: ReviewContext,
  ) {
    const brain = yield* requireBrain();
    const { threadId, projectId } = yield* ensureThread(brain);
    const id = yield* uuid;
    const messageId = MessageId.make(`orchestrator-${kind}-${id}`);
    if (context !== undefined) {
      const current = yield* Ref.get(state);
      yield* persist({
        ...current,
        reviewContexts: Object.fromEntries(
          [...Object.entries(current.reviewContexts ?? {}), [messageId, context]].slice(-100),
        ),
      });
    }
    yield* threads
      .sendToThread({
        projectId,
        commandId: CommandId.make(`server:orchestrator:${kind}:${id}`),
        threadId,
        messageId,
        text,
        attachments: [],
        modelSelection: brain,
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.mapError((cause) => new OrchestratorAgentError({ reason: "start_failed", cause })),
      );
  });

  const review: OrchestratorAgent["Service"]["review"] = (text, context) =>
    queueSystemPrompt("review", text, context);

  const wake: OrchestratorAgent["Service"]["wake"] = (text) => queueSystemPrompt("wake", text);

  /** Adds the started threads, or refreshes their run, keeping the newest `FOLLOWED_CAP`. */
  const withFollowed = (
    current: NonNullable<StoredState["followedThreads"]>,
    started: ReadonlyArray<StartedThread>,
  ): NonNullable<StoredState["followedThreads"]> => {
    const next = { ...current };
    for (const { threadId, runId } of started) {
      const previous = next[threadId]?.runId ?? null;
      delete next[threadId];
      next[threadId] = { runId: runId ?? previous };
    }
    return Object.fromEntries(Object.entries(next).slice(-FOLLOWED_CAP));
  };

  const setFollowed = Effect.fn("OrchestratorAgent.setFollowed")(function* (
    threadId: ThreadId,
    value: { readonly runId: RunId | null } | null,
  ) {
    const current = yield* Ref.get(state);
    const { [threadId]: _previous, ...others } = current.followedThreads ?? {};
    yield* persist({
      ...current,
      followedThreads: value === null ? others : { ...others, [threadId]: value },
    });
  });

  const followStarted = Effect.fn("OrchestratorAgent.followStarted")(function* (
    tool: string,
    params: unknown,
    result: unknown,
  ) {
    const started = startedThreadsFrom(tool, params, result);
    if (started.length === 0) return;
    const current = yield* Ref.get(state);
    yield* persist({
      ...current,
      followedThreads: withFollowed(current.followedThreads ?? {}, started),
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Could not follow a thread", cause)));
  });

  const followedLine = (shell: OrchestrationV2ThreadShell, what: string) =>
    `- ${formatThreadLink({ environmentId, threadId: shell.id }, shell.title)} ${what}`;

  /** Pushes the orchestrator's latest reply to subscribers when it changed since the last push. */
  const pushLatestReply = Effect.gen(function* () {
    const { threadId } = yield* Ref.get(state);
    const latest = yield* latestReplyAt(threadId);
    if ((yield* Ref.getAndSet(pushedLatestReplyAt, latest)) !== latest) yield* notify;
  });

  /**
   * One pass per tick. Pushes the orchestrator's latest reply when it changes, then wakes the
   * orchestrator once for followed work that ended or waits on the owner.
   */
  const checkOrchestrator: OrchestratorAgent["Service"]["checkOrchestrator"] = Effect.gen(
    function* () {
      const { threadId: ownThreadId } = yield* Ref.get(state);
      yield* pushLatestReply;
      const followed = (yield* Ref.get(state)).followedThreads ?? {};
      if (Object.keys(followed).length === 0) return;
      // No model runs while the brain is unavailable, and the orchestrator's own run goes first.
      if ((yield* readAvailability).status !== "available") return;
      if (ownThreadId !== null) {
        const own = yield* threads
          .getThreadShell(ownThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (own?.activeRunId != null) return;
      }
      // Several threads ending in one pass cost one wake, so the lines are collected first.
      const lines: Array<string> = [];
      for (const [key, entry] of Object.entries(followed)) {
        const threadId = ThreadId.make(key);
        const shell = yield* threads
          .getThreadShell(threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.deletedAt !== null) {
          yield* setFollowed(threadId, null);
        } else if (shell.status === "waiting") {
          yield* setFollowed(threadId, null);
          lines.push(followedLine(shell, `is waiting for the owner's input (${shell.status})`));
        } else if (shell.activeRunId !== null) {
          if (entry.runId !== shell.activeRunId) {
            yield* setFollowed(threadId, { runId: shell.activeRunId });
          }
        } else if (entry.runId !== null) {
          yield* setFollowed(threadId, null);
          lines.push(followedLine(shell, `has finished its run (${shell.status})`));
        }
      }
      if (lines.length === 0) return;
      yield* wake(
        `Followed work needs a look:\n${lines.join("\n")}\nRead it with t3_thread_read if you need the detail. Tell the owner only if it matters.`,
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not wake for followed work", cause)),
      );
    },
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not check the orchestrator's threads", cause),
    ),
    Effect.withSpan("OrchestratorAgent.checkOrchestrator"),
  );

  // A run settling pushes the reply at once. The tick keeps the same check as a backstop.
  yield* threads.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "run.updated"),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const { threadId } = yield* Ref.get(state);
        if (event.threadId !== threadId) return;
        if (ThreadManagementService.isTerminalRunStatus(event.payload.status)) {
          yield* pushLatestReply;
        }
        const review = yield* supervisionReview.pipe(Effect.orElseSucceed(() => null));
        const reviewing = review?.threadId ?? null;
        if ((yield* Ref.getAndSet(supervisionReviewing, reviewing)) !== reviewing) yield* notify;
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Could not push the latest reply", cause)),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds") }),
    Effect.catchCause((cause) =>
      Effect.logWarning("The orchestrator's event subscription stopped", cause),
    ),
    Effect.forkScoped,
  );

  /** Toggles one reaction per emoji per author. A different emoji replaces the author's last one. */
  const toggleReaction = (
    current: ReadonlyArray<OrchestratorReaction>,
    by: OrchestratorReaction["by"],
    emoji: string,
  ) => {
    const others = current.filter((reaction) => reaction.by !== by);
    const mine = current.find((reaction) => reaction.by === by);
    return mine?.emoji === emoji
      ? { next: others, added: false }
      : { next: [...others, { emoji, by }], added: true };
  };

  const withReactions = (
    reactions: NonNullable<StoredState["reactions"]>,
    messageId: string,
    next: ReadonlyArray<OrchestratorReaction>,
  ) => {
    const { [messageId]: _previous, ...others } = reactions;
    const merged = next.length === 0 ? others : { ...others, [messageId]: next };
    return Object.fromEntries(Object.entries(merged).slice(-REACTION_CAP));
  };

  const react: OrchestratorAgent["Service"]["react"] = Effect.fn("OrchestratorAgent.react")(
    function* (input) {
      const current = yield* Ref.get(state);
      const reactions = current.reactions ?? {};
      const { next, added } = toggleReaction(
        reactions[input.messageId] ?? [],
        "owner",
        input.emoji,
      );
      yield* persist({
        ...current,
        reactions: withReactions(reactions, input.messageId, next),
      });
      if (added && current.threadId !== null) {
        const quoted = input.excerpt === undefined ? "." : `: "${input.excerpt}"`;
        yield* turnContext.addNote(
          current.threadId,
          `The owner reacted ${input.emoji} to your message${quoted}`,
        );
      }
    },
  );

  const reactToOwner: OrchestratorAgent["Service"]["reactToOwner"] = Effect.fn(
    "OrchestratorAgent.reactToOwner",
  )(function* (emoji) {
    const { threadId } = yield* Ref.get(state);
    if (threadId === null) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The orchestrator has no conversation with the owner yet.",
      });
    }
    const { messages } = yield* threads
      .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
      .pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "The owner's messages could not be read.",
            }),
        ),
      );
    const latest = messages
      .filter((message) => message.createdBy === "user")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
      )
      .at(-1);
    if (latest === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The owner has not sent a message to react to.",
      });
    }
    const messageId = deriveId.userTurnItem({ messageId: latest.id });
    const current = yield* Ref.get(state);
    const reactions = current.reactions ?? {};
    const { next, added } = toggleReaction(reactions[messageId] ?? [], "orchestrator", emoji);
    yield* persist({
      ...current,
      reactions: withReactions(reactions, messageId, next),
    }).pipe(
      Effect.mapError(
        () =>
          new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: "The reaction could not be saved.",
          }),
      ),
    );
    return { emoji, reacted: added };
  });

  const markRead: OrchestratorAgent["Service"]["markRead"] = Effect.fn(
    "OrchestratorAgent.markRead",
  )(function* (input) {
    const current = yield* Ref.get(state);
    if (
      current.ownerReadAt != null &&
      Date.parse(current.ownerReadAt) >= Date.parse(input.through)
    ) {
      return;
    }
    yield* persist({ ...current, ownerReadAt: input.through });
  });

  const supervisionReview = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.threadId === null) return null;
    const shell = yield* threads
      .getThreadShell(current.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell?.activeRunId == null) return null;
    const { runs } = yield* threads
      .getThreadRecords(current.threadId, ["runs"], { runIds: [shell.activeRunId] })
      .pipe(Effect.mapError(() => refusal("Cannot identify the orchestrator's active request.")));
    const messageId = runs[0]?.userMessageId;
    if (messageId === undefined)
      return yield* refusal("Cannot identify the orchestrator's active request.");
    if (!messageId.startsWith("orchestrator-review-")) return null;
    return (
      current.reviewContexts?.[messageId] ??
      (yield* refusal("This supervision review has no target context."))
    );
  }).pipe(Effect.withSpan("OrchestratorAgent.supervisionReview"));

  const interrupt = Effect.gen(function* () {
    const { threadId } = yield* Ref.get(state);
    if (threadId !== null) yield* interruptRun(threadId);
  }).pipe(Effect.withSpan("OrchestratorAgent.interrupt"));

  const clearConversation = Effect.gen(function* () {
    const { threadId } = yield* Ref.get(state);
    if (threadId === null) return;
    const shell = yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    if (shell !== null && shell.deletedAt === null) {
      yield* orchestrator
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:orchestrator:clear:${yield* uuid}`),
          threadId,
        })
        .pipe(
          Effect.mapError((cause) => new OrchestratorAgentError({ reason: "store_failed", cause })),
        );
    }
    // The run these belonged to is gone, so nothing is left to answer them.
    for (const entry of pending.values()) yield* Deferred.succeed(entry.answer, false);
    pending.clear();
    yield* Ref.set(lastRealReplyAt, null);
    yield* Ref.set(pushedLatestReplyAt, null);
    yield* Ref.set(supervisionReviewing, null);
    yield* persist({
      ...(yield* Ref.get(state)),
      threadId: null,
      reactions: {},
      reviewContexts: {},
      followedThreads: {},
      ownerReadAt: null,
    });
    yield* audit.record({
      actor: "user",
      domain: "orchestrator",
      action: "conversation.clear",
      outcome: "succeeded",
    });
  }).pipe(Effect.withSpan("OrchestratorAgent.clearConversation"));

  const answerApproval: OrchestratorAgent["Service"]["answerApproval"] = Effect.fn(
    "OrchestratorAgent.answerApproval",
  )(function* (input) {
    const entry = pending.get(input.id);
    if (entry === undefined) {
      return yield* new OrchestratorAgentError({
        reason: "approval_gone",
        detail: "That request is no longer waiting.",
      });
    }
    pending.delete(input.id);
    yield* Deferred.succeed(entry.answer, input.allow);
    yield* notify;
  });

  const askOwner = Effect.fn("OrchestratorAgent.askOwner")(function* (
    tool: string,
    policy: OrchestratorToolPolicy,
    summary: string,
  ) {
    const id = OrchestratorApprovalId.make(yield* uuid);
    const answer = yield* Deferred.make<boolean>();
    pending.set(id, {
      answer,
      approval: {
        id,
        tool,
        domain: policy.domain,
        effect: policy.effect,
        summary,
        requestedAt: DateTime.formatIso(yield* DateTime.now),
      },
    });
    yield* notify;
    const allowed = yield* Deferred.await(answer).pipe(
      Effect.timeoutOption(APPROVAL_WAIT),
      Effect.ensuring(
        Effect.suspend(() => (pending.delete(id) ? notify.pipe(Effect.asVoid) : Effect.void)),
      ),
    );
    return Option.getOrElse(allowed, () => false);
  });

  const auditTool = Effect.fn("OrchestratorAgent.auditTool")(function* (input: {
    readonly tool: string;
    readonly policy: OrchestratorToolPolicy | undefined;
    readonly summary: string;
    readonly outcome: AuditOutcome;
  }) {
    const { threadId } = yield* Ref.get(state);
    const shell =
      threadId === null
        ? null
        : yield* threads.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const message = shell?.latestVisibleMessage;
    yield* audit.record({
      actor: "orchestrator",
      domain: input.policy?.domain ?? "unknown",
      action: input.tool,
      outcome: input.outcome,
      result: input.summary,
      ...(threadId === null ? {} : { threadId }),
      ...(message?.role === "user" ? { request: message.text } : {}),
    });
  });

  const governTool = Effect.fn("OrchestratorAgent.governTool")(function* <A, E, R>(
    tool: string,
    params: unknown,
    run: Effect.Effect<A, E, R>,
  ) {
    const policy = ORCHESTRATOR_TOOL_POLICY[tool];
    const summary = summarizeToolCall(tool, params);
    if (policy === undefined) {
      yield* auditTool({ tool, policy, summary, outcome: "denied" });
      return yield* refusal(`The orchestrator has no grant for ${tool}.`);
    }
    const decision = grantDecision((yield* Ref.get(state)).grants, policy);
    if (decision === "deny") {
      yield* auditTool({ tool, policy, summary, outcome: "denied" });
      return yield* refusal(`The ${policy.domain} grant is off. The owner can change it.`);
    }
    if (decision === "ask" && !(yield* askOwner(tool, policy, summary))) {
      yield* auditTool({ tool, policy, summary, outcome: "denied" });
      return yield* refusal("The owner did not approve this.");
    }
    return yield* run.pipe(
      Effect.tap((result) => followStarted(tool, params, result)),
      Effect.onExit((exit) =>
        auditTool({
          tool,
          policy,
          summary,
          outcome: Exit.isSuccess(exit) ? "succeeded" : "failed",
        }),
      ),
    );
  });

  const directive: OrchestratorAgent["Service"]["directive"] = (request) =>
    PubSub.publish(directivesHub, request).pipe(Effect.as(directiveListeners));

  const directives = Stream.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => {
        directiveListeners += 1;
        return Stream.fromPubSub(directivesHub);
      }),
      () =>
        Effect.sync(() => {
          directiveListeners -= 1;
        }),
    ),
  );

  const setWatching = Effect.fn("OrchestratorAgent.setWatching")(function* (count: number) {
    const previous = yield* Ref.getAndSet(watching, count);
    if (previous !== count) yield* notify;
  });

  const setSupervisionThreadModes = Effect.fn("OrchestratorAgent.setSupervisionThreadModes")(
    function* (modes: Readonly<Record<string, SupervisionMode>>) {
      yield* Ref.set(supervisionThreadModes, modes);
      yield* notify;
    },
  );

  return OrchestratorAgent.of({
    snapshot,
    changes,
    checkAvailability,
    setBrain,
    setGrants,
    setThresholds,
    send,
    review,
    wake,
    checkOrchestrator,
    supervisionReview,
    react,
    reactToOwner,
    markRead,
    interrupt,
    clearConversation,
    answerApproval,
    governTool,
    directive,
    directives,
    setWatching,
    setSupervisionThreadModes,
  });
});

export const layer = Layer.effect(OrchestratorAgent, make);
