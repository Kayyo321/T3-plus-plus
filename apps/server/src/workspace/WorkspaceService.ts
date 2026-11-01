// Values live encrypted beside their names and leave this module one way: `launchForThread`, for a
// process environment. Nothing else here, and no transport, may hand one out.
import {
  type AuditActorKind,
  type ProjectId,
  SecretReference,
  type ThreadId,
  Workspace,
  WORKSPACE_MAX_SECRETS,
  WORKSPACE_SECRET_MIN_MASKED_LENGTH,
  type WorkspaceAttachInput,
  type WorkspaceAttachment,
  type WorkspaceAttachmentTarget,
  type WorkspaceCatalog,
  WorkspaceError,
  type WorkspaceErrorReason,
  WorkspaceId,
  type WorkspaceRemoveSecretInput,
  type WorkspaceSecretSummary,
  type WorkspaceSetSecretInput,
  WorkspaceSettings,
  type WorkspaceTargetInput,
  type WorkspaceUpsertInput,
} from "@t3tools/contracts";
import { makeSecretMask, noSecretMask, type SecretMask } from "@t3tools/shared/secretRedaction";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no AES-GCM.
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { isTerminalRunStatus } from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkspaceProcessEnvironment from "./WorkspaceProcessEnvironment.ts";

const SECRET_KEY_NAME = "workspace-secrets-key";
const CIPHERTEXT_VERSION = "v1";
const MAX_LINEAGE_DEPTH = 16;

const decodeFolders = Schema.decodeUnknownOption(Schema.fromJsonString(Workspace.fields.folders));
const encodeFolders = Schema.encodeSync(Schema.fromJsonString(Workspace.fields.folders));
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(WorkspaceSettings));
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(WorkspaceSettings));
const decodeReference = Schema.decodeUnknownOption(Schema.fromJsonString(SecretReference));
const encodeReference = Schema.encodeSync(Schema.fromJsonString(SecretReference));

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly foldersJson: string;
  readonly workingRoot: string;
  readonly settingsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

interface SecretRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly ciphertext: string | null;
  readonly referenceJson: string | null;
  readonly provider: string | null;
  readonly unmasked: number;
  readonly updatedAt: string;
}

interface AttachmentRow {
  readonly targetKind: string;
  readonly targetId: string;
  readonly workspaceId: string;
}

export const encryptSecretValue = (input: {
  readonly key: Uint8Array;
  readonly aad: string;
  readonly value: string;
}) => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from(input.aad, "utf8"));
  const body = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  return [
    CIPHERTEXT_VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(":");
};

/** Undefined when the row was tampered with or sealed under another key. */
export const decryptSecretValue = (input: {
  readonly key: Uint8Array;
  readonly aad: string;
  readonly ciphertext: string;
}): string | undefined => {
  const [version, iv, tag, body] = input.ciphertext.split(":");
  if (version !== CIPHERTEXT_VERSION || !iv || !tag || body === undefined) return undefined;
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      input.key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAAD(Buffer.from(input.aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return undefined;
  }
};

const secretAad = (workspaceId: string, name: string) => `${workspaceId}\u0000${name}`;

const summaryFromRow = (row: SecretRow): WorkspaceSecretSummary =>
  ({
    name: row.name,
    source: row.ciphertext === null ? "provider" : "stored",
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.ciphertext === null ? {} : { unmasked: row.unmasked === 1 }),
    updatedAt: row.updatedAt,
  }) as WorkspaceSecretSummary;

const attachmentFromRow = (row: AttachmentRow): WorkspaceAttachment | undefined =>
  row.targetKind === "project"
    ? ({
        target: { kind: "project", projectId: row.targetId as ProjectId },
        workspaceId: WorkspaceId.make(row.workspaceId),
      } as const)
    : row.targetKind === "thread"
      ? ({
          target: { kind: "thread", threadId: row.targetId as ThreadId },
          workspaceId: WorkspaceId.make(row.workspaceId),
        } as const)
      : undefined;

const targetColumns = (target: WorkspaceAttachmentTarget) =>
  target.kind === "project"
    ? ({ kind: "project", id: target.projectId } as const)
    : ({ kind: "thread", id: target.threadId } as const);

/** Who is acting, for the audit trail. A person in a client unless a transport says otherwise. */
export interface WorkspaceActor {
  readonly actor: AuditActorKind;
  readonly actorLabel?: string;
}

const USER_ACTOR: WorkspaceActor = { actor: "user" };

