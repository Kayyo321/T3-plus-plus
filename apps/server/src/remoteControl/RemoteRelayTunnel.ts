import {
  RemoteControlError,
  type RemoteRelayConfigureInput,
  type RemoteRelayState,
} from "@t3tools/contracts";
import {
  decodeRemoteRelayChunk,
  encodeRemoteRelayChunk,
  forwardedRemoteRelayHeaders,
  isRemoteRelayPath,
  normalizeRemoteRelayUrl,
  REMOTE_RELAY_CHUNK_BYTES,
  REMOTE_RELAY_HOST_PATH,
  REMOTE_RELAY_PING,
  REMOTE_RELAY_PONG,
  type RemoteRelayEdgeFrame,
  type RemoteRelayHostFrame,
} from "@t3tools/shared/remoteRelay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";

const RELAY_SECRET_NAME = "remote-relay";
// Also how soon a relay saved by the setup script shows up, since that writes the file directly.
const RECONNECT_DELAY = Duration.seconds(5);
const PING_INTERVAL = Duration.seconds(25);
// Above Remote Control's 10 MB of files, so the server's own limits answer anything smaller.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const STALLED_UPLOAD_MS = 2 * 60_000;
// A cancelled or dropped proxy response must not advertise a length it may not reach.
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
]);

const StoredRelay = Schema.fromJsonString(
  Schema.Struct({ url: Schema.String, secret: Schema.NonEmptyString }),
);
const decodeStoredRelay = Schema.decodeUnknownOption(StoredRelay);
const encodeStoredRelay = Schema.encodeSync(StoredRelay);
const decodeEdgeFrame = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("request"),
        id: Schema.Number,
        method: Schema.String,
        target: Schema.String,
        headers: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      }),
      Schema.Struct({
        type: Schema.Literals(["request-end", "cancel"]),
        id: Schema.Number,
      }),
    ]),
  ),
);

class RemoteRelayRequestError extends Schema.TaggedError<RemoteRelayRequestError>()(
  "RemoteRelayRequestError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The local server did not answer a relayed request.";
  }
}

class RemoteRelayHeartbeatError extends Schema.TaggedError<RemoteRelayHeartbeatError>()(
  "RemoteRelayHeartbeatError",
  {},
) {
  override get message(): string {
    return "The relay stopped answering.";
  }
}

export class RemoteRelayTunnel extends Context.Service<
  RemoteRelayTunnel,
  {
    /** The public origin, only while the relay is answering this machine. */
    readonly publicUrl: Effect.Effect<string | null>;
    readonly changes: Stream.Stream<RemoteRelayState>;
    readonly configure: (
      input: RemoteRelayConfigureInput,
    ) => Effect.Effect<void, RemoteControlError>;
    readonly remove: Effect.Effect<void, RemoteControlError>;
  }
>()("t3pp/remoteControl/RemoteRelayTunnel") {}

