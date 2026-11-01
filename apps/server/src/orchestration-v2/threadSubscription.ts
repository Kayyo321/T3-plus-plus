import {
  OrchestrationV2GetThreadProjectionError,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { coalesceLiveUpdatedEvents, coalesceThreadLiveStream } from "./ThreadLiveEventCoalescer.ts";
import {
  buildBoundedThreadStreamSnapshot,
  decideThreadResume,
  isThreadReplayRawPayloadSafe,
  threadReplayEncodedBytes,
  THREAD_RESUME_MAX_REPLAY_EVENTS,
} from "./ThreadStream.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import {
  makeLiveBodyDeduper,
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "./WireProjection.ts";

function shouldUseBoundedThreadSnapshot(input: {
  readonly acceptBoundedSnapshot?: boolean;
  readonly acceptDeferredWork?: boolean;
}): boolean {
  return input.acceptBoundedSnapshot === true;
}

export const subscribeOrchestrationV2Thread = Effect.fn("ws.orchestrationV2.subscribeThread")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly afterSequence?: number;
    readonly requestCompletionMarker?: boolean;
    readonly acceptBoundedSnapshot?: boolean;
    readonly acceptDeferredWork?: boolean;
    readonly acceptCompactTurnItems?: boolean;
    readonly acceptDedupedBodies?: boolean;
    readonly acceptCompactIds?: boolean;
  }) {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const dedupeBodies = input.acceptDedupedBodies === true;
    // Replay, snapshot, and live tail share one deduper: it must see every delivered record.
    const withLiveDedupe = <E, R>(stream: Stream.Stream<OrchestrationV2ThreadStreamItem, E, R>) =>
      dedupeBodies ? Stream.suspend(() => Stream.map(stream, makeLiveBodyDeduper())) : stream;
    const applicationEvents = yield* OrchestrationEventStore.OrchestrationEventStore;

    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
    });
    yield* threadManagement.ensureLegacyTranscript(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationV2GetThreadProjectionError({
            threadId: input.threadId,
            message: `Failed to hydrate migrated thread ${input.threadId}`,
            cause,
          }),
      ),
    );

    const eventStreamFrom = (afterSequence: number) =>
      threadManagement
        .streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          coalesceThreadLiveStream,
          Stream.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while streaming orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const loadReplayThrough = (afterSequence: number, throughSequence: number) =>
      applicationEvents
        .readAgentEvents({
          threadId: input.threadId,
          afterSequence,
          throughSequence,
          limit: THREAD_RESUME_MAX_REPLAY_EVENTS + 1,
          // Downgrades can leave unknown rows; skip them and resume live from highWater so later events survive.
          skipUnknownEventTypes: true,
        })
        .pipe(
          Stream.map((stored) => ({
            kind: "event" as const,
            sequence: stored.sequence,
            event: projectDomainEventForWire(stored.event),
          })),
          Stream.runCollect,
          Effect.map((items) => Array.from(items)),
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed while replaying orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );

    const completionMarker =
      input.requestCompletionMarker === true
        ? Stream.make({ kind: "synchronized" as const })
        : Stream.empty;

    const snapshotThenLive = Effect.fn("ws.orchestrationV2.threadSnapshotThenLive")(function* () {
      const useBoundedSnapshot = shouldUseBoundedThreadSnapshot(input);
      const snapshot = yield* (
        useBoundedSnapshot
          ? threadManagement.getThreadSnapshotWindow(input.threadId, {
              rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
              deferWork: input.acceptDeferredWork === true,
              userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
            })
          : threadManagement.getThreadSnapshot(input.threadId)
      ).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to load orchestration V2 thread ${input.threadId}`,
              cause,
            }),
        ),
      );
      const { snapshotSequence } = snapshot;
      const snapshotItem = useBoundedSnapshot
        ? buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: input.acceptCompactTurnItems === true,
            dedupeBodies,
            compactIds: input.acceptCompactIds === true,
          })
        : (() => {
            const projection = projectThreadProjectionForWire(snapshot.projection);
            return {
              kind: "snapshot" as const,
              snapshotSequence,
              projection: dedupeBodies ? dedupeSnapshotBodies(projection) : projection,
            };
          })();
      return rpcInitialItems([snapshotItem]).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(snapshotSequence)),
        withLiveDedupe,
      );
    });

    // Subscribe before reading persisted events to retain concurrent publishes; clients dedupe overlap by sequence.
    if (input.afterSequence !== undefined) {
      const highWater = yield* applicationEvents.latestAgentSequence(input.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadProjectionError({
              threadId: input.threadId,
              message: `Failed to prepare orchestration V2 thread ${input.threadId} replay`,
              cause,
            }),
        ),
      );
      if (input.afterSequence > highWater) {
        return yield* snapshotThenLive();
      }
      const stats = yield* applicationEvents
        .getAgentReplayStats({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          throughSequence: highWater,
          maxEvents: THREAD_RESUME_MAX_REPLAY_EVENTS,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to measure orchestration V2 thread ${input.threadId} replay`,
                cause,
              }),
          ),
        );
      // Bound stored and projected payload bytes separately; neither bounds process memory.
      if (
        stats.eventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
        !isThreadReplayRawPayloadSafe(stats.rawPayloadBytes)
      ) {
        return yield* snapshotThenLive();
      }
      if (stats.hasCreateEvent) {
        const shell = yield* threadManagement.getThreadShell(input.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2GetThreadProjectionError({
                threadId: input.threadId,
                message: `Failed to locate recreated orchestration V2 thread ${input.threadId}`,
                cause,
              }),
          ),
        );
        // Retained creation events may describe deleted threads; replace replay only if a snapshot exists.
        if (shell !== null) return yield* snapshotThenLive();
      }
      const replay = coalesceLiveUpdatedEvents(
        yield* loadReplayThrough(input.afterSequence, highWater),
      );
      const plan = decideThreadResume({
        afterSequence: input.afterSequence,
        highWater,
        replayEventCount: replay.length,
        replayEncodedBytes: threadReplayEncodedBytes(replay),
      });
      if (plan.mode === "snapshot") {
        return yield* snapshotThenLive();
      }
      return rpcInitialItems(replay).pipe(
        Stream.concat(completionMarker),
        Stream.concat(eventStreamFrom(highWater)),
        withLiveDedupe,
      );
    }

    return yield* snapshotThenLive();
  },
);
