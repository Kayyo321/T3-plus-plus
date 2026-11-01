import { type GitGraphConversationMark, RunId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

export const CHECKPOINT_REF_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const REFS_PER_QUERY = 500;
/** The clock a commit uses can trail the one that stamped its turn by a moment. */
const CLOCK_SLACK_SECONDS = 2;

export interface CheckpointMeta {
  readonly ref: string;
  readonly mark: GitGraphConversationMark;
  readonly ordinal: number;
  readonly previousRef: string | null;
  readonly startedAt: number | null;
  readonly capturedAt: number;
}

/** A turn claiming the commits on its first-parent chain, down to where the branch stood before it. */
export interface TurnClaim {
  readonly mark: GitGraphConversationMark;
  readonly startedAt: number;
  readonly endedAt: number;
  /** HEAD when the previous checkpoint was taken; this turn made nothing at or below it. */
  readonly boundary: string | null;
}

const toSeconds = (iso: string | null) => {
  const parsed = iso === null ? undefined : DateTime.make(iso);
  return parsed === undefined || Option.isNone(parsed)
    ? null
    : Math.floor(DateTime.toEpochMillis(parsed.value) / 1000);
};

export class ConversationAttribution extends Context.Service<
  ConversationAttribution,
  {
    /** Attribution decorates the graph, so a failed read returns nothing instead of failing it. */
    readonly readCheckpoints: (
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<CheckpointMeta>>;
  }
>()("t3pp/git/graph/ConversationAttribution") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readChunk = (refs: ReadonlyArray<string>) =>
    sql<{
      readonly ref: string;
      readonly threadId: string;
      readonly title: string | null;
      readonly runId: string | null;
      readonly turn: number | null;
      readonly ordinal: number;
      readonly previousRef: string | null;
      readonly startedAt: string | null;
      readonly capturedAt: string;
    }>`
      SELECT
        json_extract(c.payload_json, '$.ref') AS "ref",
        c.thread_id AS "threadId",
        t.title AS "title",
        c.run_id AS "runId",
        c.app_run_ordinal AS "turn",
        c.ordinal_within_scope AS "ordinal",
        c.captured_at AS "capturedAt",
        json_extract(r.payload_json, '$.startedAt') AS "startedAt",
        json_extract(p.payload_json, '$.ref') AS "previousRef"
      FROM orchestration_v2_projection_checkpoints c
      LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
      LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = c.run_id
      LEFT JOIN orchestration_v2_projection_checkpoints p
        ON p.scope_id = c.scope_id AND p.ordinal_within_scope = c.ordinal_within_scope - 1
      WHERE json_extract(c.payload_json, '$.ref') IN ${sql.in(refs)}
    `;

  const readCheckpoints: ConversationAttribution["Service"]["readCheckpoints"] = Effect.fn(
    "ConversationAttribution.readCheckpoints",
  )(function* (refs) {
    const chunks = Array.from({ length: Math.ceil(refs.length / REFS_PER_QUERY) }, (_, index) =>
      refs.slice(index * REFS_PER_QUERY, (index + 1) * REFS_PER_QUERY),
    );
    const rows = yield* Effect.forEach(chunks, readChunk).pipe(
      Effect.map((pages) => pages.flat()),
      Effect.catch((cause) =>
        Effect.logWarning("Could not read checkpoint attribution", cause).pipe(Effect.as([])),
      ),
    );
    return rows.map((row): CheckpointMeta => ({
      ref: row.ref,
      mark: {
        threadId: ThreadId.make(row.threadId),
        title: row.title ?? "",
        runId: row.runId === null ? null : RunId.make(row.runId),
        turn: row.turn,
      },
      ordinal: row.ordinal,
      previousRef: row.previousRef,
      startedAt: toSeconds(row.startedAt),
      capturedAt: toSeconds(row.capturedAt) ?? 0,
    }));
  });

  return ConversationAttribution.of({ readCheckpoints });
});

export const layer = Layer.effect(ConversationAttribution, make);

/**
 * Finds what each turn claimed. A checkpoint's commit has the HEAD of its capture as parent, so a
 * turn moved HEAD when that parent differs from the previous checkpoint's. Baselines claim nothing:
 * they only record where the conversation found the branch.
 */
export function turnClaims(
  checkpoints: ReadonlyArray<CheckpointMeta>,
  parentOfRef: ReadonlyMap<string, string>,
): ReadonlyMap<string, TurnClaim> {
  const claims = new Map<string, TurnClaim>();
  const earliestFirst = checkpoints.toSorted((a, b) => a.capturedAt - b.capturedAt);
  for (const checkpoint of earliestFirst) {
    if (checkpoint.previousRef === null || checkpoint.startedAt === null) continue;
    const head = parentOfRef.get(checkpoint.ref);
    const boundary = parentOfRef.get(checkpoint.previousRef) ?? null;
    if (head === undefined || head === boundary || claims.has(head)) continue;
    claims.set(head, {
      mark: checkpoint.mark,
      startedAt: checkpoint.startedAt,
      endedAt: checkpoint.capturedAt,
      boundary,
    });
  }
  return claims;
}

/**
 * Claims one commit and passes the claim to its first parent. Called children first. The time
 * window keeps out commits that only arrived during the turn, like a pull or a user's commit.
 */
export function claimCommit(
  commit: {
    readonly sha: string;
    readonly parents: ReadonlyArray<string>;
    readonly committedAt: number;
  },
  claims: ReadonlyMap<string, TurnClaim>,
  carried: Map<string, TurnClaim>,
): GitGraphConversationMark | null {
  const claim = claims.get(commit.sha) ?? carried.get(commit.sha);
  carried.delete(commit.sha);
  if (claim === undefined || commit.sha === claim.boundary) return null;
  const madeDuringTurn =
    commit.committedAt >= claim.startedAt - CLOCK_SLACK_SECONDS &&
    commit.committedAt <= claim.endedAt + CLOCK_SLACK_SECONDS;
  if (!madeDuringTurn) return null;
  const parent = commit.parents[0];
  if (parent !== undefined && parent !== claim.boundary) carried.set(parent, claim);
  return claim.mark;
}
