import {
  type AuditActorKind,
  CommandId,
  isNestedSessionLineage,
  MessageId,
  NESTED_SESSION_CONTEXT_SEED_MAX_CHARS,
  type NestedSessionCloseParentInput,
  type NestedSessionCloseParentResult,
  NestedSessionError,
  type NestedSessionInherit,
  type NestedSessionReportInput,
  type NestedSessionStartInput,
  type NestedSessionStartResult,
  type OrchestrationV2Actor,
  type OrchestrationV2AppThread,
  type OrchestrationV2CreationSource,
  type OrchestrationV2NestedForkOptions,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import { readForkHistoryItems, summarizeForDigest } from "./ContextHandoffService.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/** Who asked, for the thread's provenance and the audit trail. */
export interface DispatchActor {
  readonly kind: AuditActorKind;
  readonly label?: string | undefined;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

const SELECTED_FILE_MAX_CHARS = 16_000;

const fail = (detail: string) => new NestedSessionError({ detail });

const describe = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;

function framed(parent: Pick<OrchestrationV2AppThread, "id" | "title">, body: string): string {
  const header = `You are a nested session under the conversation "${parent.title}" (${parent.id}). The user can talk to you directly. Use report_to_parent to leave a summary card there when you have something to hand back.`;
  return `${header}\n\n${body}`.slice(0, NESTED_SESSION_CONTEXT_SEED_MAX_CHARS);
}

/** Newest lines survive a long conversation: they are what the child is continuing from. */
export function digestConversation(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const lines = items.flatMap((item) => {
    const line = summarizeForDigest(item);
    return line === null ? [] : [line];
  });
  const kept: Array<string> = [];
  let remaining = NESTED_SESSION_CONTEXT_SEED_MAX_CHARS / 2;
  for (const line of lines.toReversed()) {
    if (line.length + 1 > remaining) break;
    kept.unshift(line);
    remaining -= line.length + 1;
  }
  return [
    "Summary of the parent conversation so far:",
    ...(kept.length < lines.length ? ["- Earlier items truncated."] : []),
    ...kept,
  ].join("\n");
}

export class NestedSessionService extends Context.Service<
  NestedSessionService,
  {
    readonly start: (
      input: NestedSessionStartInput,
      actor: DispatchActor,
    ) => Effect.Effect<NestedSessionStartResult, NestedSessionError>;
    /** Leaves a summary card in the parent, not the child's transcript. */
    readonly report: (
      input: NestedSessionReportInput,
      actor: DispatchActor,
    ) => Effect.Effect<void, NestedSessionError>;
    /** Archives a conversation after doing what the user chose with its nested sessions. */
    readonly closeParent: (
      input: NestedSessionCloseParentInput,
      actor: DispatchActor,
    ) => Effect.Effect<NestedSessionCloseParentResult, NestedSessionError>;
    /** Nested sessions at every depth under a thread, parents first. */
    readonly listChildren: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, NestedSessionError>;
  }
>()("t3pp/orchestration-v2/NestedSessionService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launcher = yield* ThreadLaunchService.ThreadLaunchService;
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const files = yield* WorkspaceFileSystem.WorkspaceFileSystem;
  const audit = yield* AuditTrail.AuditTrail;
  const crypto = yield* Crypto.Crypto;

  const record = (
    actor: DispatchActor,
    entry: { readonly action: string; readonly threadId: ThreadId; readonly result?: string },
  ) =>
    audit.record({
      actor: actor.kind,
      ...(actor.label === undefined ? {} : { actorLabel: actor.label }),
      domain: "nested-session",
      outcome: "succeeded",
      ...entry,
    });

  const selectionSeed = Effect.fn("NestedSessionService.selectionSeed")(function* (
    parent: OrchestrationV2AppThread,
    selection: Extract<NestedSessionInherit, { readonly type: "selection" }>,
  ) {
    const { messages } = yield* projections
      .getThreadRecords(parent.id, ["messages"])
      .pipe(
        Effect.mapError((cause) => fail(describe(cause, "The conversation could not be read."))),
      );
    const chosen = new Set(selection.messageIds);
    const messageBlocks = messages
      .filter((message) => chosen.has(message.id))
      .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.text}`);
    const project = yield* projects
      .get(parent.projectId)
      .pipe(Effect.mapError((cause) => fail(describe(cause, "The project could not be read."))));
    const cwd =
      parent.worktreePath ?? (project._tag === "Some" ? project.value.workspaceRoot : undefined);
    const fileBlocks =
      cwd === undefined
        ? []
        : yield* Effect.forEach(selection.filePaths, (relativePath) =>
            files.readFile({ cwd, relativePath, allowMissing: true }).pipe(
              Effect.map((read) =>
                read.exists
                  ? `File ${read.relativePath}:\n${read.contents.slice(0, SELECTED_FILE_MAX_CHARS)}`
                  : `File ${relativePath} no longer exists.`,
              ),
              Effect.orElseSucceed(() => `File ${relativePath} could not be read.`),
            ),
          );
    return ["The user chose this context for you:", ...messageBlocks, ...fileBlocks].join("\n\n");
  });

  const nestedOptions = Effect.fn("NestedSessionService.nestedOptions")(function* (
    input: NestedSessionStartInput,
    parent: OrchestrationV2AppThread,
  ) {
    const modes = {
      ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
      ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
    };
    const { inherit } = input;
    switch (inherit.type) {
      case "nothing":
        return { inherit: "none", ...modes } satisfies OrchestrationV2NestedForkOptions;
      case "transcript":
        return { inherit: "transcript", ...modes } satisfies OrchestrationV2NestedForkOptions;
      case "selection":
        return {
          inherit: "seed",
          contextSeed: framed(parent, yield* selectionSeed(parent, inherit)),
          ...modes,
        } satisfies OrchestrationV2NestedForkOptions;
      case "summary": {
        if (inherit.text !== undefined) {
          return {
            inherit: "seed",
            contextSeed: framed(parent, inherit.text),
            ...modes,
          } satisfies OrchestrationV2NestedForkOptions;
        }
        const history = yield* projections
          .getThreadRecords(parent.id, ["runs", "attempts"])
          .pipe(
            Effect.mapError((cause) =>
              fail(describe(cause, "The conversation could not be read.")),
            ),
          );
        const lastRun = history.runs.at(-1);
        const items =
          lastRun === undefined
            ? []
            : yield* readForkHistoryItems(projections, history, lastRun).pipe(
                Effect.mapError((cause) =>
                  fail(describe(cause, "The conversation could not be read.")),
                ),
              );
        return {
          inherit: "seed",
          contextSeed: framed(parent, digestConversation(items)),
          ...modes,
        } satisfies OrchestrationV2NestedForkOptions;
      }
    }
  });

  // A child whose first turn never started is an empty thread nobody asked to keep.
  const discardChild = (input: NestedSessionStartInput) =>
    threads
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`${input.commandId}:discard`),
        threadId: input.threadId,
      })
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not remove a nested session that failed to start", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );

  const start: NestedSessionService["Service"]["start"] = Effect.fn("NestedSessionService.start")(
    function* (input, actor) {
      const parent = yield* projections
        .getThread(input.parentThreadId)
        .pipe(
          Effect.mapError((cause) => fail(describe(cause, "The parent conversation is gone."))),
        );
      const nested = yield* nestedOptions(input, parent);
      if (input.modelSelection !== undefined) {
        yield* threads
          .assertProviderInstanceEnabled({
            projectId: parent.projectId,
            commandId: input.commandId,
            instanceId: input.modelSelection.instanceId,
          })
          .pipe(
            Effect.mapError((cause) =>
              fail(describe(cause, "The provider is not enabled for this project.")),
            ),
          );
      }
      yield* threads
        .dispatch({
          type: "thread.fork",
          commandId: input.commandId,
          sourceThreadId: input.parentThreadId,
          targetThreadId: input.threadId,
          sourcePoint:
            input.inherit.type === "transcript"
              ? (input.inherit.sourcePoint ?? { type: "latest_stable" })
              : { type: "latest_stable" },
          title: input.title ?? `${parent.title} (nested)`,
          nested,
          createdBy: actor.createdBy,
          creationSource: actor.creationSource,
        })
        .pipe(
          Effect.mapError((cause) => fail(describe(cause, "The nested session could not start."))),
        );
      const child = yield* projections
        .getThread(input.threadId)
        .pipe(Effect.mapError((cause) => fail(describe(cause, "The nested session is missing."))));
      const workspace = input.workspace ?? { type: "shared" as const };
      const launches = workspace.type === "worktree" || input.message !== undefined;
      const launched = launches
        ? yield* launcher
            .launch({
              commandId: CommandId.make(`${input.commandId}:launch`),
              threadId: input.threadId,
              reuseExistingThread: true,
              projectId: child.projectId,
              title: child.title,
              modelSelection: child.modelSelection,
              runtimeMode: child.runtimeMode,
              interactionMode: child.interactionMode,
              workspaceStrategy:
                workspace.type === "worktree"
                  ? {
                      type: "worktree",
                      baseRef: workspace.baseRef ?? child.branch ?? "HEAD",
                      ...(workspace.branch === undefined ? {} : { branch: workspace.branch }),
                    }
                  : child.worktreePath === null
                    ? child.branch === null
                      ? { type: "root" }
                      : { type: "root", branch: child.branch }
                    : {
                        type: "existing_worktree",
                        worktreePath: child.worktreePath,
                        ...(child.branch === null ? {} : { branch: child.branch }),
                      },
              ...(input.message === undefined
                ? {}
                : {
                    initialMessage: {
                      text: input.message,
                      attachments: [],
                      senderThreadId: input.parentThreadId,
                    },
                  }),
              createdBy: actor.createdBy,
              creationSource: actor.creationSource,
            })
            .pipe(
              Effect.tapError(() => discardChild(input)),
              Effect.mapError((cause) =>
                fail(describe(cause, "The nested session could not start its first turn.")),
              ),
            )
        : null;
      yield* record(actor, {
        action: "nested-session.start",
        threadId: input.parentThreadId,
        result: `Started ${input.threadId}, inheriting ${input.inherit.type}.`,
      });
      return {
        threadId: input.threadId,
        projectId: child.projectId,
        runId: launched?.projection.runs.at(-1)?.id ?? null,
      };
    },
  );

  const report: NestedSessionService["Service"]["report"] = Effect.fn(
    "NestedSessionService.report",
  )(function* (input, actor) {
    const child = yield* projections
      .getThread(input.threadId)
      .pipe(Effect.mapError((cause) => fail(describe(cause, "This session is gone."))));
    const parentThreadId = child.lineage.parentThreadId;
    if (!isNestedSessionLineage(child.lineage) || parentThreadId === null) {
      return yield* fail("Only a nested session has a parent to report to.");
    }
    const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const notification = {
      source: { kind: "handoff" as const, childThreadId: input.threadId },
      outcome: input.outcome ?? ("completed" as const),
      summary: `${child.title}: ${input.summary}`.slice(0, 240),
      ...(input.detail === undefined ? {} : { detail: input.detail }),
    };
    yield* threads
      .dispatch({
        type: "thread.handoff-card.post",
        commandId: CommandId.make(`command:handoff-card:${id}`),
        threadId: parentThreadId,
        notification,
        ...(input.wakeParent === true
          ? {
              wake: {
                messageId: MessageId.make(`message:handoff-card:${id}`),
                text: [
                  `Nested session "${child.title}" (${input.threadId}) reported: ${input.summary}`,
                  ...(input.detail === undefined ? [] : [input.detail]),
                ].join("\n\n"),
              },
            }
          : {}),
      })
      .pipe(Effect.mapError((cause) => fail(describe(cause, "The report could not be posted."))));
    yield* record(actor, {
      action: "nested-session.report",
      threadId: input.threadId,
      result: notification.summary,
    });
  });

  const listChildren: NestedSessionService["Service"]["listChildren"] = Effect.fn(
    "NestedSessionService.listChildren",
  )(function* (threadId) {
    const snapshot = yield* Effect.flatten(threads.readShellSnapshot({ familyOf: threadId })).pipe(
      Effect.mapError((cause) => fail(describe(cause, "Threads could not be read."))),
    );
    const byParent = new Map<ThreadId, Array<OrchestrationV2ThreadShell>>();
    for (const thread of snapshot.threads) {
      const parent = thread.lineage.parentThreadId;
      if (parent === null || !isNestedSessionLineage(thread.lineage)) continue;
      byParent.set(parent, [...(byParent.get(parent) ?? []), thread]);
    }
    const ordered: Array<OrchestrationV2ThreadShell> = [];
    const visit = (id: ThreadId) => {
      for (const child of byParent.get(id) ?? []) {
        ordered.push(child);
        visit(child.id);
      }
    };
    visit(threadId);
    return ordered;
  });

  const stopChild = (threadId: ThreadId) =>
    threads
      .forceStopThread({ threadId })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not stop a nested session", { threadId, cause }),
        ),
      );

  const archive = (threadId: ThreadId, closeId: string) =>
    threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`command:close-parent:${closeId}:${threadId}`),
        threadId,
      })
      .pipe(
        Effect.mapError((cause) =>
          fail(describe(cause, "The conversation could not be archived.")),
        ),
      );

  const closeParent: NestedSessionService["Service"]["closeParent"] = Effect.fn(
    "NestedSessionService.closeParent",
  )(function* (input, actor) {
    const children = yield* listChildren(input.threadId);
    const closeId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const archived: Array<ThreadId> = [];
    const stopped: Array<ThreadId> = [];
    if (input.children !== "keep") {
      // Deepest first, so no child outlives the parent it reports to.
      for (const child of children.toReversed()) {
        if (child.activityRunStatus != null) {
          yield* stopChild(child.id);
          stopped.push(child.id);
        }
        if (input.children === "archive" && child.archivedAt === null) {
          yield* archive(child.id, closeId);
          archived.push(child.id);
        }
      }
    }
    yield* archive(input.threadId, closeId);
    yield* record(actor, {
      action: `nested-session.close-parent.${input.children}`,
      threadId: input.threadId,
      result: `${children.length} nested sessions: ${archived.length} archived, ${stopped.length} stopped.`,
    });
    return {
      archivedThreadIds: archived,
      stoppedThreadIds: stopped,
      keptThreadIds:
        input.children === "keep"
          ? children.map((child) => child.id)
          : children.filter((child) => !archived.includes(child.id)).map((child) => child.id),
    };
  });

  return NestedSessionService.of({ start, report, closeParent, listChildren });
});

export const layer = Layer.effect(NestedSessionService, make);
