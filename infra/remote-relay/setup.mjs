#!/usr/bin/env node
// Deploys the relay to the Cloudflare account Wrangler is signed in to, then gives this machine
// the address and shared secret. The secret goes straight to Cloudflare and the T3 home.
// Plain JavaScript so it runs on any Node that Wrangler itself supports.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

const relayDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const { values } = NodeUtil.parseArgs({ options: { home: { type: "string" } } });
const home = NodePath.resolve(
  (values.home ?? process.env.T3PP_HOME ?? NodePath.join(NodeOS.homedir(), ".t3pp")).replace(
    /^~(?=\/)/,
    NodeOS.homedir(),
  ),
);

function wrangler(args, input) {
  return new Promise((done, fail) => {
    const child = NodeChildProcess.spawn(
      NodePath.join(relayDir, "node_modules/.bin/wrangler"),
      args,
      {
        cwd: relayDir,
        stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
      },
    );
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) done(output);
      else fail(new Error(`wrangler ${args[0]} exited with ${code}`));
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

const deployed = await wrangler(["deploy"]);
const url = deployed.match(/https:\/\/\S+\.workers\.dev/)?.[0];
if (url === undefined) throw new Error("Wrangler did not print a workers.dev address.");

const secret = NodeCrypto.randomBytes(32).toString("hex");
await wrangler(["secret", "put", "HOST_SECRET"], secret);

const file = NodePath.join(home, "userdata", "secrets", "remote-relay.bin");
await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
await NodeFSP.writeFile(`${file}.tmp`, JSON.stringify({ url, secret }), { mode: 0o600 });
await NodeFSP.rename(`${file}.tmp`, file);
await NodeFSP.chmod(file, 0o600);

console.log(`\nRelay ready at ${url}\nSaved its connection to ${file}\nT3++ connects by itself.`);
