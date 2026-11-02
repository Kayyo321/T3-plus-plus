// @effect-diagnostics globalTimers:off
import { DurableObject } from "cloudflare:workers";

import {
  decodeRemoteRelayChunk,
  encodeRemoteRelayChunk,
  forwardedRemoteRelayHeaders,
  isRemoteRelayPath,
  REMOTE_RELAY_CHUNK_BYTES,
  REMOTE_RELAY_HOST_PATH,
  REMOTE_RELAY_PING,
  REMOTE_RELAY_PONG,
  type RemoteRelayEdgeFrame,
  type RemoteRelayHostFrame,
} from "@t3tools/shared/remoteRelay";

interface Env {
  readonly HOST_ROOM: DurableObjectNamespace<HostRoom>;
  readonly HOST_SECRET?: string;
}

interface PendingRequest {
  readonly opened: PromiseWithResolvers<Response>;
  readonly readable: ReadableStream<Uint8Array>;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  writes: Promise<void>;
}

const RESPONSE_TIMEOUT_MS = 30_000;
const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);

const plainResponse = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

async function isHostSecret(request: Request, env: Env): Promise<boolean> {
  const expected = env.HOST_SECRET;
  const presented = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !presented) return false;
  return crypto.subtle.timingSafeEqual(await digest(presented), await digest(expected));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isHost = url.pathname === REMOTE_RELAY_HOST_PATH;
    if (
      isHost
        ? !(await isHostSecret(request, env))
        : !isRemoteRelayPath(request.method, `${url.pathname}${url.search}`)
    ) {
      return plainResponse(404, "Not found.");
    }
    return env.HOST_ROOM.getByName("host").fetch(request);
  },
} satisfies ExportedHandler<Env>;

/** The one place a browser request and the host's outbound socket can meet. Nothing is stored. */
export class HostRoom extends DurableObject<Env> {
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(REMOTE_RELAY_PING, REMOTE_RELAY_PONG),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === REMOTE_RELAY_HOST_PATH) return this.#acceptHost();
    const host = this.ctx.getWebSockets()[0];
    if (host === undefined) {
      return plainResponse(503, "The computer running this conversation is offline.");
    }
    return this.#forward(request, host);
  }

  #acceptHost(): Response {
    for (const previous of this.ctx.getWebSockets()) previous.close(1012, "Replaced");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async #forward(request: Request, host: WebSocket): Promise<Response> {
    const id = this.#nextId++;
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const pending: PendingRequest = {
      opened: Promise.withResolvers<Response>(),
      readable,
      writer: writable.getWriter(),
      writes: Promise.resolve(),
    };
    this.#pending.set(id, pending);
    const url = new URL(request.url);
    sendFrame(host, {
      type: "request",
      id,
      method: request.method,
      target: `${url.pathname}${url.search}`,
      headers: forwardedRemoteRelayHeaders(request.headers.entries()),
    });
    void this.#sendBody(id, request, host);
    // Only the wait for headers is limited: a Remote Control stream stays open for hours.
    const timeout = setTimeout(() => this.#fail(id, host), RESPONSE_TIMEOUT_MS);
    return pending.opened.promise.finally(() => clearTimeout(timeout));
  }

  async #sendBody(id: number, request: Request, host: WebSocket) {
    try {
      for await (const chunk of request.body ?? []) {
        for (let start = 0; start < chunk.byteLength; start += REMOTE_RELAY_CHUNK_BYTES) {
          const part = chunk.subarray(start, start + REMOTE_RELAY_CHUNK_BYTES);
          host.send(encodeRemoteRelayChunk(id, part));
        }
      }
      sendFrame(host, { type: "request-end", id });
    } catch {
      this.#fail(id, host);
    }
  }

  override webSocketMessage(host: WebSocket, message: string | ArrayBuffer) {
    if (typeof message === "string") {
      this.#onFrame(JSON.parse(message) as RemoteRelayHostFrame);
      return;
    }
    const { id, payload } = decodeRemoteRelayChunk(new Uint8Array(message));
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    pending.writes = pending.writes
      .then(() => pending.writer.write(payload))
      .catch(() => this.#fail(id, host));
  }

  #onFrame(frame: RemoteRelayHostFrame) {
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) return;
    if (frame.type === "fail") {
      this.#fail(frame.id);
    } else if (frame.type === "response-end") {
      this.#pending.delete(frame.id);
      void pending.writes.then(() => pending.writer.close()).catch(() => undefined);
    } else {
      const headers = new Headers();
      for (const [name, value] of frame.headers) headers.append(name, value);
      headers.set("x-robots-tag", "noindex");
      headers.set("referrer-policy", "no-referrer");
      const body = NO_BODY_STATUSES.has(frame.status) ? null : pending.readable;
      pending.opened.resolve(new Response(body, { status: frame.status, headers }));
    }
  }

  #fail(id: number, host?: WebSocket) {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (host !== undefined && host.readyState === WebSocket.OPEN) {
      sendFrame(host, { type: "cancel", id });
    }
    pending.opened.resolve(plainResponse(502, "The computer did not answer."));
    void pending.writer.abort().catch(() => undefined);
  }

  override webSocketClose() {
    for (const id of this.#pending.keys()) this.#fail(id);
  }

  override webSocketError() {
    this.webSocketClose();
  }
}

function sendFrame(host: WebSocket, frame: RemoteRelayEdgeFrame) {
  host.send(JSON.stringify(frame));
}
