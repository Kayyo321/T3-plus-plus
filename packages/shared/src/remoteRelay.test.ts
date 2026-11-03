import { REMOTE_CONTROL_PAGE_PATH, REMOTE_CONTROL_ROUTE_PREFIX } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeRemoteRelayChunk,
  encodeRemoteRelayChunk,
  forwardedRemoteRelayHeaders,
  isRemoteRelayPath,
  normalizeRemoteRelayUrl,
} from "./remoteRelay.ts";

describe("isRemoteRelayPath", () => {
  it("follows the contract's Remote Control paths", () => {
    expect(isRemoteRelayPath("GET", REMOTE_CONTROL_PAGE_PATH)).toBe(true);
    expect(isRemoteRelayPath("POST", `${REMOTE_CONTROL_ROUTE_PREFIX}/messages?switch=1`)).toBe(
      true,
    );
  });

  it.each([
    ["GET", "/assets/main-abc123.js", true],
    ["GET", "/favicon.ico", true],
    ["POST", "/remote", false],
    ["POST", "/assets/main-abc123.js", false],
    ["GET", "/", false],
    ["GET", "/ws", false],
    ["GET", "/pair", false],
    ["GET", "/oauth/callback", false],
    ["GET", "/.well-known/t3/environment", false],
    ["GET", "/api/auth/session", false],
    ["GET", "/api/remotely", false],
    ["GET", "/assets/nested/secret.txt", false],
    ["GET", "/assets/../api/auth/session", false],
    ["GET", "/api/remote/../auth/session", false],
    ["GET", "/api/remote/%2e%2e/auth/session", false],
    ["GET", "/assets/..%2f..%2fuserdata%2fsettings.json", false],
    ["GET", "/assets/..%5csecrets", false],
    ["GET", "/assets\\..\\secrets", false],
    ["GET", "//evil.test/remote", false],
    ["GET", "http://evil.test/remote", false],
  ])("%s %s is %s", (method, target, allowed) => {
    expect(isRemoteRelayPath(method, target)).toBe(allowed);
  });
});

describe("forwardedRemoteRelayHeaders", () => {
  it("keeps what the page needs and drops anything that could claim trust", () => {
    expect(
      forwardedRemoteRelayHeaders([
        ["Cookie", "session=1"],
        ["last-event-id", "4"],
        ["x-forwarded-proto", "https"],
        ["x-forwarded-for", "127.0.0.1"],
        ["host", "127.0.0.1"],
        ["authorization", "Bearer stolen"],
        ["cf-connecting-ip", "203.0.113.1"],
      ]),
    ).toEqual([
      ["Cookie", "session=1"],
      ["last-event-id", "4"],
    ]);
  });
});

describe("normalizeRemoteRelayUrl", () => {
  it.each([
    ["https://rc.example.workers.dev/", "https://rc.example.workers.dev"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://rc.example.workers.dev", null],
    ["http://192.168.1.10:8787", null],
    ["https://user:pass@rc.example.workers.dev", null],
    ["https://rc.example.workers.dev/path", null],
    ["https://rc.example.workers.dev/?token=1", null],
    ["not a url", null],
  ])("%s becomes %s", (value, expected) => {
    expect(normalizeRemoteRelayUrl(value)).toBe(expected);
  });
});

describe("relay chunks", () => {
  it("round-trips an id and payload from inside a larger buffer", () => {
    const encoded = encodeRemoteRelayChunk(0xfffffffe, new Uint8Array([1, 2, 3]));
    const shifted = new Uint8Array(encoded.byteLength + 5);
    shifted.set(encoded, 5);
    const chunk = decodeRemoteRelayChunk(shifted.subarray(5));
    expect(chunk?.id).toBe(0xfffffffe);
    expect([...(chunk?.payload ?? [])]).toEqual([1, 2, 3]);
    expect(decodeRemoteRelayChunk(new Uint8Array([0, 0, 1]))).toBeNull();
  });
});
