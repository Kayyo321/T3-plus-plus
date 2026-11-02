import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import type { RemoteRelayState } from "@t3tools/contracts";
import {
  decodeRemoteRelayChunk,
  encodeRemoteRelayChunk,
  REMOTE_RELAY_PING,
  REMOTE_RELAY_PONG,
} from "@t3tools/shared/remoteRelay";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layer, makeRemoteRelayHost, RemoteRelayTunnel } from "./RemoteRelayTunnel.ts";

const request = (input: {
  readonly id?: number;
  readonly method?: string;
  readonly target: string;
  readonly headers?: ReadonlyArray<readonly [string, string]>;
}) =>
  JSON.stringify({
    type: "request",
    id: input.id ?? 1,
    method: input.method ?? "GET",
    target: input.target,
    headers: input.headers ?? [],
  });

const harness = Effect.fnUntraced(function* (fetch: typeof globalThis.fetch) {
  const frames: Array<string | Uint8Array> = [];
  const finished = yield* Deferred.make<void>();
  const host = yield* makeRemoteRelayHost({
    origin: "http://127.0.0.1:3773",
    fetch,
    write: (frame) =>
      Effect.gen(function* () {
        frames.push(frame);
        if (typeof frame === "string" && /"(response-end|fail)"/.test(frame)) {
          yield* Deferred.succeed(finished, undefined);
        }
      }),
  });
  const json = () =>
    frames.flatMap((frame) => (typeof frame === "string" ? [JSON.parse(frame)] : []));
  const binary = () => frames.flatMap((frame) => (typeof frame === "string" ? [] : [frame]));
  return { host, finished: Deferred.await(finished), json, binary };
});

describe("makeRemoteRelayHost", () => {
  it.effect.each(["/ws", "/pair", "/api/auth/session", "/assets/..%2f..%2fsecrets", "/"])(
    "refuses %s without touching the local server",
    (target) =>
      Effect.scoped(
        Effect.gen(function* () {
          let called = false;
          const { host, finished, json } = yield* harness(async () => {
            called = true;
            return new Response("leaked");
          });
          yield* host.receive(request({ target }));
          yield* finished;
          assert.isFalse(called);
          assert.deepEqual(json(), [
            { type: "response", id: 1, status: 404, headers: [] },
            { type: "response-end", id: 1 },
          ]);
        }),
      ),
  );

  it.effect("marks the request HTTPS, drops untrusted headers and keeps every cookie", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let seen: Request | undefined;
        const body = new Uint8Array(150_000).fill(7);
        const { host, finished, json, binary } = yield* harness(async (url, init) => {
          seen = new Request(url, init);
          const headers = new Headers({ "content-length": "150000", "x-frame-options": "DENY" });
          headers.append("set-cookie", "a=1; Path=/api/remote");
          headers.append("set-cookie", "b=2; Path=/api/remote");
          return new Response(body, { status: 200, headers });
        });
        yield* host.receive(
          request({
            target: "/api/remote/session?switch=s",
            headers: [
              ["cookie", "session=1"],
              ["x-forwarded-proto", "http"],
              ["authorization", "Bearer stolen"],
            ],
          }),
        );
        yield* finished;

        assert.strictEqual(seen?.url, "http://127.0.0.1:3773/api/remote/session?switch=s");
        assert.strictEqual(seen?.headers.get("x-forwarded-proto"), "https");
        assert.strictEqual(seen?.headers.get("cookie"), "session=1");
        assert.isNull(seen?.headers.get("authorization") ?? null);
        const [response] = json();
        assert.strictEqual(response.status, 200);
        assert.deepEqual(
          response.headers.filter(([name]: [string]) => name === "set-cookie").length,
          2,
        );
        assert.isFalse(response.headers.some(([name]: [string]) => name === "content-length"));
        const chunks = binary().map(decodeRemoteRelayChunk);
        assert.isTrue(chunks.every(({ payload }) => payload.byteLength <= 64 * 1024));
        assert.strictEqual(
          chunks.reduce((sum, { payload }) => sum + payload.byteLength, 0),
          body.byteLength,
        );
        assert.deepEqual(json().at(-1), { type: "response-end", id: 1 });
      }),
    ),
  );

  it.effect("sends an upload to the local server once all of it has arrived", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let uploaded = "";
        const { host, finished } = yield* harness(async (url, init) => {
          uploaded = await new Request(url, init).text();
          return new Response(null, { status: 204 });
        });
        const encoder = new TextEncoder();
        yield* host.receive(request({ method: "POST", target: "/api/remote/messages?switch=s" }));
        yield* host.receive(encodeRemoteRelayChunk(1, encoder.encode("hello ")));
        yield* host.receive(encodeRemoteRelayChunk(1, encoder.encode("relay")));
        yield* host.receive(JSON.stringify({ type: "request-end", id: 1 }));
        yield* finished;
        assert.strictEqual(uploaded, "hello relay");
      }),
    ),
  );

  it.effect("refuses an upload past the cap without holding it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let called = false;
        const { host, finished, json } = yield* harness(async () => {
          called = true;
          return new Response(null, { status: 204 });
        });
        yield* host.receive(request({ method: "POST", target: "/api/remote/messages?switch=s" }));
        const chunk = encodeRemoteRelayChunk(1, new Uint8Array(1024 * 1024));
        for (let sent = 0; sent < 13; sent += 1) yield* host.receive(chunk);
        yield* finished;
        yield* host.receive(JSON.stringify({ type: "request-end", id: 1 }));
        assert.isFalse(called);
        assert.deepEqual(json(), [
          { type: "response", id: 1, status: 413, headers: [] },
          { type: "response-end", id: 1 },
        ]);
      }),
    ),
  );

  it.effect("aborts the local request when the browser goes away", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>();
        const aborted = Promise.withResolvers<void>();
        const { host } = yield* harness(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              started.resolve();
              init?.signal?.addEventListener("abort", () => {
                aborted.resolve();
                reject(new Error("aborted"));
              });
            }),
        );
        yield* host.receive(request({ target: "/api/remote/stream?switch=s" }));
        yield* Effect.promise(() => started.promise);
        yield* host.receive(JSON.stringify({ type: "cancel", id: 1 }));
        yield* Effect.promise(() => aborted.promise);
      }),
    ),
  );

  it.effect("reports a failed local request", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { host, finished, json } = yield* harness(() =>
          Promise.reject(new Error("connection refused")),
        );
        yield* host.receive(request({ target: "/remote" }));
        yield* finished;
        assert.deepEqual(json(), [{ type: "fail", id: 1 }]);
      }),
    ),
  );
});

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-relay-" });
const layerTunnel = layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(NodeServices.layer),
);

