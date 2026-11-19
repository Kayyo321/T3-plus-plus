// The path secret is the capability: only `ide.open`, which requires terminal scope, hands it
// out. Cookies cannot authenticate here because desktop frames the editor cross-site.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as Socket from "effect/socket/Socket";

import { upstreamWebSocketConstructor } from "../device/DeviceHubProxy.ts";
import { IDE_ROUTE_PREFIX, ideRequestSecret, injectWorkbenchConfiguration } from "./ideRuntime.ts";
import * as IdeService from "./IdeService.ts";

const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "upgrade",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "cookie",
  "authorization",
  "dpop",
  "content-length",
  "accept-encoding",
  "x-forwarded-proto",
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "connection",
  "set-cookie",
]);

/** The editor sees the public host, so its own WebSocket comes back through this proxy. */
const upstreamHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  target: IdeService.IdeProxyTarget,
) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  if (request.headers.host !== undefined) headers["x-forwarded-host"] = request.headers.host;
  if (request.headers.origin !== undefined) headers.origin = target.origin;
  headers.cookie = `vscode-tkn=${target.token}`;
  return headers;
};

const pumpFrames =
  /* Frames flow for the editor's whole session; a span per stream adds nothing. */
  Effect.fnUntraced(function* (source: Socket.Socket, sink: Socket.Writer) {
    const { pull } = yield* source.reader;
    while (true) {
      yield* sink.writeAll(yield* pull);
    }
  });

const proxyWebSocket = Effect.fn("IdeProxy.proxyWebSocket")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  headers: Readonly<Record<string, string>>,
) {
  const client = yield* request.upgrade;
  const upstream = yield* Socket.makeWebSocket(upstreamUrl, {
    openTimeout: "10 seconds",
    headers: { ...headers },
  }).pipe(Effect.provide(upstreamWebSocketConstructor));
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writeToClient = yield* client.writer;
      const writeToUpstream = yield* upstream.writer;
      return yield* Effect.raceFirst(
        pumpFrames(upstream, writeToClient),
        pumpFrames(client, writeToUpstream),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

const proxyHttp = Effect.fn("IdeProxy.proxyHttp")(function* (
  request: HttpServerRequest.HttpServerRequest,
  upstreamUrl: string,
  headers: Readonly<Record<string, string>>,
  token: string,
) {
  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const method = request.method;
  const response = yield* httpClient.execute(
    HttpClientRequest.make(method)(upstreamUrl).pipe(
      HttpClientRequest.setHeaders(headers),
      method === "GET" || method === "HEAD"
        ? (self) => self
        : HttpClientRequest.bodyStream(request.stream, {
            contentType: request.headers["content-type"],
          }),
    ),
  );
  const responseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name) || value === undefined) continue;
    responseHeaders[name] = value;
  }
  // The path holds the capability; keep it out of Referer headers sent to other sites.
  responseHeaders["referrer-policy"] = "no-referrer";
  if (responseHeaders["content-type"]?.startsWith("text/html")) {
    delete responseHeaders["content-length"];
    const html = injectWorkbenchConfiguration(yield* response.text, token);
    return HttpServerResponse.text(html, {
      status: response.status,
      headers: responseHeaders,
      contentType: responseHeaders["content-type"],
    });
  }
  return HttpServerResponse.stream(response.stream, {
    status: response.status,
    headers: responseHeaders,
    ...(responseHeaders["content-type"] ? { contentType: responseHeaders["content-type"] } : {}),
  });
});

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 });
  const secret = ideRequestSecret(url.value.pathname);
  const ide = yield* IdeService.IdeService;
  const target = secret === null ? null : yield* ide.proxyTarget(secret);
  if (target === null) return HttpServerResponse.text("Not Found", { status: 404 });
  const upstreamUrl = `${target.origin}${url.value.pathname}${url.value.search}`;
  const headers = upstreamHeaders(request, target);
  if (request.headers.upgrade?.toLowerCase() === "websocket") {
    return yield* proxyWebSocket(request, upstreamUrl.replace(/^http/, "ws"), headers);
  }
  return yield* proxyHttp(request, upstreamUrl, headers, target.token).pipe(
    Effect.catchCause(() =>
      Effect.succeed(HttpServerResponse.text("The editor is not responding.", { status: 502 })),
    ),
  );
});

export const layer = HttpRouter.add("*", `${IDE_ROUTE_PREFIX}/*`, handler);
