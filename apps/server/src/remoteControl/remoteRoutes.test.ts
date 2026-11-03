import { assert, describe, it } from "@effect/vitest";

import { classifyRemoteTransport, rankRemoteRoutes } from "./remoteRoutes.ts";

describe("rankRemoteRoutes", () => {
  it("orders a relay, LAN, then tailnet with HTTPS first, then T3 Connect", () => {
    const { routes, unavailable } = rankRemoteRoutes({
      endpoints: [
        { kind: "tailnet", httpBaseUrl: "http://100.64.0.2:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://host.tail.ts.net/" },
        { kind: "lan", httpBaseUrl: "http://192.168.1.10:3773/" },
      ],
      connectHostname: "env.t3.test",
      relayUrl: "https://rc.example.workers.dev",
    });
    assert.deepEqual(routes, [
      { kind: "relay", baseUrl: "https://rc.example.workers.dev", encrypted: true },
      { kind: "lan", baseUrl: "http://192.168.1.10:3773", encrypted: false },
      { kind: "tailnet", baseUrl: "https://host.tail.ts.net", encrypted: true },
      { kind: "tailnet", baseUrl: "http://100.64.0.2:3773", encrypted: true },
      { kind: "connect", baseUrl: "https://env.t3.test", encrypted: true },
    ]);
    assert.lengthOf(unavailable, 0);
  });

  it.each([
    "http://127.0.0.1:3773/",
    "http://127.8.8.8:3773/",
    "http://localhost:3773/",
    "http://[::1]:3773/",
    "http://0.0.0.0:3773/",
    "not a url",
  ])("refuses %s, which never reaches this machine from another device", (httpBaseUrl) => {
    const { routes, unavailable } = rankRemoteRoutes({
      endpoints: [{ kind: "lan", httpBaseUrl }],
      connectHostname: null,
      relayUrl: null,
    });
    assert.lengthOf(routes, 0);
    assert.deepEqual(
      unavailable.map((option) => option.kind),
      ["relay", "lan", "tailnet", "connect"],
    );
  });

  it("refuses a loopback T3 Connect hostname", () => {
    const { routes } = rankRemoteRoutes({
      endpoints: [],
      connectHostname: "localhost",
      relayUrl: null,
    });
    assert.lengthOf(routes, 0);
  });
});

describe("classifyRemoteTransport", () => {
  const onLan = () => false;
  const onTailnet = () => true;

  it("trusts the forwarded protocol only from a local proxy", () => {
    assert.deepEqual(
      classifyRemoteTransport({
        peer: "127.0.0.1",
        forwardedProto: "https",
        arrivedOnTailnet: onLan,
      }),
      { peer: "127.0.0.1", https: true, encrypted: true },
    );
    // A LAN device claiming HTTPS must not lift the Chat cap or get a Secure cookie it would drop.
    assert.deepEqual(
      classifyRemoteTransport({
        peer: "192.168.1.20",
        forwardedProto: "https",
        arrivedOnTailnet: onLan,
      }),
      { peer: "192.168.1.20", https: false, encrypted: false },
    );
  });

  it("treats plain HTTP from loopback as unencrypted", () => {
    assert.isFalse(
      classifyRemoteTransport({
        peer: "127.0.0.1",
        forwardedProto: undefined,
        arrivedOnTailnet: onLan,
      }).encrypted,
    );
  });

  it("treats a tailnet peer as encrypted, though the browser still sees HTTP", () => {
    assert.deepEqual(
      classifyRemoteTransport({
        peer: "100.100.1.2",
        forwardedProto: undefined,
        arrivedOnTailnet: onTailnet,
      }),
      { peer: "100.100.1.2", https: false, encrypted: true },
    );
    assert.isTrue(
      classifyRemoteTransport({
        peer: "fd7a:115c:a1e0::1",
        forwardedProto: undefined,
        arrivedOnTailnet: onLan,
      }).encrypted,
    );
    // Carrier-grade NAT networks number their hosts from the same range Tailscale uses.
    assert.isFalse(
      classifyRemoteTransport({
        peer: "100.100.1.2",
        forwardedProto: undefined,
        arrivedOnTailnet: onLan,
      }).encrypted,
    );
  });

  it("fails closed when the peer is unknown", () => {
    assert.deepEqual(
      classifyRemoteTransport({
        peer: undefined,
        forwardedProto: "https",
        arrivedOnTailnet: onTailnet,
      }),
      { peer: null, https: false, encrypted: false },
    );
  });
});
