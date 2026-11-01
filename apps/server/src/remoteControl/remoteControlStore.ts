import type {
  RemoteControlAccessLevel,
  RemoteControlPairingMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export type StoredLinkState = "ready" | "spent" | "locked";
export type StoredPairingStatus = "pending" | "approved" | "denied" | "expired";

export interface StoredSwitch {
  readonly switchId: string;
  readonly threadId: ThreadId;
  readonly shareId: string;
  readonly accessLevel: RemoteControlAccessLevel;
  readonly pairingMode: RemoteControlPairingMode;
  readonly ownerReview: boolean;
  readonly linkGeneration: number;
  readonly linkState: StoredLinkState;
  readonly linkExpiresAt: number;
  readonly failedAttempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
}

export interface StoredPairing {
  readonly id: string;
  readonly switchId: string;
  readonly secretHash: string;
  readonly deviceLabel: string;
  readonly confirmationWord: string | null;
  readonly status: StoredPairingStatus;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

export interface StoredDevice {
  readonly id: string;
  readonly switchId: string;
  readonly tokenHash: string;
  readonly label: string;
  /** The address a plain HTTP session must keep using. Null on encrypted routes. */
  readonly boundPeer: string | null;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly lastAction: string | null;
  readonly lastActionAt: number | null;
}

type SwitchRow = Omit<StoredSwitch, "ownerReview"> & { readonly ownerReview: number };
const toSwitch = (row: SwitchRow): StoredSwitch => ({
  ...row,
  ownerReview: row.ownerReview !== 0,
});

/**
 * The switches and their devices. A database failure is a defect here: every caller is an auth
 * decision, and refusing the request is the right outcome.
 */
export const makeRemoteControlStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectSwitches = sql`
    SELECT
      switch_id AS "switchId",
      thread_id AS "threadId",
      share_id AS "shareId",
      access_level AS "accessLevel",
      pairing_mode AS "pairingMode",
      owner_review AS "ownerReview",
      link_generation AS "linkGeneration",
      link_state AS "linkState",
      link_expires_at AS "linkExpiresAt",
      failed_attempts AS "failedAttempts",
      next_attempt_at AS "nextAttemptAt",
      created_at AS "createdAt"
    FROM remote_control_switches
  `;
  const selectPairings = sql`
    SELECT
      id,
      switch_id AS "switchId",
      secret_hash AS "secretHash",
      device_label AS "deviceLabel",
      confirmation_word AS "confirmationWord",
      status,
      requested_at AS "requestedAt",
      expires_at AS "expiresAt"
    FROM remote_control_pairings
  `;
  const selectDevices = sql`
    SELECT
      id,
      switch_id AS "switchId",
      token_hash AS "tokenHash",
      label,
      bound_peer AS "boundPeer",
      paired_at AS "pairedAt",
      last_seen_at AS "lastSeenAt",
      expires_at AS "expiresAt",
      last_action AS "lastAction",
      last_action_at AS "lastActionAt"
    FROM remote_control_devices
  `;

  const listSwitches = sql<SwitchRow>`${selectSwitches} ORDER BY created_at`.pipe(
    Effect.map((rows) => rows.map(toSwitch)),
    Effect.orDie,
  );
  const switchWhere = (condition: ReturnType<typeof sql.and>) =>
    sql<SwitchRow>`${selectSwitches} WHERE ${condition}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : toSwitch(rows[0]))),
      Effect.orDie,
    );

  return {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: Effect.die })),
    listSwitches,
    listPairings: sql<StoredPairing>`${selectPairings} ORDER BY requested_at`.pipe(Effect.orDie),
    listDevices: sql<StoredDevice>`${selectDevices} ORDER BY paired_at`.pipe(Effect.orDie),
    switchById: (switchId: string) => switchWhere(sql`switch_id = ${switchId}`),
    switchByThread: (threadId: ThreadId) => switchWhere(sql`thread_id = ${threadId}`),
    insertSwitch: (row: StoredSwitch) =>
      sql`
        INSERT INTO remote_control_switches ${sql.insert({
          switch_id: row.switchId,
          thread_id: row.threadId,
          share_id: row.shareId,
          access_level: row.accessLevel,
          pairing_mode: row.pairingMode,
          owner_review: row.ownerReview ? 1 : 0,
          link_generation: row.linkGeneration,
          link_state: row.linkState,
          link_expires_at: row.linkExpiresAt,
          failed_attempts: row.failedAttempts,
          next_attempt_at: row.nextAttemptAt,
          created_at: row.createdAt,
        })}
      `.pipe(Effect.orDie),
    updateSettings: (input: {
      readonly switchId: string;
      readonly accessLevel: RemoteControlAccessLevel;
      readonly pairingMode: RemoteControlPairingMode;
      readonly ownerReview: boolean;
    }) =>
      sql`
        UPDATE remote_control_switches
        SET
          access_level = ${input.accessLevel},
          pairing_mode = ${input.pairingMode},
          owner_review = ${input.ownerReview ? 1 : 0}
        WHERE switch_id = ${input.switchId}
      `.pipe(Effect.orDie),
    /** A fresh link: pending pairings on the old one go, and so does the failure count. */
    rotateLink: (input: { readonly switchId: string; readonly linkExpiresAt: number }) =>
      Effect.all(
        [
          sql`DELETE FROM remote_control_pairings WHERE switch_id = ${input.switchId}`,
          sql`
            UPDATE remote_control_switches
            SET
              link_generation = link_generation + 1,
              link_state = 'ready',
              link_expires_at = ${input.linkExpiresAt},
              failed_attempts = 0,
              next_attempt_at = 0
            WHERE switch_id = ${input.switchId}
          `,
        ],
        { discard: true },
      ).pipe(sql.withTransaction, Effect.orDie),
    /** Spends the link. Returns false when another request already did. */
    spendLink: (input: { readonly switchId: string; readonly generation: number }) =>
      sql<{ readonly switchId: string }>`
        UPDATE remote_control_switches
        SET link_state = 'spent'
        WHERE switch_id = ${input.switchId}
          AND link_generation = ${input.generation}
          AND link_state = 'ready'
        RETURNING switch_id AS "switchId"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    recordFailure: (input: {
      readonly switchId: string;
      readonly failedAttempts: number;
      readonly nextAttemptAt: number;
      readonly locked: boolean;
    }) =>
      Effect.all(
        [
          sql`
            UPDATE remote_control_switches
            SET
              failed_attempts = ${input.failedAttempts},
              next_attempt_at = ${input.nextAttemptAt},
              link_state = CASE WHEN ${input.locked ? 1 : 0} = 1 THEN 'locked' ELSE link_state END
            WHERE switch_id = ${input.switchId}
          `,
          input.locked
            ? sql`DELETE FROM remote_control_pairings WHERE switch_id = ${input.switchId}`
            : Effect.void,
        ],
        { discard: true },
      ).pipe(sql.withTransaction, Effect.orDie),
    deleteSwitch: (switchId: string) =>
      sql`DELETE FROM remote_control_switches WHERE switch_id = ${switchId}`.pipe(Effect.orDie),
    pairingBySecretHash: (secretHash: string) =>
      sql<StoredPairing>`${selectPairings} WHERE secret_hash = ${secretHash}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.orDie,
      ),
    pairingById: (id: string) =>
      sql<StoredPairing>`${selectPairings} WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.orDie,
      ),
    insertPairing: (row: StoredPairing) =>
      sql`
        INSERT INTO remote_control_pairings ${sql.insert({
          id: row.id,
          switch_id: row.switchId,
          secret_hash: row.secretHash,
          device_label: row.deviceLabel,
          confirmation_word: row.confirmationWord,
          status: row.status,
          requested_at: row.requestedAt,
          expires_at: row.expiresAt,
        })}
      `.pipe(Effect.orDie),
    setPairingStatus: (id: string, status: StoredPairingStatus) =>
      sql`UPDATE remote_control_pairings SET status = ${status} WHERE id = ${id}`.pipe(
        Effect.orDie,
      ),
    deletePairing: (id: string) =>
      sql`DELETE FROM remote_control_pairings WHERE id = ${id}`.pipe(Effect.orDie),
    deviceByTokenHash: (tokenHash: string) =>
      sql<StoredDevice>`${selectDevices} WHERE token_hash = ${tokenHash}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.orDie,
      ),
    deviceById: (id: string) =>
      sql<StoredDevice>`${selectDevices} WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.orDie,
      ),
    devicesOf: (switchId: string) =>
      sql<StoredDevice>`${selectDevices} WHERE switch_id = ${switchId} ORDER BY paired_at`.pipe(
        Effect.orDie,
      ),
    insertDevice: (row: StoredDevice) =>
      sql`
        INSERT INTO remote_control_devices ${sql.insert({
          id: row.id,
          switch_id: row.switchId,
          token_hash: row.tokenHash,
          label: row.label,
          bound_peer: row.boundPeer,
          paired_at: row.pairedAt,
          last_seen_at: row.lastSeenAt,
          expires_at: row.expiresAt,
          last_action: row.lastAction,
          last_action_at: row.lastActionAt,
        })}
      `.pipe(Effect.orDie),
    touchDevice: (id: string, lastSeenAt: number) =>
      sql`UPDATE remote_control_devices SET last_seen_at = ${lastSeenAt} WHERE id = ${id}`.pipe(
        Effect.orDie,
      ),
    recordDeviceAction: (id: string, action: string, at: number) =>
      sql`
        UPDATE remote_control_devices
        SET last_action = ${action}, last_action_at = ${at}, last_seen_at = ${at}
        WHERE id = ${id}
      `.pipe(Effect.orDie),
    deleteDevice: (id: string) =>
      sql`DELETE FROM remote_control_devices WHERE id = ${id}`.pipe(Effect.orDie),
  };
});

export type RemoteControlStore = Effect.Success<typeof makeRemoteControlStore>;
