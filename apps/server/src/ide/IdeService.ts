// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental digest or timing-safe compare.
import {
  IdeError,
  type IdeOpenInput,
  type IdeOpenResult,
  type IdeThemeInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as NetService from "@t3tools/shared/Net";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeCrypto from "node:crypto";

import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { threadWorkspaceRoot } from "../project/threadWorkspaceRoot.ts";
import * as IdeAgentChanges from "./IdeAgentChanges.ts";
import { IDE_MARGIN_EXTENSION, IDE_MARGIN_EXTENSION_DIR } from "./marginExtension.ts";
import {
  ideBasePath,
  ideOpenPath,
  ideReleaseAsset,
  ideServerCommand,
  ideAgentEndpointPath,
  mergeIdeMachineSettings,
  parseIdeSettings,
  VSCODIUM_VERSION,
  type IdeReleaseAsset,
} from "./ideRuntime.ts";

const DOWNLOAD_TIMEOUT = "15 minutes";
const READY_TIMEOUT_MS = 60_000;
const RECONNECTION_GRACE_SECONDS = 300;

export interface IdeProxyTarget {
  readonly origin: string;
  readonly token: string;
}

interface RunningEditor extends IdeProxyTarget {
  readonly secret: string;
  readonly scope: Scope.Closeable;
  readonly exited: Deferred.Deferred<void>;
}

export class IdeService extends Context.Service<
  IdeService,
  {
    /** Installs and starts the editor if needed, and returns its URL for the thread's folder. */
    readonly open: (input: IdeOpenInput) => Effect.Effect<IdeOpenResult, IdeError>;
    /** Applies the client's theme to the editor; an open editor repaints without reloading. */
    readonly setTheme: (theme: IdeThemeInput) => Effect.Effect<void, IdeError>;
    /** Where an editor request goes, when its path carries the running editor's capability. */
    readonly proxyTarget: (secret: string) => Effect.Effect<IdeProxyTarget | null>;
  }
>()("t3pp/ide/IdeService") {}

const isIdeError = Schema.is(IdeError);

const failure = (reason: IdeError["reason"], detail: string) => new IdeError({ reason, detail });

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const net = yield* NetService.NetService;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const agentChanges = yield* IdeAgentChanges.IdeAgentChanges;
  const httpServer = yield* HttpServer.HttpServer;
  // The margin extension runs beside the editor and reaches this server over loopback.
  const loopbackOrigin = NetAddress.isInetAddress(httpServer.address)
    ? `http://${
        NetAddress.isUnspecified(httpServer.address.address)
          ? "127.0.0.1"
          : NetAddress.formatUrlHostString(NetAddress.formatIp(httpServer.address.address))
      }:${httpServer.address.port}`
    : null;

  const installDir = path.join(
    config.baseDir,
    "tools",
    "vscodium",
    VSCODIUM_VERSION,
    `${platform}-${arch}`,
  );
  const dataDir = path.join(config.stateDir, "ide");
  const machineSettingsPath = path.join(dataDir, "data", "Machine", "settings.json");
  const tokenPath = path.join(dataDir, "connection-token");

  const runningRef = yield* Ref.make<RunningEditor | null>(null);
  const themeRef = yield* Ref.make<IdeThemeInput | null>(null);
  const startLock = yield* Semaphore.make(1);

  const run = Effect.fn("IdeService.run")(
    function* (command: string, args: string[]) {
      const exitCode = yield* Effect.scoped(
        Effect.flatMap(
          spawner.spawn(
            ChildProcess.make(command, args, { shell: false, stdout: "ignore", stderr: "ignore" }),
          ),
          (child) => child.exitCode,
        ),
      );
      if (Number(exitCode) !== 0) {
        return yield* failure("install_failed", `${command} exited with code ${Number(exitCode)}.`);
      }
    },
    Effect.mapError((cause) =>
      isIdeError(cause) ? cause : failure("install_failed", String(cause)),
    ),
  );

  const download = Effect.fn("IdeService.download")(function* (
    asset: IdeReleaseAsset,
    archivePath: string,
  ) {
    const response = yield* httpClient.execute(HttpClientRequest.get(asset.url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(() => failure("download_failed", "Could not download the editor.")),
    );
    const hash = NodeCrypto.createHash("sha256");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(archivePath, { flag: "w" });
        yield* response.stream.pipe(
          Stream.runForEach((chunk) => {
            hash.update(chunk);
            return file.writeAll(chunk);
          }),
        );
      }),
    ).pipe(
      Effect.timeout(DOWNLOAD_TIMEOUT),
      Effect.mapError(() => failure("download_failed", "The editor download did not finish.")),
    );
    if (hash.digest("hex") !== asset.sha256) {
      return yield* failure("download_failed", "The editor download did not match its checksum.");
    }
  });

  const ensureInstalled = Effect.fn("IdeService.ensureInstalled")(function* () {
    const entry = ideServerCommand(platform, installDir, path.join);
    if (yield* fs.exists(entry.entry).pipe(Effect.orElseSucceed(() => false))) return entry;
    const asset = ideReleaseAsset(platform, arch);
    if (asset === undefined) {
      return yield* failure(
        "unsupported_platform",
        `The editor is not available for ${platform} on ${arch}.`,
      );
    }
    yield* Effect.logInfo("Installing the editor", { version: VSCODIUM_VERSION, platform, arch });
    const staging = `${installDir}.staging-${NodeCrypto.randomBytes(6).toString("hex")}`;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(staging, { recursive: true });
      const archivePath = path.join(staging, "vscodium.tar.gz");
      yield* download(asset, archivePath);
      // Windows 10 and later ship bsdtar as tar.exe.
      yield* run("tar", ["-xzf", archivePath, "-C", staging]);
      yield* fs.remove(archivePath);
      yield* fs.rename(staging, installDir);
    }).pipe(
      Effect.mapError((cause) =>
        isIdeError(cause) ? cause : failure("install_failed", "Could not install the editor."),
      ),
      Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
    return entry;
  });

  const writeMachineSettings = Effect.fn("IdeService.writeMachineSettings")(function* () {
    const theme = yield* Ref.get(themeRef);
    const existingText = yield* fs
      .readFileString(machineSettingsPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const existing = parseIdeSettings(existingText);
    if (existing === null) {
      yield* Effect.logWarning("Replacing unreadable editor settings", {
        path: machineSettingsPath,
      });
    }
    yield* writeFileStringAtomically({
      filePath: machineSettingsPath,
      // @effect-diagnostics-next-line preferSchemaOverJson:off - VS Code's settings file is free-form and read by people.
      contents: `${JSON.stringify(mergeIdeMachineSettings(existing ?? {}, theme), null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() => failure("start_failed", "Could not write the editor's settings.")),
    );
  });

  /** Built in rather than installed: VSCodium prunes extensions it did not install itself. */
  const writeMarginExtension = Effect.fn("IdeService.writeMarginExtension")(
    function* () {
      const dir = path.join(installDir, "extensions", IDE_MARGIN_EXTENSION_DIR);
      yield* fs.makeDirectory(dir, { recursive: true });
      for (const [name, contents] of Object.entries(IDE_MARGIN_EXTENSION)) {
        const target = path.join(dir, name);
        const current = yield* fs.readFileString(target).pipe(Effect.orElseSucceed(() => null));
        if (current !== contents) yield* fs.writeFileString(target, contents);
      }
    },
    Effect.mapError(() => failure("install_failed", "Could not install T3's editor extension.")),
  );

  const spawnEditor = Effect.fn("IdeService.spawnEditor")(function* () {
    const command = yield* ensureInstalled();
    yield* writeMarginExtension();
    yield* writeMachineSettings();
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const secret = NodeCrypto.randomBytes(16).toString("hex");
    yield* fs
      .writeFileString(tokenPath, token, { mode: 0o600 })
      .pipe(Effect.mapError(() => failure("start_failed", "Could not write the editor's token.")));
    const port = yield* net
      .reserveLoopbackPort("127.0.0.1")
      .pipe(Effect.mapError(() => failure("start_failed", "No free port for the editor.")));
    const origin = `http://127.0.0.1:${port}`;
    const scope = yield* Scope.make("sequential");
    return yield* Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(
            command.command,
            [
              command.entry,
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
              "--connection-token-file",
              tokenPath,
              "--server-base-path",
              ideBasePath(secret),
              "--server-data-dir",
              dataDir,
              "--telemetry-level",
              "off",
              // A closed window's extension host and language servers otherwise live for 3 hours.
              "--reconnection-grace-time",
              String(RECONNECTION_GRACE_SECONDS),
            ],
            {
              detached: false,
              shell: false,
              stdout: "ignore",
              stderr: "ignore",
              extendEnv: true,
              env:
                loopbackOrigin === null
                  ? {}
                  : { T3PP_IDE_ENDPOINT: `${loopbackOrigin}${ideAgentEndpointPath(secret)}` },
            },
          ),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(() => failure("start_failed", "Could not start the editor.")),
        );
      const exited = yield* Deferred.make<void>();
      yield* Effect.forkIn(
        child.exitCode.pipe(
          Effect.ignoreCause,
          Effect.andThen(Deferred.succeed(exited, undefined)),
          Effect.andThen(Effect.logInfo("Editor exited", { pid: Number(child.pid) })),
        ),
        scope,
      );
      yield* waitForHttpReady({
        baseUrl: origin,
        path: `${ideBasePath(secret)}/version`,
        timeoutMs: READY_TIMEOUT_MS,
        makeError: () => failure("start_failed", "The editor did not start in time."),
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      yield* Effect.logInfo("Editor started", { pid: Number(child.pid), port });
      return { origin, token, secret, scope, exited } satisfies RunningEditor;
    }).pipe(Effect.onError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)));
  });

  const ensureRunning = startLock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(runningRef);
      if (current !== null && !(yield* Deferred.isDone(current.exited))) return current;
      if (current !== null) yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
      const next = yield* spawnEditor();
      yield* Ref.set(runningRef, next);
      return next;
    }),
  );

  const open = Effect.fn("IdeService.open")(function* (input: IdeOpenInput) {
    const folder =
      (yield* threadWorkspaceRoot(input.threadId).pipe(
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        Effect.provideService(ProjectService.ProjectService, projects),
      )) ??
      Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      )?.workspaceRoot;
    if (folder === undefined) {
      return yield* failure("folder_missing", "This conversation has no folder to open.");
    }
    const running = yield* ensureRunning;
    yield* agentChanges.bind(folder, input.threadId);
    return { path: ideOpenPath(running.secret, platform, folder) };
  });

  const setTheme = Effect.fn("IdeService.setTheme")(function* (theme: IdeThemeInput) {
    yield* Ref.set(themeRef, theme);
    yield* writeMachineSettings();
  });

  const proxyTarget = Effect.fn("IdeService.proxyTarget")(function* (secret: string) {
    const running = yield* Ref.get(runningRef);
    if (running === null || !sameSecret(running.secret, secret)) return null;
    if (yield* Deferred.isDone(running.exited)) return null;
    return { origin: running.origin, token: running.token };
  });

  yield* Effect.addFinalizer(() =>
    Ref.getAndSet(runningRef, null).pipe(
      Effect.flatMap((running) =>
        running === null ? Effect.void : Scope.close(running.scope, Exit.void),
      ),
    ),
  );

  return IdeService.of({ open, setTheme, proxyTarget });
});

export const layer = Layer.effect(IdeService, make);
