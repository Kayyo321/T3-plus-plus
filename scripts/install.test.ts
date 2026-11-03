// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local GitHub fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const INSTALLER = NodePath.resolve(import.meta.dirname, "../install.sh");

const nightlies = Array.from({ length: 100 }, (_, index) => ({
  tag_name: `v1.2.4-nightly.20261020.${200 - index}`,
}));

// regression: #22490
describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer channel lookup", () => {
  it.each([
    ["stable", "1.2.3"],
    ["preview", "1.2.4-preview.20261019.50"],
  ])("finds the newest %s release behind a full page of nightlies", async (channel, version) => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-index-"));
    const target = NodePath.join(root, "home/runtime/versions", version);
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const body =
        url.pathname === "/Kayyo321/T3-plus-plus/releases/latest" &&
        request.headers.accept === "application/json"
          ? { tag_name: "v1.2.3" }
          : url.pathname === "/repos/Kayyo321/T3-plus-plus/releases"
            ? { "1": nightlies, "2": [{ tag_name: `v${version}` }, { tag_name: "v1.2.3" }] }[
                url.searchParams.get("page") ?? ""
              ]
            : undefined;
      if (body === undefined) response.statusCode = 404;
      // The API pretty-prints and the installer reads it line by line.
      response.end(JSON.stringify(body ?? [], null, 2));
    });
    try {
      // An existing completed install isolates release resolution from archive downloads.
      await NodeFSP.mkdir(target, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(target, ".install-complete"), `${version}\n`);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const source = await NodeFSP.readFile(INSTALLER, "utf8");
      const installer = NodePath.join(root, "install.sh");
      await NodeFSP.writeFile(installer, source.replace(/https:\/\/(api\.)?github\.com/g, origin));
      const { code, output } = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer], {
            env: {
              ...process.env,
              T3PP_VERSION: "",
              T3PP_CHANNEL: channel,
              T3PP_HOME: NodePath.join(root, "home"),
              T3PP_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              T3PP_DESKTOP: "0",
              // A wrong version must fail here instead of downloading a real release.
              T3PP_RELEASE_BASE_URL: origin,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        },
      );
      expect(code, output).toBe(0);
      expect(output).toContain(`Installed T3++ ${version}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer checksum", () => {
  it.each(
    ["home\\data", "home\ndata"].flatMap((homeName) =>
      [true, false].map((validChecksum) => ({ homeName, validChecksum })),
    ),
  )(
    "verifies home $homeName with valid checksum $validChecksum",
    async ({ homeName, validChecksum }) => {
      const availableTools = ["sha256sum", "shasum"].filter(
        (tool) =>
          NodeChildProcess.spawnSync("sh", ["-c", 'command -v "$1"', "sh", tool]).status === 0,
      );
      expect(availableTools.length).toBeGreaterThan(0);
      for (const checksumTool of availableTools) {
        const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-checksum-"));
        const home = NodePath.join(root, homeName);
        const version = "1.2.3";
        const stem = `t3pp-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
        const archiveName = `${stem}.tar.gz`;
        const server = NodeHttp.createServer();
        try {
          const tools = NodePath.join(root, "tools");
          await NodeFSP.mkdir(tools);
          for (const command of [
            "sh",
            "uname",
            "tar",
            "gzip",
            "cut",
            "curl",
            "grep",
            "mkdir",
            "mktemp",
            "rm",
            "mv",
            "ln",
            checksumTool,
          ]) {
            const executable = NodeChildProcess.execFileSync(
              "sh",
              ["-c", 'command -v "$1"', "sh", command],
              { encoding: "utf8" },
            ).trim();
            await NodeFSP.symlink(executable, NodePath.join(tools, command));
          }
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3pp"),
            "#!/bin/sh\necho 't3pp v1.2.3'\n",
            { mode: 0o755 },
          );
          const archivePath = NodePath.join(root, archiveName);
          NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
          const archive = await NodeFSP.readFile(archivePath);
          const digest = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          server.on("request", (request, response) => {
            response.end(
              request.url?.endsWith("/SHA256SUMS")
                ? `${validChecksum ? digest : "0".repeat(64)}  ${archiveName}\n`
                : archive,
            );
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const { code, output } = await new Promise<{ code: number | null; output: string }>(
            (resolve, reject) => {
              const child = NodeChildProcess.spawn("sh", [INSTALLER], {
                env: {
                  ...process.env,
                  PATH: tools,
                  T3PP_VERSION: version,
                  T3PP_HOME: home,
                  T3PP_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
                  T3PP_DESKTOP: "0",
                  T3PP_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                },
                stdio: ["ignore", "pipe", "pipe"],
              });
              let output = "";
              child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
              child.on("error", reject);
              child.on("close", (code) => resolve({ code, output }));
            },
          );
          const versions = NodePath.join(home, "runtime/versions");
          if (validChecksum) {
            expect(code, `${checksumTool}: ${output}`).toBe(0);
            expect(
              await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
            ).toBe("1.2.3\n");
            expect(
              NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3pp"), ["--version"], {
                encoding: "utf8",
              }).trim(),
            ).toBe("t3pp v1.2.3");
          } else {
            expect(code).not.toBe(0);
            expect(output).toContain("checksum mismatch");
            expect(output).not.toContain("Installed T3++");
            expect(await NodeFSP.readdir(versions)).toEqual([]);
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      }
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer desktop app", () => {
  it("installs the AppImage with a menu entry, then uninstall removes it and the command", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-desktop-"));
    const version = "1.2.3";
    const arch = HostProcess.Architecture.defaultValue();
    const stem = `t3pp-${version}-linux-${arch}`;
    const archiveName = `${stem}.tar.gz`;
    const appImageName = `T3PP-${version}-${arch === "x64" ? "x86_64" : "arm64"}.AppImage`;
    const home = NodePath.join(root, "home");
    const share = NodePath.join(root, "share");
    const server = NodeHttp.createServer();
    try {
      await NodeFSP.mkdir(NodePath.join(root, stem));
      // Stands in for `t3pp uninstall --yes`, which the installer delegates CLI removal to.
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "t3pp"),
        `#!/bin/sh\nif [ "$1" = uninstall ]; then echo "$*" > "$T3PP_HOME/uninstall-args"; else echo 't3pp v${version}'; fi\n`,
        { mode: 0o755 },
      );
      const archivePath = NodePath.join(root, archiveName);
      NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
      const files = new Map<string, Buffer>([
        [archiveName, await NodeFSP.readFile(archivePath)],
        [appImageName, Buffer.from("#!/bin/sh\necho appimage\n")],
      ]);
      const sums = [...files]
        .map(
          ([name, bytes]) =>
            `${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
        )
        .join("");
      server.on("request", (request, response) => {
        const name = NodePath.basename(request.url ?? "");
        const body = name === "SHA256SUMS" ? sums : name.endsWith(".png") ? "png" : files.get(name);
        if (body === undefined) response.statusCode = 404;
        response.end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const installer = NodePath.join(root, "install.sh");
      const source = await NodeFSP.readFile(INSTALLER, "utf8");
      await NodeFSP.writeFile(
        installer,
        source.replaceAll("https://raw.githubusercontent.com", origin),
      );
      // Async, because the fixture server shares this event loop.
      const run = (...args: string[]) =>
        new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn("sh", [installer, ...args], {
            env: {
              ...process.env,
              T3PP_VERSION: version,
              T3PP_DESKTOP: "1",
              T3PP_HOME: home,
              T3PP_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
              T3PP_RELEASE_BASE_URL: origin,
              XDG_DATA_HOME: share,
            },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });

      const installed = await run();
      expect(installed.code, installed.output).toBe(0);
      const appImage = NodePath.join(share, "t3pp/T3PP.AppImage");
      expect(await NodeFSP.readFile(appImage, "utf8")).toBe("#!/bin/sh\necho appimage\n");
      expect((await NodeFSP.stat(appImage)).mode & 0o111).not.toBe(0);
      const entry = await NodeFSP.readFile(
        NodePath.join(share, "applications/t3pp.desktop"),
        "utf8",
      );
      expect(entry).toContain(`Exec="${appImage}" %U`);
      expect(entry).toContain(`Icon=${NodePath.join(share, "t3pp/icon.png")}`);

      const removed = await run("uninstall");
      expect(removed.code, removed.output).toBe(0);
      await expect(NodeFSP.access(NodePath.join(share, "t3pp"))).rejects.toThrow();
      await expect(
        NodeFSP.access(NodePath.join(share, "applications/t3pp.desktop")),
      ).rejects.toThrow();
      expect(await NodeFSP.readFile(NodePath.join(home, "uninstall-args"), "utf8")).toBe(
        "uninstall --yes\n",
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
