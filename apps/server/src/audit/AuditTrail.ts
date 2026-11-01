import {
  AUDIT_PAGE_MAX_ENTRIES,
  AUDIT_TEXT_MAX_CHARS,
  AuditEntry,
  AuditEntryId,
  type AuditEntryInput,
  type AuditListInput,
  type AuditListResult,
  AuditTrailError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as WorkspaceProcessEnvironment from "../workspace/WorkspaceProcessEnvironment.ts";

const RETAINED_ENTRIES = 50_000;
const PRUNE_EVERY_INSERTS = 500;

const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(AuditEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(AuditEntry));

const bounded = (text: string | undefined) =>
  text === undefined || text.length <= AUDIT_TEXT_MAX_CHARS
    ? text
    : `${text.slice(0, AUDIT_TEXT_MAX_CHARS - 1)}…`;

const boundedEntry = (input: AuditEntryInput): AuditEntryInput => {
  const request = bounded(input.request);
  const reasoning = bounded(input.reasoning);
  const result = bounded(input.result);
  return {
    ...input,
    ...(request === undefined ? {} : { request }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(result === undefined ? {} : { result }),
  };
};

export class AuditTrail extends Context.Service<
  AuditTrail,
  {
    /** Never fails: a lost audit row must not change what the action did. */
    readonly record: (input: AuditEntryInput) => Effect.Effect<void>;
    readonly list: (input: AuditListInput) => Effect.Effect<AuditListResult, AuditTrailError>;
    /** Entries recorded after subscribing. */
    readonly changes: Stream.Stream<AuditEntry>;
  }
>()("t3pp/audit/AuditTrail") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const changes = yield* PubSub.sliding<AuditEntry>(256);
  let insertsSincePrune = 0;

  const prune = sql`
    DELETE FROM audit_trail
    WHERE sequence <= (SELECT MAX(sequence) FROM audit_trail) - ${RETAINED_ENTRIES}
  `;

  const insert = Effect.fn("AuditTrail.insert")(function* (input: AuditEntryInput) {
    const entry: AuditEntry = {
      ...boundedEntry((yield* WorkspaceProcessEnvironment.ActiveSecretMasks).redactDeep(input)),
      id: AuditEntryId.make(yield* crypto.randomUUIDv4()),
      at: DateTime.formatIso(yield* DateTime.now),
    };
    yield* sql`
      INSERT INTO audit_trail ${sql.insert({
        id: entry.id,
        at: entry.at,
        actor: entry.actor,
        domain: entry.domain,
        thread_id: entry.threadId ?? null,
        entry_json: encodeEntry(entry),
      })}
    `;
    insertsSincePrune += 1;
    if (insertsSincePrune >= PRUNE_EVERY_INSERTS) {
      insertsSincePrune = 0;
      yield* prune;
    }
    yield* PubSub.publish(changes, entry);
  });

  const record: AuditTrail["Service"]["record"] = (input) =>
    insert(input).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not record an audit entry", cause)),
    );

  const list: AuditTrail["Service"]["list"] = Effect.fn("AuditTrail.list")(function* (input) {
    const limit = Math.min(input.limit ?? 50, AUDIT_PAGE_MAX_ENTRIES);
    const filters = [
      ...(input.actor === undefined ? [] : [sql`actor = ${input.actor}`]),
      ...(input.domain === undefined ? [] : [sql`domain = ${input.domain}`]),
      ...(input.threadId === undefined ? [] : [sql`thread_id = ${input.threadId}`]),
      ...(input.cursor === undefined ? [] : [sql`sequence < ${input.cursor}`]),
    ];
    const rows = yield* sql<{ readonly sequence: number; readonly entryJson: string }>`
      SELECT sequence AS "sequence", entry_json AS "entryJson"
      FROM audit_trail
      ${filters.length === 0 ? sql`` : sql`WHERE ${sql.and(filters)}`}
      ORDER BY sequence DESC
      LIMIT ${limit + 1}
    `.pipe(Effect.mapError(() => new AuditTrailError({ operation: "read its entries" })));
    const page = rows.slice(0, limit);
    return {
      entries: page.flatMap((row) => Option.toArray(decodeEntry(row.entryJson))),
      nextCursor: rows.length > limit ? (page.at(-1)?.sequence ?? null) : null,
    };
  });

  return AuditTrail.of({ record, list, changes: Stream.fromPubSub(changes) });
});

export const layer = Layer.effect(AuditTrail, make);
