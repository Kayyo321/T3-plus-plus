import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The commit graph resolves hidden checkpoint refs to conversations a page at a time.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_checkpoints_ref_idx
    ON orchestration_v2_projection_checkpoints(json_extract(payload_json, '$.ref'))
  `;
});
