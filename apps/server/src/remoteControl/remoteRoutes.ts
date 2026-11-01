import type {
  RemoteControlReachability,
  RemoteControlRoute,
  RemoteControlRouteOption,
  ServerDirectEndpoint,
} from "@t3tools/contracts";
import { isSharedAddressSpaceHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import { isLoopbackHost, isWildcardHost } from "../startupAccess.ts";

const hostnameOf = (url: string) => {
  try {
    const { hostname } = new URL(url);
    return hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  } catch {
    return null;
  }
};

/** A host another device could never reach this machine on. */
const isUnreachableHost = (host: string | null) =>
  host === null || host === "" || isLoopbackHost(host) || isWildcardHost(host);

const ROUTE_ORDER = { lan: 0, tailnet: 1, connect: 2 } as const;

const NO_LAN_HINT =
  "Turn on network access for this server so devices on your network can reach it.";
const NO_TAILNET_HINT = "Connect this machine to Tailscale and turn on Tailscale access.";
const NO_CONNECT_HINT = "Link this machine to T3 Connect to reach it from anywhere.";

/**
 * The routes a link can use, best first: the local network, then the tailnet, then T3 Connect. An
 * encrypted tailnet address comes before a plain one because only HTTPS can hold a Secure cookie.
 * Anything that resolves to this machine alone is dropped, so a link never opens the wrong one.
 */
export function rankRemoteRoutes(input: {
  readonly endpoints: ReadonlyArray<ServerDirectEndpoint>;
  readonly connectHostname: string | null;
}): RemoteControlReachability {
  const direct = input.endpoints.flatMap((endpoint): ReadonlyArray<RemoteControlRoute> => {
    if (isUnreachableHost(hostnameOf(endpoint.httpBaseUrl))) return [];
    const https = endpoint.httpBaseUrl.startsWith("https:");
    return [
      {
        kind: endpoint.kind,
        baseUrl: endpoint.httpBaseUrl.replace(/\/+$/, ""),
        // Tailscale encrypts plain HTTP on the wire, but a browser still calls that page insecure.
        encrypted: https || endpoint.kind === "tailnet",
      },
    ];
  });
  const connect: ReadonlyArray<RemoteControlRoute> =
    input.connectHostname === null || isUnreachableHost(input.connectHostname)
      ? []
      : [{ kind: "connect", baseUrl: `https://${input.connectHostname}`, encrypted: true }];
  const routes = [...direct, ...connect].toSorted(
    (left, right) =>
      ROUTE_ORDER[left.kind] - ROUTE_ORDER[right.kind] ||
      Number(right.baseUrl.startsWith("https:")) - Number(left.baseUrl.startsWith("https:")),
  );
  const has = (kind: RemoteControlRoute["kind"]) => routes.some((route) => route.kind === kind);
  const unavailable: ReadonlyArray<RemoteControlRouteOption> = [
    ...(has("lan") ? [] : [{ kind: "lan" as const, hint: NO_LAN_HINT }]),
    ...(has("tailnet") ? [] : [{ kind: "tailnet" as const, hint: NO_TAILNET_HINT }]),
    ...(has("connect") ? [] : [{ kind: "connect" as const, hint: NO_CONNECT_HINT }]),
  ];
  return { routes, unavailable };
}

/** What the server can say about how one request reached it. */
export interface RemoteTransport {
  /** The direct peer, or null when the server cannot tell. */
  readonly peer: string | null;
  /** The browser sees an HTTPS page, so it keeps a Secure cookie. */
  readonly https: boolean;
  /** Nobody between the device and this server can read the traffic. */
  readonly encrypted: boolean;
}

/**
 * `X-Forwarded-Proto` counts only from loopback, where Tailscale Serve and the T3 Connect tunnel
 * reach the server. Any other peer could send it, and claiming HTTPS would lift the level cap.
 */
export function classifyRemoteTransport(input: {
  readonly peer: string | undefined;
  readonly forwardedProto: string | undefined;
}): RemoteTransport {
  const peer = input.peer ?? null;
  if (peer === null) return { peer, https: false, encrypted: false };
  if (isLoopbackHost(peer)) {
    const https = input.forwardedProto?.split(",")[0]?.trim().toLowerCase() === "https";
    return { peer, https, encrypted: https };
  }
  return {
    peer,
    https: false,
    encrypted: isSharedAddressSpaceHost(peer) || isTailnetHost(peer),
  };
}
