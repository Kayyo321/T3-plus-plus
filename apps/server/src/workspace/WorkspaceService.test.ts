import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SecretProviderId,
  ThreadId,
  WS_METHODS,
  WorkspaceCatalog,
  WorkspaceError,
  type WorkspaceId,
  WorkspaceSecretSummary,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as WorkspaceService from "./WorkspaceService.ts";
import { decryptSecretValue, encryptSecretValue } from "./WorkspaceService.ts";

const SECRET_VALUE = "correct-horse-battery-staple-9471";
const PROVIDER_VALUE = "held-by-the-password-manager-8362";
const projectId = ProjectId.make("project-workspaces");
const threadId = ThreadId.make("thread-workspaces");
const childThreadId = ThreadId.make("thread-workspaces-child");
const looseThreadId = ThreadId.make("thread-workspaces-loose");

const threads: Record<string, Partial<OrchestrationV2AppThread>> = {
  [threadId]: {
    projectId,
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null } as never,
  },
  [childThreadId]: {
    projectId,
    worktreePath: "/worktrees/child",
    lineage: { parentThreadId: threadId, relationshipToParent: "fork" } as never,
  },
  [looseThreadId]: {
    projectId: ProjectId.make("project-other"),
    worktreePath: null,
    lineage: { parentThreadId: null, relationshipToParent: null } as never,
  },
};

const TestLayer = WorkspaceService.layer.pipe(
  Layer.provideMerge(AuditTrail.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: (id) => {
          const thread = threads[id];
          return thread === undefined
            ? Effect.die("no such thread")
            : Effect.succeed(thread as OrchestrationV2AppThread);
        },
        getThreadRecords: () => Effect.succeed({ runs: [] }) as never,
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "op://vault/item/missing" ? undefined : PROVIDER_VALUE,
            ),
          ),
        invalidate: () => Effect.void,
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspaces-" })),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(NodeServices.layer),
);

const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(WorkspaceCatalog));

const makeWorkspace = (name: string) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService.WorkspaceService;
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-workspace-root-" });
    const workspace = yield* service.upsert({
      name,
      folders: [root],
      workingRoot: root,
      settings: {},
    });
    return { id: workspace.id, root };
  });

const seedSecrets = (workspaceId: WorkspaceId) =>
  Effect.gen(function* () {
    const service = yield* WorkspaceService.WorkspaceService;
    yield* service.setSecret({
      workspaceId,
      name: "DATABASE_URL" as never,
      secret: { type: "stored", value: Redacted.make(SECRET_VALUE) },
    });
    yield* service.setSecret({
      workspaceId,
      name: "VAULT_TOKEN" as never,
      secret: {
        type: "provider",
        reference: {
          provider: SecretProviderId.make("one_password"),
          reference: "op://vault/item/field" as never,
        },
      },
    });
  });

