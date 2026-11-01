import {
  type AuditOutcome,
  CommandId,
  DEFAULT_ORCHESTRATOR_GRANTS,
  DEFAULT_SUPERVISION_THRESHOLDS,
  MessageId,
  ModelSelection,
  type OrchestratorAnswerApprovalInput,
  OrchestratorAgentError,
  OrchestratorApproval,
  OrchestratorApprovalId,
  type OrchestratorBrainAvailability,
  OrchestratorGrants,
  OrchestratorMcpFailure,
  type OrchestratorSendInput,
  type OrchestratorSendResult,
  type OrchestratorSetBrainInput,
  type OrchestratorSnapshot,
  type OrchestratorUiDirective,
  orchestratorBrainAvailability,
  type ServerProvider,
  type ScheduledTaskId,
  RunId,
  OrchestratorNeedsAttention,
  SupervisionThresholds,
  ThreadId,
} from "@t3tools/contracts";
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
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestratorTurnContext from "./OrchestratorTurnContext.ts";
import {
  grantDecision,
  ORCHESTRATOR_TOOL_POLICY,
  type OrchestratorToolPolicy,
} from "./toolPolicy.ts";

const APPROVAL_WAIT = Duration.minutes(10);
const REFRESH_WAIT = Duration.seconds(5);
const AUDIT_PARAMS_MAX_CHARS = 400;

const ReviewContext = Schema.Struct({ threadId: ThreadId, runId: RunId });
type ReviewContext = typeof ReviewContext.Type;

const StoredState = Schema.Struct({
  brain: Schema.NullOr(ModelSelection),
  threadId: Schema.NullOr(ThreadId),
  grants: OrchestratorGrants,
  thresholds: SupervisionThresholds,
  needsAttention: Schema.optional(Schema.NullOr(OrchestratorNeedsAttention)),
  reviewContexts: Schema.optional(Schema.Record(Schema.String, ReviewContext)),
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
    readonly supervisionReview: Effect.Effect<ReviewContext | null, OrchestratorMcpFailure>;
    readonly interrupt: Effect.Effect<void, OrchestratorAgentError>;
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

  const snapshot = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const availability = yield* readAvailability;
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

  const review: OrchestratorAgent["Service"]["review"] = Effect.fn("OrchestratorAgent.review")(
    function* (text, context) {
      const brain = yield* requireBrain();
      const { threadId, projectId } = yield* ensureThread(brain);
      const id = yield* uuid;
      const messageId = MessageId.make(`orchestrator-review-${id}`);
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
          commandId: CommandId.make(`server:orchestrator:review:${id}`),
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
    },
  );

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

  return OrchestratorAgent.of({
    snapshot,
    changes,
    checkAvailability,
    setBrain,
    setGrants,
    setThresholds,
    send,
    review,
    supervisionReview,
    interrupt,
    answerApproval,
    governTool,
    directive,
    directives,
    setWatching,
  });
});

export const layer = Layer.effect(OrchestratorAgent, make);
