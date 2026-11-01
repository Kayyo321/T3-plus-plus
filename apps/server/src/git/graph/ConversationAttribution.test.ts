import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ConversationAttribution from "./ConversationAttribution.ts";

const TestLayer = ConversationAttribution.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const ref = (ordinal: number) => `refs/t3/orchestration-v2/checkpoints/scope/ordinal/${ordinal}`;

const insertCheckpoint = (ordinal: number, runId: string, capturedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_checkpoints (
        checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope,
        app_run_ordinal, status, captured_at, payload_json
      )
      VALUES (
        ${`checkpoint-${ordinal}`}, 'thread-1', 'scope', ${runId}, 'node', ${ordinal},
        ${ordinal === 0 ? null : ordinal}, 'ready', ${capturedAt},
        ${JSON.stringify({ ref: ref(ordinal) })}
      )
    `;
  });

it.layer(TestLayer)("ConversationAttribution", (it) => {
  it.effect("resolves refs to their conversation, turn, and the checkpoint before them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
          interaction_mode, created_at, updated_at, payload_json
        )
        VALUES (
          'thread-1', 'project-1', 'Fix the parser', 'codex', 'codex', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, status, requested_at, payload_json
        )
        VALUES (
          'run-1', 'thread-1', 1, 'codex', 'completed', '2026-01-01T00:00:00.000Z',
          ${JSON.stringify({ startedAt: "2026-01-01T00:00:10.000Z" })}
        )
      `;
      yield* insertCheckpoint(0, "run-1", "2026-01-01T00:00:05.000Z");
      yield* insertCheckpoint(1, "run-1", "2026-01-01T00:01:00.000Z");

      const attribution = yield* ConversationAttribution.ConversationAttribution;
      const [turn, other] = yield* attribution.readCheckpoints([ref(1), "refs/unknown"]);
      assert.isUndefined(other);
      assert.deepStrictEqual(turn, {
        ref: ref(1),
        mark: { threadId: "thread-1", title: "Fix the parser", runId: "run-1", turn: 1 } as never,
        ordinal: 1,
        previousRef: ref(0),
        startedAt: 1767225610,
        capturedAt: 1767225660,
      });
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT * FROM orchestration_v2_projection_checkpoints
        WHERE json_extract(payload_json, '$.ref') IN ('a', 'b')
      `;
      assert.include(plan[0]?.detail ?? "", "orchestration_v2_projection_checkpoints_ref_idx");
    }),
  );
});

it("leaves baselines and turns that never moved HEAD unclaimed", () => {
  const mark = { threadId: "t", title: "", runId: null, turn: 1 } as never;
  const checkpoint = (ordinal: number, capturedAt: number) => ({
    ref: ref(ordinal),
    mark,
    ordinal,
    previousRef: ordinal === 0 ? null : ref(ordinal - 1),
    startedAt: 100,
    capturedAt,
  });
  const parents = new Map([
    [ref(0), "base"],
    [ref(1), "tip"],
    [ref(2), "tip"],
  ]);
  const claims = ConversationAttribution.turnClaims(
    [checkpoint(2, 300), checkpoint(0, 100), checkpoint(1, 200)],
    parents,
  );
  assert.deepStrictEqual([...claims.keys()], ["tip"]);
  assert.strictEqual(claims.get("tip")?.endedAt, 200);
  assert.strictEqual(claims.get("tip")?.boundary, "base");
});

it("stops at the boundary and at commits older than the turn, like a pull", () => {
  const mark = { threadId: "t", title: "", runId: null, turn: 1 } as never;
  const claim = { mark, startedAt: 100, endedAt: 200, boundary: "base" };
  const claims = new Map([["tip", claim]]);
  const carried = new Map<string, ConversationAttribution.TurnClaim>();
  const walk = (sha: string, parent: string, committedAt: number) =>
    ConversationAttribution.claimCommit({ sha, parents: [parent], committedAt }, claims, carried);
  assert.strictEqual(walk("tip", "middle", 150), mark);
  assert.strictEqual(walk("middle", "pulled", 140), mark);
  assert.isNull(walk("pulled", "base", 50));
  assert.strictEqual(carried.size, 0);
});
