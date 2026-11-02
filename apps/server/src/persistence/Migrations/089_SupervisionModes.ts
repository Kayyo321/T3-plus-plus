import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Automatic rows were never the owner's choice, so they follow the project and default instead. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE supervision_thread_state
    SET state_json = json_set(state_json, '$.mode', json('null'))
    WHERE json_extract(state_json, '$.automatic') = 1
  `;
  yield* sql`
    UPDATE supervision_thread_state
    SET state_json = json_set(state_json, '$.mode', 'modest')
    WHERE json_extract(state_json, '$.mode') = 'on'
  `;
  yield* sql`
    UPDATE supervision_thread_state
    SET state_json = json_remove(state_json, '$.automatic')
  `;
});