/** Every row of every table, as text, so nothing can hide in a column a test forgot. */
const dumpDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `;
  const rows = yield* Effect.forEach(tables, ({ name }) =>
    sql.unsafe<Record<string, unknown>>(`SELECT * FROM "${name}"`),
  );
  return JSON.stringify(rows);
});

const dumpSecretsDirectory = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { secretsDir } = yield* ServerConfig.ServerConfig;
  const names = yield* fileSystem.readDirectory(secretsDir);
  const contents = yield* Effect.forEach(names, (name) =>
    fileSystem.readFile(path.join(secretsDir, name)),
  );
  return contents.map((bytes) => Buffer.from(bytes).toString("utf8")).join("\n");
});

it.layer(TestLayer)("WorkspaceService", (it) => {
  it.effect("hands values to a launch and to nothing else", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService.WorkspaceService;
      const audit = yield* AuditTrail.AuditTrail;
      const logged: Array<unknown> = [];
      const capture = Logger.make(({ message }) => {
        logged.push(message);
      });
      const { id } = yield* makeWorkspace("staging");
      yield* seedSecrets(id);
      yield* service.attach({ target: { kind: "thread", threadId }, workspaceId: id });

      const launch = Option.getOrThrow(
        yield* service
          .launchForThread(threadId)
          .pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
      );
      assert.deepStrictEqual(Redacted.value(launch.environment), {
        DATABASE_URL: SECRET_VALUE,
        VAULT_TOKEN: PROVIDER_VALUE,
      });
      assert.deepStrictEqual(launch.secretNames, ["DATABASE_URL", "VAULT_TOKEN"]);
      assert.notInclude(String(launch.environment), SECRET_VALUE);
      assert.notInclude(JSON.stringify(launch.environment), SECRET_VALUE);

      const catalog = encodeCatalog(yield* service.catalog);
      assert.include(catalog, "DATABASE_URL");
      const audited = JSON.stringify(yield* audit.list({ domain: "workspace" }));
      assert.include(audited, "DATABASE_URL");
      const database = yield* dumpDatabase;
      const stored = yield* dumpSecretsDirectory;
      for (const [where, text] of [
        ["catalog", catalog],
        ["audit", audited],
        ["database", database],
        ["secrets directory", stored],
        ["logs", JSON.stringify(logged)],
      ] as const) {
        assert.notInclude(text, SECRET_VALUE, where);
        assert.notInclude(text, PROVIDER_VALUE, where);
      }
      // The reference is how a provider secret is found; it never crosses to a client.
      assert.notInclude(catalog, "op://vault/item/field");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a ciphertext moved to another secret or read with another key", () =>
    Effect.sync(() => {
      const key = new Uint8Array(32).fill(7);
      const ciphertext = encryptSecretValue({ key, aad: "a", value: SECRET_VALUE });
      assert.strictEqual(decryptSecretValue({ key, aad: "a", ciphertext }), SECRET_VALUE);
      assert.isUndefined(decryptSecretValue({ key, aad: "b", ciphertext }));
      assert.isUndefined(
        decryptSecretValue({ key: new Uint8Array(32).fill(8), aad: "a", ciphertext }),
      );
    }),
  );

  it.effect("exposes no method whose result could carry a value", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        Object.values(WS_METHODS)
          .filter((method) => method.startsWith("workspaces."))
          .toSorted(),
        [
          "workspaces.attach",
          "workspaces.delete",
          "workspaces.purge",
          "workspaces.removeSecret",
          "workspaces.restore",
          "workspaces.setSecret",
          "workspaces.subscribe",
          "workspaces.upsert",
        ],
      );
      // Only these two return data: `setSecret` takes a value and returns nothing.
      assert.deepStrictEqual(Object.keys(WorkspaceSecretSummary.fields).toSorted(), [
        "name",
        "provider",
        "source",
        "unmasked",
        "updatedAt",
      ]);
    }),
  );

  it.effect("resolves a thread's own workspace before its parent's, then its project's", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService.WorkspaceService;
      const project = yield* makeWorkspace("project-default");
      const parent = yield* makeWorkspace("parent-override");
      yield* service.attach({
        target: { kind: "thread", threadId },
        workspaceId: null,
      });
      yield* service.attach({ target: { kind: "project", projectId }, workspaceId: project.id });
      const nameFor = (id: ThreadId) =>
        service
          .launchForThread(id)
          .pipe(Effect.map((launch) => Option.getOrUndefined(launch)?.workspaceName));

      assert.strictEqual(yield* nameFor(threadId), "project-default");
      assert.strictEqual(yield* nameFor(childThreadId), "project-default");
      assert.isUndefined(yield* nameFor(looseThreadId));

      yield* service.attach({ target: { kind: "thread", threadId }, workspaceId: parent.id });
      assert.strictEqual(yield* nameFor(childThreadId), "parent-override");
      const child = Option.getOrThrow(yield* service.launchForThread(childThreadId));
      assert.isNull(child.workingRoot, "a worktree thread keeps its worktree");
      const own = Option.getOrThrow(yield* service.launchForThread(threadId));
      assert.strictEqual(own.workingRoot, parent.root);
    }).pipe(Effect.scoped),
  );

  it.effect("stops injecting on delete and comes back whole on restore", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService.WorkspaceService;
      const { id } = yield* makeWorkspace("reversible");
      yield* seedSecrets(id);
      yield* service.attach({ target: { kind: "thread", threadId }, workspaceId: id });

      yield* service.remove({ id });
      const removed = Option.getOrUndefined(yield* service.launchForThread(threadId));
      assert.notStrictEqual(removed?.workspaceId, id);
      yield* service.restore({ id });
      const launch = Option.getOrThrow(yield* service.launchForThread(threadId));
      assert.strictEqual(Redacted.value(launch.environment).DATABASE_URL, SECRET_VALUE);

      const purgeLive = yield* service.purge({ id }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(purgeLive), "purge needs a deleted workspace");
      yield* service.remove({ id });
      yield* service.purge({ id });
      const left = (yield* service.catalog).workspaces.filter((workspace) => workspace.id === id);
      assert.lengthOf(left, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts a process without a secret its provider cannot read, naming only the secret",
    () =>
      Effect.gen(function* () {
        const service = yield* WorkspaceService.WorkspaceService;
        const { id } = yield* makeWorkspace("locked-vault");
        yield* service.setSecret({
          workspaceId: id,
          name: "LOCKED" as never,
          secret: {
            type: "provider",
            reference: {
              provider: SecretProviderId.make("one_password"),
              reference: "op://vault/item/missing" as never,
            },
          },
        });
        yield* service.attach({ target: { kind: "thread", threadId }, workspaceId: id });
        const launch = Option.getOrThrow(yield* service.launchForThread(threadId));
        assert.deepStrictEqual(Redacted.value(launch.environment), {});
        assert.deepStrictEqual(launch.secretNames, ["LOCKED"]);
      }).pipe(Effect.scoped),
  );

  it.effect("refuses a second live workspace with the same name", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService.WorkspaceService;
      const { root } = yield* makeWorkspace("unique");
      const result = yield* service
        .upsert({ name: "UNIQUE", folders: [root], workingRoot: root, settings: {} })
        .pipe(Effect.flip);
      assert.instanceOf(result, WorkspaceError);
      assert.strictEqual(result.reason, "name_taken");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a working root outside the workspace's folders", () =>
    Effect.gen(function* () {
      const service = yield* WorkspaceService.WorkspaceService;
      const { root } = yield* makeWorkspace("rooted");
      const result = yield* service
        .upsert({ name: "elsewhere", folders: [root], workingRoot: "/tmp/other", settings: {} })
        .pipe(Effect.flip);
      assert.strictEqual(result.reason, "invalid_folders");
    }).pipe(Effect.scoped),
  );
});
