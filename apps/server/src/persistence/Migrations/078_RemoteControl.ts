import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_control_switches (
      switch_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      share_id TEXT NOT NULL,
      access_level TEXT NOT NULL,
      pairing_mode TEXT NOT NULL,
      owner_review INTEGER NOT NULL,
      link_generation INTEGER NOT NULL,
      link_state TEXT NOT NULL,
      link_expires_at INTEGER NOT NULL,
      failed_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_control_pairings (
      id TEXT PRIMARY KEY,
      switch_id TEXT NOT NULL REFERENCES remote_control_switches(switch_id) ON DELETE CASCADE,
      secret_hash TEXT NOT NULL UNIQUE,
      device_label TEXT NOT NULL,
      confirmation_word TEXT,
      status TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_control_devices (
      id TEXT PRIMARY KEY,
      switch_id TEXT NOT NULL REFERENCES remote_control_switches(switch_id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      bound_peer TEXT,
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_action TEXT,
      last_action_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_remote_control_pairings_switch
    ON remote_control_pairings(switch_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_remote_control_devices_switch
    ON remote_control_devices(switch_id)
  `;
});