export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly catalog: Effect.Effect<WorkspaceCatalog, WorkspaceError>;
    /** The catalog now, then again after every change. */
    readonly subscribe: Stream.Stream<WorkspaceCatalog, WorkspaceError>;
    readonly upsert: (
      input: WorkspaceUpsertInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<Workspace, WorkspaceError>;
    /** Stops injection at once. Restore brings back the secrets and attachments as they were. */
    readonly remove: (
      input: WorkspaceTargetInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly restore: (
      input: WorkspaceTargetInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<Workspace, WorkspaceError>;
    /** The one irreversible step: forgets a deleted workspace and its secrets. */
    readonly purge: (
      input: WorkspaceTargetInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly attach: (
      input: WorkspaceAttachInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly setSecret: (
      input: WorkspaceSetSecretInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
    readonly removeSecret: (
      input: WorkspaceRemoveSecretInput,
      actor?: WorkspaceActor,
    ) => Effect.Effect<void, WorkspaceError>;
    /** Server-internal: the transports never reach this. */
    readonly launchForThread: WorkspaceProcessEnvironment.WorkspaceLaunchForThread;
  }
>()("t3pp/workspace/WorkspaceService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const resolver = yield* SecretResolver.SecretResolver;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const audit = yield* AuditTrail.AuditTrail;
  const changes = yield* PubSub.sliding<void>(1);

  const storageFailed = () => new WorkspaceError({ reason: "storage_failed" });
  const failWith = (reason: WorkspaceErrorReason) => new WorkspaceError({ reason });

  const secretKey = store
    .getOrCreateRandom(SECRET_KEY_NAME, 32)
    .pipe(Effect.mapError(storageFailed));

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const notify = PubSub.publish(changes, undefined);

  const selectSecrets = (workspaceId?: string) =>
    sql<SecretRow>`
      SELECT workspace_id AS "workspaceId", name, ciphertext, reference_json AS "referenceJson",
        provider, unmasked, updated_at AS "updatedAt"
      FROM workspace_secrets
      ${workspaceId === undefined ? sql`` : sql`WHERE workspace_id = ${workspaceId}`}
      ORDER BY name
    `;

  const selectWorkspaces = (id?: string) =>
    sql<WorkspaceRow>`
      SELECT id, name, folders_json AS "foldersJson", working_root AS "workingRoot",
        settings_json AS "settingsJson", created_at AS "createdAt", updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM workspaces
      ${id === undefined ? sql`` : sql`WHERE id = ${id}`}
      ORDER BY name COLLATE NOCASE
    `;

  const toWorkspace = (row: WorkspaceRow, secrets: ReadonlyArray<SecretRow>): Workspace =>
    ({
      id: WorkspaceId.make(row.id),
      name: row.name,
      folders: Option.getOrElse(decodeFolders(row.foldersJson), () => [row.workingRoot]),
      workingRoot: row.workingRoot,
      secrets: secrets.filter((secret) => secret.workspaceId === row.id).map(summaryFromRow),
      settings: Option.getOrElse(decodeSettings(row.settingsJson), () => ({})),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    }) as Workspace;

  const readWorkspace = Effect.fn("WorkspaceService.readWorkspace")(function* (id: string) {
    const [row] = yield* selectWorkspaces(id).pipe(Effect.mapError(storageFailed));
    if (row === undefined) return yield* failWith("not_found");
    return toWorkspace(row, yield* selectSecrets(id).pipe(Effect.mapError(storageFailed)));
  });

  const requireLive = Effect.fn("WorkspaceService.requireLive")(function* (id: string) {
    const workspace = yield* readWorkspace(id);
    if (workspace.deletedAt !== null) return yield* failWith("not_found");
    return workspace;
  });

  const catalog: WorkspaceService["Service"]["catalog"] = Effect.gen(function* () {
    const rows = yield* selectWorkspaces();
    const secrets = yield* selectSecrets();
    const attachments = yield* sql<AttachmentRow>`
      SELECT target_kind AS "targetKind", target_id AS "targetId",
        workspace_id AS "workspaceId"
      FROM workspace_attachments
    `;
    return {
      workspaces: rows.map((row) => toWorkspace(row, secrets)),
      attachments: attachments.flatMap((row) => {
        const attachment = attachmentFromRow(row);
        return attachment === undefined ? [] : [attachment];
      }),
    };
  }).pipe(Effect.mapError(storageFailed), Effect.withSpan("WorkspaceService.catalog"));

  const subscribe: WorkspaceService["Service"]["subscribe"] = Stream.unwrap(
    Effect.gen(function* () {
      // Subscribe before reading so a change during the read is not lost.
      const subscription = yield* PubSub.subscribe(changes);
      return Stream.concat(
        Stream.fromEffect(catalog),
        Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => catalog)),
      );
    }),
  );

  const validateFolders = Effect.fn("WorkspaceService.validateFolders")(function* (
    input: WorkspaceUpsertInput,
  ) {
    if (
      !input.folders.includes(input.workingRoot) ||
      input.folders.some((folder) => !path.isAbsolute(folder))
    ) {
      return yield* failWith("invalid_folders");
    }
    const isDirectory = yield* fileSystem.stat(input.workingRoot).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!isDirectory) return yield* failWith("invalid_folders");
  });

  const mapUniqueName = <A, R>(effect: Effect.Effect<A, SqlError.SqlError, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause.reason._tag === "UniqueViolation" ? failWith("name_taken") : storageFailed(),
      ),
    );

  const record = (
    actor: WorkspaceActor,
    action: string,
    workspace: { readonly id: string; readonly name: string },
    extra?: { readonly threadId?: ThreadId; readonly result?: string },
  ) =>
    audit.record({
      actor: actor.actor,
      ...(actor.actorLabel === undefined ? {} : { actorLabel: actor.actorLabel }),
      domain: "workspace",
      action,
      outcome: "succeeded",
      target: { kind: "workspace", id: workspace.id, label: workspace.name },
      ...(extra?.threadId === undefined ? {} : { threadId: extra.threadId }),
      ...(extra?.result === undefined ? {} : { result: extra.result }),
    });

  const upsert: WorkspaceService["Service"]["upsert"] = Effect.fn("WorkspaceService.upsert")(
    function* (input, actor = USER_ACTOR) {
      yield* validateFolders(input);
      const now = yield* nowIso;
      if (input.id !== undefined) {
        yield* requireLive(input.id);
        yield* mapUniqueName(sql`
          UPDATE workspaces SET
            name = ${input.name},
            folders_json = ${encodeFolders(input.folders)},
            working_root = ${input.workingRoot},
            settings_json = ${encodeSettings(input.settings)},
            updated_at = ${now}
          WHERE id = ${input.id}
        `);
      }
      const id =
        input.id ??
        WorkspaceId.make(yield* crypto.randomUUIDv4().pipe(Effect.mapError(storageFailed)));
      if (input.id === undefined) {
        yield* mapUniqueName(sql`
          INSERT INTO workspaces ${sql.insert({
            id,
            name: input.name,
            folders_json: encodeFolders(input.folders),
            working_root: input.workingRoot,
            settings_json: encodeSettings(input.settings),
            created_at: now,
            updated_at: now,
            deleted_at: null,
          })}
        `);
      }
      const saved = yield* readWorkspace(id);
      yield* record(actor, input.id === undefined ? "create" : "update", saved);
      yield* notify;
      return saved;
    },
  );

  const remove: WorkspaceService["Service"]["remove"] = Effect.fn("WorkspaceService.remove")(
    function* (input, actor = USER_ACTOR) {
      const workspace = yield* requireLive(input.id);
      const now = yield* nowIso;
      yield* sql`UPDATE workspaces SET deleted_at = ${now} WHERE id = ${input.id}`.pipe(
        Effect.mapError(storageFailed),
      );
      yield* record(actor, "delete", workspace);
      yield* notify;
    },
  );

  const restore: WorkspaceService["Service"]["restore"] = Effect.fn("WorkspaceService.restore")(
    function* (input, actor = USER_ACTOR) {
      yield* readWorkspace(input.id);
      yield* mapUniqueName(sql`UPDATE workspaces SET deleted_at = NULL WHERE id = ${input.id}`);
      const restored = yield* readWorkspace(input.id);
      yield* record(actor, "restore", restored);
      yield* notify;
      return restored;
    },
  );

  const purge: WorkspaceService["Service"]["purge"] = Effect.fn("WorkspaceService.purge")(
    function* (input, actor = USER_ACTOR) {
      const workspace = yield* readWorkspace(input.id);
      if (workspace.deletedAt === null) return yield* failWith("not_found");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM workspace_secrets WHERE workspace_id = ${input.id}`;
            yield* sql`DELETE FROM workspace_attachments WHERE workspace_id = ${input.id}`;
            yield* sql`DELETE FROM workspaces WHERE id = ${input.id}`;
          }),
        )
        .pipe(Effect.mapError(storageFailed));
      yield* record(actor, "purge", workspace);
      yield* notify;
    },
  );

  const attach: WorkspaceService["Service"]["attach"] = Effect.fn("WorkspaceService.attach")(
    function* (input, actor = USER_ACTOR) {
      const { kind, id } = targetColumns(input.target);
      if (input.target.kind === "thread") {
        // A live turn holds its environment; changing it underneath would be a lie in the header.
        const records = yield* projections
          .getThreadRecords(input.target.threadId, ["runs"], {})
          .pipe(Effect.option);
        if (
          Option.isSome(records) &&
          records.value.runs.some((run) => !isTerminalRunStatus(run.status))
        ) {
          return yield* failWith("thread_running");
        }
      }
      const threadId = input.target.kind === "thread" ? input.target.threadId : undefined;
      if (input.workspaceId === null) {
        yield* sql`
          DELETE FROM workspace_attachments
          WHERE target_kind = ${kind} AND target_id = ${id}
        `.pipe(Effect.mapError(storageFailed));
        yield* audit.record({
          actor: actor.actor,
          ...(actor.actorLabel === undefined ? {} : { actorLabel: actor.actorLabel }),
          domain: "workspace",
          action: "detach",
          outcome: "succeeded",
          target: { kind, id },
          ...(threadId === undefined ? {} : { threadId }),
        });
      } else {
        const workspace = yield* requireLive(input.workspaceId);
        const now = yield* nowIso;
        yield* sql`
          INSERT INTO workspace_attachments (target_kind, target_id, workspace_id, attached_at)
          VALUES (${kind}, ${id}, ${input.workspaceId}, ${now})
          ON CONFLICT (target_kind, target_id)
          DO UPDATE SET workspace_id = excluded.workspace_id, attached_at = excluded.attached_at
        `.pipe(Effect.mapError(storageFailed));
        yield* record(actor, "attach", workspace, {
          ...(threadId === undefined ? {} : { threadId }),
          result: `${kind} ${id}`,
        });
      }
      yield* notify;
    },
  );

  const setSecret: WorkspaceService["Service"]["setSecret"] = Effect.fn(
    "WorkspaceService.setSecret",
  )(function* (input, actor = USER_ACTOR) {
    const workspace = yield* requireLive(input.workspaceId);
    if (
      workspace.secrets.length >= WORKSPACE_MAX_SECRETS &&
      !workspace.secrets.some((secret) => secret.name === input.name)
    ) {
      return yield* failWith("too_many_secrets");
    }
    const now = yield* nowIso;
    const key = yield* secretKey;
    const columns =
      input.secret.type === "stored"
        ? {
            ciphertext: encryptSecretValue({
              key,
              aad: secretAad(input.workspaceId, input.name),
              value: Redacted.value(input.secret.value),
            }),
            reference_json: null,
            provider: null,
            unmasked:
              Redacted.value(input.secret.value).length < WORKSPACE_SECRET_MIN_MASKED_LENGTH
                ? 1
                : 0,
          }
        : {
            ciphertext: null,
            reference_json: encodeReference(input.secret.reference),
            provider: input.secret.reference.provider,
            unmasked: 0,
          };
    yield* sql`
      INSERT INTO workspace_secrets ${sql.insert({
        workspace_id: input.workspaceId,
        name: input.name,
        ...columns,
        updated_at: now,
      })}
      ON CONFLICT (workspace_id, name) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        reference_json = excluded.reference_json,
        provider = excluded.provider,
        unmasked = excluded.unmasked,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(storageFailed));
    if (input.secret.type === "provider") {
      yield* resolver.invalidate([input.secret.reference]);
    }
    yield* record(actor, "set-secret", workspace, { result: input.name });
    yield* notify;
  });

  const removeSecret: WorkspaceService["Service"]["removeSecret"] = Effect.fn(
    "WorkspaceService.removeSecret",
  )(function* (input, actor = USER_ACTOR) {
    const workspace = yield* readWorkspace(input.workspaceId);
    yield* sql`
      DELETE FROM workspace_secrets
      WHERE workspace_id = ${input.workspaceId} AND name = ${input.name}
    `.pipe(Effect.mapError(storageFailed));
    yield* record(actor, "remove-secret", workspace, { result: input.name });
    yield* notify;
  });

  const attachedWorkspaceId = Effect.fn("WorkspaceService.attachedWorkspaceId")(function* (
    threadId: ThreadId,
  ) {
    let thread = yield* projections.getThread(threadId).pipe(Effect.option);
    const projectId = Option.getOrUndefined(thread)?.projectId;
    let current: string | null = threadId;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH && current !== null; depth += 1) {
      const [row]: ReadonlyArray<{ readonly workspaceId: string }> = yield* sql<{
        readonly workspaceId: string;
      }>`
        SELECT workspace_id AS "workspaceId" FROM workspace_attachments
        WHERE target_kind = 'thread' AND target_id = ${current}
      `;
      if (row !== undefined) return row.workspaceId;
      // A child conversation runs for its parent, with the parent's credentials.
      const parent: ThreadId | null = Option.getOrUndefined(thread)?.lineage.parentThreadId ?? null;
      current = parent;
      if (parent !== null) thread = yield* projections.getThread(parent).pipe(Effect.option);
    }
    if (projectId === undefined) return undefined;
    const [project] = yield* sql<{ readonly workspaceId: string }>`
      SELECT workspace_id AS "workspaceId" FROM workspace_attachments
      WHERE target_kind = 'project' AND target_id = ${projectId}
    `;
    return project?.workspaceId;
  });

  /** The name of a variable that could not be read is safe to log; its value never is. */
  const readValues = Effect.fn("WorkspaceService.readValues")(function* (
    workspaceId: string,
    rows: ReadonlyArray<SecretRow>,
  ) {
    const key = yield* secretKey;
    const referenced = rows.flatMap((row) => {
      const reference = decodeReference(row.referenceJson ?? "");
      return Option.isSome(reference) ? [{ name: row.name, reference: reference.value }] : [];
    });
    const providerValues = yield* resolver.read(referenced.map((entry) => entry.reference));
    const fromProvider = new Map(
      referenced.map((entry, index) => [entry.name, providerValues[index]] as const),
    );
    return rows.flatMap((row) => {
      const value =
        row.ciphertext === null
          ? fromProvider.get(row.name)
          : decryptSecretValue({
              key,
              aad: secretAad(workspaceId, row.name),
              ciphertext: row.ciphertext,
            });
      return value === undefined ? [] : [{ name: row.name, value }];
    });
  });

  const launchForThread: WorkspaceService["Service"]["launchForThread"] = Effect.fn(
    "WorkspaceService.launchForThread",
  )(function* (threadId: ThreadId) {
    const workspaceId = yield* attachedWorkspaceId(threadId).pipe(Effect.orDie);
    if (workspaceId === undefined) return Option.none();
    const workspace = yield* readWorkspace(workspaceId).pipe(Effect.option);
    if (Option.isNone(workspace) || workspace.value.deletedAt !== null) return Option.none();
    const rows = yield* selectSecrets(workspaceId).pipe(Effect.orDie);
    const values = yield* readValues(workspaceId, rows).pipe(Effect.orDie);
    if (values.length < rows.length) {
      const read = new Set(values.map((entry) => entry.name));
      yield* Effect.logWarning("workspace secret could not be read", {
        workspace: workspace.value.name,
        names: rows.filter((row) => !read.has(row.name)).map((row) => row.name),
      });
    }
    const mask: SecretMask = values.length === 0 ? noSecretMask : makeSecretMask(values);
    const thread = yield* projections.getThread(threadId).pipe(Effect.option);
    const launch: WorkspaceProcessEnvironment.WorkspaceLaunch = {
      workspaceId: workspace.value.id,
      workspaceName: workspace.value.name,
      // A conversation's own worktree is its isolated checkout, so it keeps it.
      workingRoot:
        Option.getOrUndefined(thread)?.worktreePath == null ? workspace.value.workingRoot : null,
      environment: Redacted.make(Object.fromEntries(values.map((v) => [v.name, v.value]))),
      secretNames: rows.map((row) => row.name),
      mask,
      settings: workspace.value.settings,
      fingerprint: WorkspaceProcessEnvironment.fingerprintLaunch(values, workspace.value.settings),
    };
    return Option.some(launch);
  });

  return WorkspaceService.of({
    catalog,
    subscribe,
    upsert,
    remove,
    restore,
    purge,
    attach,
    setSecret,
    removeSecret,
    launchForThread,
  });
});

export const layer = Layer.effect(WorkspaceService, make);

/** The narrow view process launchers read; see `WorkspaceProcessEnvironment`. */
export const layerProcessEnvironment = Layer.effect(
  WorkspaceProcessEnvironment.WorkspaceProcessEnvironment,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService;
    return { forThread: workspaces.launchForThread };
  }),
);