/** Answers relayed requests against the local server. Each request is a fiber, so cancel aborts. */
export const makeRemoteRelayHost = Effect.fnUntraced(function* (input: {
  readonly origin: string;
  readonly fetch: typeof globalThis.fetch;
  readonly write: (frame: string | Uint8Array) => Effect.Effect<void, Socket.SocketError>;
}) {
  const requests = yield* FiberMap.make<number>();
  const uploads = new Map<
    number,
    {
      readonly frame: Extract<RemoteRelayEdgeFrame, { type: "request" }>;
      readonly chunks: Array<Uint8Array<ArrayBuffer>>;
      bytes: number;
      lastChunkAt: number;
    }
  >();
  const send = (frame: RemoteRelayHostFrame) => input.write(JSON.stringify(frame));

  const sendBody = (id: number, body: ReadableStream<Uint8Array>) =>
    Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) => new RemoteRelayRequestError({ cause }),
    }).pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (chunk) {
          for (let start = 0; start < chunk.byteLength; start += REMOTE_RELAY_CHUNK_BYTES) {
            const part = chunk.subarray(start, start + REMOTE_RELAY_CHUNK_BYTES);
            yield* input.write(encodeRemoteRelayChunk(id, part));
          }
        }),
      ),
    );

  const answer = Effect.fnUntraced(function* (
    frame: Extract<RemoteRelayEdgeFrame, { type: "request" }>,
    body: Blob | undefined,
  ) {
    const headers = new Headers();
    for (const [name, value] of forwardedRemoteRelayHeaders(frame.headers)) {
      headers.append(name, value);
    }
    // Only a loopback peer may claim this, and a browser's own value never gets here.
    headers.set("x-forwarded-proto", "https");
    headers.set("accept-encoding", "identity");
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        input.fetch(new URL(frame.target, input.origin), {
          method: frame.method,
          headers,
          redirect: "manual",
          signal,
          ...(body === undefined ? {} : { body }),
        }),
      catch: (cause) => new RemoteRelayRequestError({ cause }),
    });
    yield* send({
      type: "response",
      id: frame.id,
      status: response.status,
      headers: [...response.headers].filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name)),
    });
    if (response.body !== null) yield* sendBody(frame.id, response.body);
    yield* send({ type: "response-end", id: frame.id });
  });

  const run = (frame: Extract<RemoteRelayEdgeFrame, { type: "request" }>, body: Blob | undefined) =>
    FiberMap.run(
      requests,
      frame.id,
      answer(frame, body).pipe(
        Effect.catch(() => send({ type: "fail", id: frame.id })),
        Effect.ignore,
      ),
    );

  const refuse = Effect.fnUntraced(function* (id: number, status: number) {
    yield* send({ type: "response", id, status, headers: [] });
    yield* send({ type: "response-end", id });
  });

  const onFrame = Effect.fnUntraced(function* (text: string) {
    const frame = Option.getOrNull(decodeEdgeFrame(text));
    if (frame === null) return;
    if (frame.type === "request") {
      if (!isRemoteRelayPath(frame.method, frame.target)) return yield* refuse(frame.id, 404);
      if (frame.method === "GET" || frame.method === "HEAD") {
        return yield* run(frame, undefined);
      }
      const now = yield* Clock.currentTimeMillis;
      // The edge ends or cancels every upload; one it dropped would stay for the tunnel's life.
      for (const [id, upload] of uploads) {
        if (now - upload.lastChunkAt > STALLED_UPLOAD_MS) uploads.delete(id);
      }
      uploads.set(frame.id, { frame, chunks: [], bytes: 0, lastChunkAt: now });
      return;
    }
    const upload = uploads.get(frame.id);
    uploads.delete(frame.id);
    if (frame.type === "cancel") return yield* FiberMap.remove(requests, frame.id);
    if (upload !== undefined) yield* run(upload.frame, new Blob(upload.chunks));
  });

  const onChunk = Effect.fnUntraced(function* (message: Uint8Array) {
    const chunk = decodeRemoteRelayChunk(message);
    if (chunk === null) return;
    const { id, payload } = chunk;
    const upload = uploads.get(id);
    if (upload === undefined) return;
    upload.lastChunkAt = yield* Clock.currentTimeMillis;
    upload.bytes += payload.byteLength;
    if (upload.bytes > MAX_REQUEST_BYTES) {
      uploads.delete(id);
      return yield* refuse(id, 413);
    }
    upload.chunks.push(payload.slice());
  });

  return {
    receive: (message: string | Uint8Array) =>
      typeof message === "string" ? onFrame(message) : onChunk(message),
  };
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const state = yield* SubscriptionRef.make<RemoteRelayState>({
    url: null,
    status: "off",
    home: config.baseDir,
  });
  const reload = yield* Queue.sliding<void>(1);

  const setStatus = (url: string | null, status: RemoteRelayState["status"]) =>
    SubscriptionRef.update(state, (current) => ({ ...current, url, status }));

  const stored = secretStore.get(RELAY_SECRET_NAME).pipe(
    Effect.map(
      Option.flatMap((bytes) =>
        Option.flatMap(decodeStoredRelay(new TextDecoder().decode(bytes)), ({ url, secret }) =>
          Option.map(Option.fromNullishOr(normalizeRemoteRelayUrl(url)), (publicUrl) => ({
            publicUrl,
            secret,
          })),
        ),
      ),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

  const connection = ({ publicUrl, secret }: { publicUrl: string; secret: string }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* Socket.makeWebSocket(
          `${publicUrl.replace(/^http/, "ws")}${REMOTE_RELAY_HOST_PATH}`,
          {
            openTimeout: "15 seconds",
            headers: { authorization: `Bearer ${secret}` },
          },
        );
        const writer = yield* socket.writer;
        const { pull } = yield* socket.reader;
        const host = yield* makeRemoteRelayHost({
          origin: `http://127.0.0.1:${config.port}`,
          fetch: globalThis.fetch,
          write: writer.write,
        });
        const unanswered = yield* Ref.make(0);
        const heartbeat = Effect.gen(function* () {
          if ((yield* Ref.getAndUpdate(unanswered, (count) => count + 1)) > 1) {
            return yield* new RemoteRelayHeartbeatError();
          }
          yield* writer.write(REMOTE_RELAY_PING);
        }).pipe(Effect.andThen(Effect.sleep(PING_INTERVAL)), Effect.forever);
        const receiving = Effect.gen(function* () {
          for (const message of yield* pull) {
            if (message === REMOTE_RELAY_PONG) {
              yield* Ref.set(unanswered, 0);
              // Only an answered ping proves the relay took this machine's secret.
              yield* setStatus(publicUrl, "connected");
            } else {
              yield* host.receive(message);
            }
          }
        }).pipe(Effect.forever);
        return yield* Effect.raceFirst(receiving, heartbeat);
      }).pipe(Effect.provide(upstreamWebSocketConstructor)),
    );

  const stayConnected = Effect.fnUntraced(function* (relay: { publicUrl: string; secret: string }) {
    yield* SubscriptionRef.update(state, (current) =>
      current.url === relay.publicUrl && current.status === "failing"
        ? current
        : { ...current, url: relay.publicUrl, status: "connecting" as const },
    );
    yield* connection(relay).pipe(
      Effect.catchCause(() => Effect.logWarning("Remote Control relay disconnected.")),
    );
    yield* setStatus(relay.publicUrl, "failing");
    yield* Effect.sleep(RECONNECT_DELAY);
  });

  yield* Effect.gen(function* () {
    const relay = yield* stored;
    const attempt = Option.isSome(relay)
      ? stayConnected(relay.value)
      : setStatus(null, "off").pipe(Effect.andThen(Effect.sleep(RECONNECT_DELAY)));
    yield* Effect.raceFirst(attempt, Queue.take(reload));
  }).pipe(Effect.forever, Effect.forkScoped);

  const storageFailed = () => new RemoteControlError({ reason: "storage_failed" });

  return RemoteRelayTunnel.of({
    publicUrl: Effect.map(SubscriptionRef.get(state), ({ url, status }) =>
      status === "connected" ? url : null,
    ),
    changes: SubscriptionRef.changes(state),
    configure: Effect.fn("RemoteRelayTunnel.configure")(function* (input) {
      const url = normalizeRemoteRelayUrl(input.url);
      if (url === null) return yield* new RemoteControlError({ reason: "invalid_relay" });
      yield* secretStore
        .set(
          RELAY_SECRET_NAME,
          new TextEncoder().encode(encodeStoredRelay({ url, secret: input.secret })),
        )
        .pipe(Effect.mapError(storageFailed));
      yield* Queue.offer(reload, undefined);
    }),
    remove: secretStore
      .remove(RELAY_SECRET_NAME)
      .pipe(
        Effect.mapError(storageFailed),
        Effect.andThen(Queue.offer(reload, undefined)),
        Effect.asVoid,
        Effect.withSpan("RemoteRelayTunnel.remove"),
      ),
  });
});

export const layer = Layer.effect(RemoteRelayTunnel, make).pipe(
  Layer.provide(ServerSecretStore.layer),
);
