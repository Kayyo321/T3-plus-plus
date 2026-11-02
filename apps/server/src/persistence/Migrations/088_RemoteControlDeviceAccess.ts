import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE remote_control_devices
    ADD COLUMN access TEXT NOT NULL DEFAULT 'session'
  `;
  yield* sql`
    ALTER TABLE remote_control_switches
    ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]'
  `;
  // Full already meant all of these, so a switch left on keeps what its devices could do.
  yield* sql`
    UPDATE remote_control_switches
    SET permissions_json = '["model","mode","threadMode","rename","stop"]'
    WHERE access_level = 'full'
  `;
});
