import {
  COMPUTER_USE_RECENT_STEPS,
  COMPUTER_USE_STEP_PAGE_SIZE,
  type ComputerUseActInput,
  type ComputerUseActResult,
  type ComputerUseAnswerApprovalInput,
  type ComputerUseApproval,
  ComputerUseError,
  type ComputerUseErrorCode,
  type ComputerUseListStepsInput,
  type ComputerUseListStepsResult,
  type ComputerUseScreenshot,
  type ComputerUseScreenshotInput,
  type ComputerUseSensitivity,
  type ComputerUseSnapshot,
  type ComputerUseStartInput,
  type ComputerUseState,
  type ComputerUseStep,
  type ComputerUseStepStatus,
  type ComputerUseSupportResult,
  type ComputerUseTarget,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { classifyStep } from "./classifyStep.ts";
import * as VirtualDisplay from "./VirtualDisplay.ts";

const APPROVAL_TIMEOUT = "5 minutes";
const SCREENSHOT_RETENTION = 100;

/** The app's browser, reached through the calling agent's own MCP request. */
export interface BrowserDriver {
  readonly act: (input: ComputerUseActInput) => Effect.Effect<string, ComputerUseError>;
  readonly screenshot: Effect.Effect<Uint8Array, ComputerUseError>;
}

interface Session {
  readonly target: ComputerUseTarget;
  readonly startedAt: string;
  readonly display: string | null;
  readonly takenOver: boolean;
  readonly approval: {
    readonly info: ComputerUseApproval;
    readonly answer: Deferred.Deferred<boolean>;
  } | null;
}

interface StepRow {
  readonly step_id: string;
  readonly thread_id: string;
  readonly sequence: number;
  readonly at: string;
  readonly target: ComputerUseTarget;
  readonly action: ComputerUseStep["action"];
  readonly intent: string;
  readonly sensitivity: ComputerUseSensitivity | null;
  readonly status: ComputerUseStepStatus;
  readonly result: string | null;
  readonly has_screenshot: number;
}

const stepFromRow = (row: StepRow): ComputerUseStep => ({
  id: row.step_id,
  threadId: ThreadId.make(row.thread_id),
  sequence: row.sequence,
  at: row.at,
  target: row.target,
  action: row.action,
  intent: row.intent,
  sensitivity: row.sensitivity,
  status: row.status,
  result: row.result,
  hasScreenshot: row.has_screenshot === 1,
});

const refuse = (code: ComputerUseErrorCode, message: string) =>
  new ComputerUseError({ code, message });

const storageFailure = (message: string) => (cause: unknown) =>
  new ComputerUseError({ code: "failed", message, cause });

const OFF_MESSAGE =
  "Computer use is off for this conversation. Ask the user to turn it on; you cannot.";

export class ComputerUseService extends Context.Service<
  ComputerUseService,
  {
    readonly support: Effect.Effect<ComputerUseSupportResult>;
    readonly getState: (threadId: ThreadId) => Effect.Effect<ComputerUseState>;
    /** The conversation's state and newest steps, now and after every change. */
    readonly subscribe: (
      threadId: ThreadId,
    ) => Stream.Stream<ComputerUseSnapshot, ComputerUseError>;
    readonly start: (
      input: ComputerUseStartInput,
    ) => Effect.Effect<ComputerUseState, ComputerUseError>;
    /** Takes effect before it returns, ends any wait for approval, and cannot fail. */
    readonly stop: (threadId: ThreadId) => Effect.Effect<ComputerUseState>;
    readonly takeOver: (threadId: ThreadId) => Effect.Effect<ComputerUseState, ComputerUseError>;
    readonly resume: (threadId: ThreadId) => Effect.Effect<ComputerUseState, ComputerUseError>;
    readonly answerApproval: (
      input: ComputerUseAnswerApprovalInput,
    ) => Effect.Effect<ComputerUseState, ComputerUseError>;
    readonly act: (
      threadId: ThreadId,
      input: ComputerUseActInput,
      browser: BrowserDriver,
    ) => Effect.Effect<ComputerUseActResult, ComputerUseError>;
    readonly screenshot: (
      threadId: ThreadId,
      browser: BrowserDriver,
    ) => Effect.Effect<ComputerUseScreenshot & { readonly stepId: string }, ComputerUseError>;
    readonly listSteps: (
      input: ComputerUseListStepsInput,
    ) => Effect.Effect<ComputerUseListStepsResult, ComputerUseError>;
    readonly getScreenshot: (
      input: ComputerUseScreenshotInput,
    ) => Effect.Effect<ComputerUseScreenshot, ComputerUseError>;
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3pp/computerUse/ComputerUseService") {}

export const layer = Layer.effect(
  ComputerUseService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const audit = yield* AuditTrail.AuditTrail;
    const display = yield* VirtualDisplay.VirtualDisplay;
    // Sessions live in memory: a restart ends them, and the safe state is off.
    const sessions = yield* Ref.make<ReadonlyMap<ThreadId, Session>>(new Map());
    // Subscribers re-read, so a dropped signal is covered by the next one.
    const changes = yield* PubSub.sliding<ThreadId>(64);
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const newId = crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(storageFailure("Could not generate an id.")));

    const stateOf = (threadId: ThreadId, session: Session | undefined): ComputerUseState => ({
      threadId,
      status: session === undefined ? "off" : session.takenOver ? "taken-over" : "active",
      target: session?.target ?? null,
      startedAt: session?.startedAt ?? null,
      display: session?.display ?? null,
      pendingApproval: session?.approval?.info ?? null,
    });

    const getState: ComputerUseService["Service"]["getState"] = (threadId) =>
      Ref.get(sessions).pipe(Effect.map((all) => stateOf(threadId, all.get(threadId))));

    const announce = (threadId: ThreadId) =>
      PubSub.publish(changes, threadId).pipe(Effect.andThen(getState(threadId)));

    const record = (
      threadId: ThreadId,
      action: string,
      outcome: "succeeded" | "failed" | "denied" | "pending",
      result?: string,
    ) =>
      audit.record({
        actor: action.startsWith("session.") ? "user" : "agent",
        domain: "computer-use",
        action,
        outcome,
        threadId,
        ...(result === undefined ? {} : { result }),
      });

    const updateSession = (
      threadId: ThreadId,
      change: (session: Session) => Session,
    ): Effect.Effect<boolean> =>
      Ref.modify(sessions, (all) => {
        const session = all.get(threadId);
        return session === undefined
          ? ([false, all] as const)
          : ([true, new Map(all).set(threadId, change(session))] as const);
      });

    const screenshotPath = (threadId: ThreadId, stepId: string) =>
      path.join(
        config.stateDir,
        "computer-use",
        Buffer.from(threadId).toString("base64url"),
        `${stepId}.png`,
      );

    const pruneScreenshots = (threadId: ThreadId) =>
      sql<{ readonly step_id: string }>`
        UPDATE computer_use_steps SET has_screenshot = 0
        WHERE thread_id = ${threadId} AND has_screenshot = 1 AND step_id NOT IN (
          SELECT step_id FROM computer_use_steps
          WHERE thread_id = ${threadId} AND has_screenshot = 1
          ORDER BY sequence DESC LIMIT ${SCREENSHOT_RETENTION}
        )
        RETURNING step_id
      `.pipe(
        Effect.flatMap((removed) =>
          Effect.forEach(
            removed,
            ({ step_id }) =>
              fileSystem
                .remove(screenshotPath(threadId, step_id), { force: true })
                .pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );

    const logStep = Effect.fn("ComputerUseService.logStep")(function* (input: {
      readonly id: string;
      readonly threadId: ThreadId;
      readonly target: ComputerUseTarget;
      readonly action: ComputerUseStep["action"];
      readonly intent: string;
      readonly sensitivity: ComputerUseSensitivity | null;
      readonly status: ComputerUseStepStatus;
      readonly result: string | null;
      readonly screenshot: Uint8Array | null;
    }) {
      const at = yield* nowIso;
      if (input.screenshot !== null) {
        const file = screenshotPath(input.threadId, input.id);
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFile(file, input.screenshot);
      }
      const [row] = yield* sql<StepRow>`
        INSERT INTO computer_use_steps (
          step_id, thread_id, sequence, at, target, action, intent, sensitivity, status, result,
          has_screenshot
        ) VALUES (
          ${input.id}, ${input.threadId},
          (SELECT COALESCE(MAX(sequence), 0) + 1 FROM computer_use_steps
           WHERE thread_id = ${input.threadId}),
          ${at}, ${input.target}, ${input.action}, ${input.intent}, ${input.sensitivity},
          ${input.status}, ${input.result}, ${input.screenshot === null ? 0 : 1}
        )
        RETURNING *
      `;
      yield* pruneScreenshots(input.threadId);
      if (row !== undefined) yield* PubSub.publish(changes, input.threadId);
      yield* record(
        input.threadId,
        `step.${input.action}`,
        input.status === "ok" ? "succeeded" : input.status === "failed" ? "failed" : "denied",
        input.intent,
      );
    });

    // The log must never be why a stop or a step fails.
    const logStepSafely = (input: Parameters<typeof logStep>[0]) =>
      logStep(input).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not record a computer use step", { cause }),
        ),
      );

    /** A session that may act right now. Checked again after anything that waits. */
    const requireControl = (threadId: ThreadId) =>
      Ref.get(sessions).pipe(
        Effect.flatMap((all) => {
          const session = all.get(threadId);
          if (session === undefined) return Effect.fail(refuse("off", OFF_MESSAGE));
          return session.takenOver
            ? Effect.fail(
                refuse("taken_over", "The user has taken over. Wait until they hand it back."),
              )
            : Effect.succeed(session);
        }),
      );

    /** One approval at a time: the agent runs one step at a time. */
    const requestApproval = Effect.fn("ComputerUseService.requestApproval")(function* (
      threadId: ThreadId,
      input: ComputerUseActInput,
      sensitivity: ComputerUseSensitivity,
    ) {
      const answer = yield* Deferred.make<boolean>();
      const info: ComputerUseApproval = {
        id: yield* newId,
        action: input.action,
        intent: input.intent,
        sensitivity,
        requestedAt: yield* nowIso,
      };
      const placed = yield* updateSession(threadId, (session) => ({
        ...session,
        approval: { info, answer },
      }));
      if (!placed) return yield* refuse("off", OFF_MESSAGE);
      yield* announce(threadId);
      yield* record(threadId, `approval.${sensitivity}`, "pending", input.intent);
      const approved = yield* Deferred.await(answer).pipe(
        Effect.timeoutOption(APPROVAL_TIMEOUT),
        Effect.map((result) => result._tag === "Some" && result.value),
      );
      yield* updateSession(threadId, (session) => ({ ...session, approval: null }));
      yield* announce(threadId);
      return approved;
    });

    const driverFor = (session: Session, browser: BrowserDriver): BrowserDriver => {
      const name = session.display;
      return session.target === "browser" || name === null
        ? browser
        : {
            act: (input) => display.act(name, input),
            screenshot: display.screenshot(name),
          };
    };

    const act: ComputerUseService["Service"]["act"] = Effect.fn("ComputerUseService.act")(
      function* (threadId, input, browser) {
        const session = yield* requireControl(threadId);
        const stepId = `step:${yield* newId}`;
        const sensitivity = classifyStep(input);
        const log = (
          status: ComputerUseStepStatus,
          result: string,
          screenshot: Uint8Array | null,
        ) =>
          logStepSafely({
            id: stepId,
            threadId,
            target: session.target,
            action: input.action,
            intent: input.intent,
            sensitivity,
            status,
            result,
            screenshot,
          });
        if (sensitivity === "credentials") {
          const message =
            "Credentials are never typed for the user. Ask them to take over and enter it themselves.";
          yield* log("refused", message, null);
          return yield* refuse("refused", message);
        }
        if (sensitivity !== null) {
          const approved = yield* requestApproval(threadId, input, sensitivity);
          if (!approved) {
            const message = "The user did not approve this step.";
            yield* log("denied", message, null);
            return yield* refuse("denied", message);
          }
          yield* requireControl(threadId);
        }
        const driver = driverFor(session, browser);
        const result = yield* driver
          .act(input)
          .pipe(Effect.tapError((error) => log("failed", error.message, null)));
        const screenshot = yield* driver.screenshot.pipe(Effect.orElseSucceed(() => null));
        yield* log("ok", result, screenshot);
        return { stepId, result };
      },
    );

    const screenshot: ComputerUseService["Service"]["screenshot"] = Effect.fn(
      "ComputerUseService.screenshot",
    )(function* (threadId, browser) {
      const session = yield* requireControl(threadId);
      const bytes = yield* driverFor(session, browser).screenshot;
      const stepId = `step:${yield* newId}`;
      yield* logStepSafely({
        id: stepId,
        threadId,
        target: session.target,
        action: "screenshot",
        intent: "Looked at the screen",
        sensitivity: null,
        status: "ok",
        result: null,
        screenshot: bytes,
      });
      return {
        stepId,
        mimeType: "image/png" as const,
        data: Buffer.from(bytes).toString("base64"),
      };
    });

    const start: ComputerUseService["Service"]["start"] = Effect.fn("ComputerUseService.start")(
      function* (input) {
        const { computerUseEnabled } = yield* settings.getSettings.pipe(
          Effect.mapError(storageFailure("Could not read settings.")),
        );
        if (!computerUseEnabled) {
          return yield* refuse("unavailable", "Turn on computer use in Settings first.");
        }
        const existing = (yield* Ref.get(sessions)).get(input.threadId);
        if (existing !== undefined) return stateOf(input.threadId, existing);
        const name =
          input.target === "virtual-display" ? yield* display.open(input.threadId) : null;
        const session: Session = {
          target: input.target,
          startedAt: yield* nowIso,
          display: name,
          takenOver: false,
          approval: null,
        };
        yield* Ref.update(sessions, (all) => new Map(all).set(input.threadId, session));
        yield* record(input.threadId, "session.start", "succeeded", input.target);
        return yield* announce(input.threadId);
      },
    );

    const stop: ComputerUseService["Service"]["stop"] = Effect.fn("ComputerUseService.stop")(
      function* (threadId) {
        const ended = yield* Ref.modify(sessions, (all) => {
          const next = new Map(all);
          next.delete(threadId);
          return [all.get(threadId), next] as const;
        });
        if (ended === undefined) return yield* getState(threadId);
        if (ended.approval !== null) yield* Deferred.succeed(ended.approval.answer, false);
        yield* display.close(threadId);
        yield* record(threadId, "session.stop", "succeeded");
        return yield* announce(threadId);
      },
    );

    const setTakenOver = Effect.fn("ComputerUseService.setTakenOver")(function* (
      threadId: ThreadId,
      takenOver: boolean,
    ) {
      const updated = yield* updateSession(threadId, (session) => ({ ...session, takenOver }));
      if (!updated) return yield* refuse("off", "Computer use is off for this conversation.");
      yield* record(threadId, takenOver ? "session.take-over" : "session.resume", "succeeded");
      return yield* announce(threadId);
    });

    const takeOver: ComputerUseService["Service"]["takeOver"] = Effect.fn(
      "ComputerUseService.takeOver",
    )(function* (threadId) {
      return yield* setTakenOver(threadId, true);
    });

    const resume: ComputerUseService["Service"]["resume"] = Effect.fn("ComputerUseService.resume")(
      function* (threadId) {
        return yield* setTakenOver(threadId, false);
      },
    );

    const answerApproval: ComputerUseService["Service"]["answerApproval"] = Effect.fn(
      "ComputerUseService.answerApproval",
    )(function* (input) {
      const session = (yield* Ref.get(sessions)).get(input.threadId);
      if (session?.approval?.info.id !== input.approvalId) {
        return yield* refuse("failed", "That step is no longer waiting.");
      }
      yield* Deferred.succeed(session.approval.answer, input.approved);
      yield* record(
        input.threadId,
        "session.approval",
        input.approved ? "succeeded" : "denied",
        session.approval.info.intent,
      );
      return yield* getState(input.threadId);
    });

    const listSteps: ComputerUseService["Service"]["listSteps"] = Effect.fn(
      "ComputerUseService.listSteps",
    )(function* (input) {
      const rows = yield* sql<StepRow>`
        SELECT * FROM computer_use_steps
        WHERE thread_id = ${input.threadId}
          AND sequence < ${input.beforeSequence ?? Number.MAX_SAFE_INTEGER}
        ORDER BY sequence DESC LIMIT ${COMPUTER_USE_STEP_PAGE_SIZE + 1}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read the step log.")),
      );
      return {
        steps: rows.slice(0, COMPUTER_USE_STEP_PAGE_SIZE).map(stepFromRow),
        hasMore: rows.length > COMPUTER_USE_STEP_PAGE_SIZE,
      };
    });

    const getScreenshot: ComputerUseService["Service"]["getScreenshot"] = Effect.fn(
      "ComputerUseService.getScreenshot",
    )(function* (input) {
      const [row] = yield* sql<{ readonly has_screenshot: number }>`
        SELECT has_screenshot FROM computer_use_steps
        WHERE thread_id = ${input.threadId} AND step_id = ${input.stepId}
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(storageFailure("Could not read the step log.")),
      );
      if (row?.has_screenshot !== 1) return yield* refuse("failed", "No screenshot is kept.");
      const bytes = yield* fileSystem
        .readFile(screenshotPath(input.threadId, input.stepId))
        .pipe(Effect.mapError(storageFailure("Could not read the screenshot.")));
      return { mimeType: "image/png" as const, data: Buffer.from(bytes).toString("base64") };
    });

    const deleteForThread: ComputerUseService["Service"]["deleteForThread"] = Effect.fn(
      "ComputerUseService.deleteForThread",
    )(function* (threadId) {
      yield* stop(threadId);
      yield* sql`DELETE FROM computer_use_steps WHERE thread_id = ${threadId}`.pipe(Effect.ignore);
      yield* fileSystem
        .remove(path.dirname(screenshotPath(threadId, "step")), {
          recursive: true,
          force: true,
        })
        .pipe(Effect.ignore);
    });

    return ComputerUseService.of({
      support: Effect.gen(function* () {
        const enabled = yield* settings.getSettings.pipe(
          Effect.map((value) => value.computerUseEnabled),
          Effect.orElseSucceed(() => false),
        );
        return { enabled, virtualDisplay: yield* display.availability };
      }),
      getState,
      subscribe: (threadId) => {
        const snapshot = Effect.gen(function* () {
          const { steps } = yield* listSteps({ threadId });
          return {
            state: yield* getState(threadId),
            recentSteps: steps.slice(0, COMPUTER_USE_RECENT_STEPS),
          };
        });
        return Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(changes);
            return Stream.concat(
              Stream.fromEffect(snapshot),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((changed) => changed === threadId),
                Stream.mapEffect(() => snapshot),
              ),
            );
          }),
        );
      },
      start,
      stop,
      takeOver,
      resume,
      answerApproval,
      act,
      screenshot,
      listSteps,
      getScreenshot,
      deleteForThread,
    });
  }),
);
