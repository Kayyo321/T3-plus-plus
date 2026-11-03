/** The wire shared by the Remote Control relay Worker and the host that dials out to it. */

export const REMOTE_RELAY_HOST_PATH = "/__relay/host";
export const REMOTE_RELAY_PING = "ping";
export const REMOTE_RELAY_PONG = "pong";
export const REMOTE_RELAY_CHUNK_BYTES = 64 * 1024;

const STATIC_PATHS = new Set([
  "/remote",
  "/apple-touch-icon.png",
  "/favicon.ico",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/manifest.webmanifest",
]);

// Forwarded with an allowlist so a browser can never present proxy or host headers to the server.
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-type",
  "cookie",
  "if-modified-since",
  "if-none-match",
  "last-event-id",
  "range",
  "user-agent",
]);

// Encoded separators and dots could survive URL parsing here and be decoded again further in.
const AMBIGUOUS_PATH = /%2f|%5c|%2e|\\|\/\.\.?(?:\/|$)/i;

/** The relay reaches Remote Control and the page's static files, never the rest of the server. */
export function isRemoteRelayPath(method: string, target: string): boolean {
  if (!target.startsWith("/") || target.startsWith("//")) return false;
  const pathname = target.split(/[?#]/, 1)[0] ?? "";
  if (AMBIGUOUS_PATH.test(pathname)) return false;
  if (pathname.startsWith("/api/remote/")) return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return STATIC_PATHS.has(pathname) || /^\/assets\/[^/]+$/.test(pathname);
}

export function forwardedRemoteRelayHeaders(
  headers: Iterable<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> {
  return [...headers].filter(([name]) => FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()));
}

/** HTTPS, or plain HTTP to this machine for a relay running under `wrangler dev`. */
export function normalizeRemoteRelayUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const local = url.protocol === "http:" && url.hostname === "127.0.0.1";
    if ((url.protocol !== "https:" && !local) || url.pathname !== "/" || url.username !== "") {
      return null;
    }
    return url.search === "" && url.hash === "" ? url.origin : null;
  } catch {
    return null;
  }
}

export type RemoteRelayEdgeFrame =
  | {
      readonly type: "request";
      readonly id: number;
      readonly method: string;
      readonly target: string;
      readonly headers: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly type: "request-end"; readonly id: number }
  | { readonly type: "cancel"; readonly id: number };

export type RemoteRelayHostFrame =
  | {
      readonly type: "response";
      readonly id: number;
      readonly status: number;
      readonly headers: ReadonlyArray<readonly [string, string]>;
    }
  | { readonly type: "response-end"; readonly id: number }
  | { readonly type: "fail"; readonly id: number };

export function encodeRemoteRelayChunk(id: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(payload.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, id);
  frame.set(payload, 4);
  return frame;
}

/** Null for a frame too short to carry an id. */
export function decodeRemoteRelayChunk(frame: Uint8Array): {
  readonly id: number;
  readonly payload: Uint8Array;
} | null {
  if (frame.byteLength < 4) return null;
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return { id: view.getUint32(0), payload: frame.subarray(4) };
}