const reaches = (status: RemoteRelayState["status"]) =>
  Effect.gen(function* () {
    const tunnel = yield* RemoteRelayTunnel;
    const state = yield* tunnel.changes.pipe(
      Stream.filter((candidate) => candidate.status === status),
      Stream.runHead,
    );
    return Option.getOrThrow(state);
  });

const relayServer = Effect.gen(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new NodeWS.WebSocketServer({
          port: 0,
          verifyClient: ({ req }: { req: { headers: Record<string, unknown> } }) =>
            req.headers.authorization === "Bearer right",
        }),
    ),
    (running) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of running.clients) client.terminate();
            running.close(() => resolve());
          }),
      ),
  );
  if (!server.address()) {
    yield* Effect.promise(() => new Promise<void>((resolve) => server.once("listening", resolve)));
  }
  server.on("connection", (socket) => {
    socket.on("message", (message) => {
      if (message.toString() === REMOTE_RELAY_PING) socket.send(REMOTE_RELAY_PONG);
    });
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Missing relay port");
  return { server, url: `http://127.0.0.1:${address.port}` };
});

describe("RemoteRelayTunnel", () => {
  it.live("follows a relay as it is saved, refused, replaced, and removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { server, url } = yield* relayServer;
        const tunnel = yield* RemoteRelayTunnel;

        yield* tunnel.configure({ url, secret: "wrong" });
        assert.equal((yield* reaches("failing")).url, url);
        assert.isNull(yield* tunnel.publicUrl);

        yield* tunnel.configure({ url, secret: "right" });
        const connected = yield* reaches("connected");
        assert.isFalse(JSON.stringify(connected).includes("right"));
        assert.equal(yield* tunnel.publicUrl, url);

        yield* tunnel.remove;
        assert.isNull((yield* reaches("off")).url);
        assert.isNull(yield* tunnel.publicUrl);
        const client = [...server.clients][0];
        if (client !== undefined && client.readyState !== client.CLOSED) {
          yield* Effect.promise(
            () => new Promise<void>((resolve) => client.once("close", () => resolve())),
          );
        }
      }).pipe(Effect.provide(layerTunnel)),
    ),
  );

  it.effect("picks up a relay the setup script saved", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const leftOff = yield* reaches("connecting").pipe(Effect.forkScoped);
      yield* secrets.set(
        "remote-relay",
        new TextEncoder().encode(
          JSON.stringify({ url: "http://127.0.0.1:9", secret: "from-setup" }),
        ),
      );
      yield* TestClock.adjust("5 seconds");
      assert.equal((yield* Fiber.join(leftOff)).url, "http://127.0.0.1:9");
    }).pipe(Effect.scoped, Effect.provide(layerTunnel)),
  );

  it.effect("rejects an address a relay can't be at", () =>
    Effect.gen(function* () {
      const tunnel = yield* RemoteRelayTunnel;
      const error = yield* tunnel
        .configure({ url: "http://relay.example.com", secret: "secret" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "invalid_relay");
    }).pipe(Effect.provide(layerTunnel)),
  );
});
