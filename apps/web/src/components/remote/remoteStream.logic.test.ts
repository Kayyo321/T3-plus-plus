import type { RemoteControlStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyRemoteStreamEvent,
  formatPairingCode,
  formatRemaining,
  initialRemoteStreamState,
  linkSwitchId,
  OWNER_OFFLINE_AFTER_ATTEMPTS,
  parseRemoteStreamEvent,
  reconnectDelayMs,
  remoteStreamUrl,
  streamEventSequence,
  suggestedDeviceLabel,
} from "./remoteStream.logic";

describe("applyRemoteStreamEvent", () => {
  it("remembers why the session ended, so the page can say so", () => {
    const next = applyRemoteStreamEvent(initialRemoteStreamState, {
      type: "ended",
      reason: "revoked",
    });
    expect(next.thread.ended).toBe(true);
    expect(next.endReason).toBe("revoked");
  });
});

describe("streamEventSequence", () => {
  it("reads the sequence to resume from, and ignores events without one", () => {
    const event = (item: unknown) => ({ type: "thread", item }) as RemoteControlStreamEvent;
    expect(streamEventSequence(event({ kind: "snapshot", snapshotSequence: 7 }))).toBe(7);
    expect(streamEventSequence(event({ kind: "event", sequence: 9 }))).toBe(9);
    expect(streamEventSequence(event({ kind: "synchronized" }))).toBeNull();
    expect(streamEventSequence({ type: "ended", reason: "expired" })).toBeNull();
  });
});

describe("remoteStreamUrl", () => {
  it("asks for a snapshot on first connect and resumes after that", () => {
    expect(remoteStreamUrl("sw", 0)).toBe("/api/remote/stream?switch=sw");
    expect(remoteStreamUrl("sw", 42)).toBe("/api/remote/stream?switch=sw&after=42");
  });
});

describe("reconnectDelayMs", () => {
  it("backs off, and stays within what a phone waking up can bear", () => {
    expect(reconnectDelayMs(1)).toBe(1_000);
    expect(reconnectDelayMs(OWNER_OFFLINE_AFTER_ATTEMPTS)).toBe(5_000);
    expect(reconnectDelayMs(50)).toBe(30_000);
  });
});

describe("linkSwitchId", () => {
  it("names the switch of a link and rejects anything else", () => {
    expect(linkSwitchId("abc.2.signature")).toBe("abc");
    expect(linkSwitchId("abc")).toBeNull();
    expect(linkSwitchId("abc.2")).toBeNull();
  });
});

describe("suggestedDeviceLabel", () => {
  it.each([
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36", "Pixel 8"],
    ["Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36", "Android phone"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "iPhone"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "Mac"],
    ["curl/8.0", "My device"],
  ])("reads %s", (userAgent, label) => {
    expect(suggestedDeviceLabel(userAgent)).toBe(label);
  });
});

describe("formatRemaining", () => {
  const now = Date.parse("2026-11-01T00:00:00.000Z");
  it.each([
    ["2026-11-01T00:00:30.000Z", "under a minute"],
    ["2026-11-01T00:05:00.000Z", "5m"],
    ["2026-11-01T02:00:00.000Z", "2h"],
    ["2026-11-01T11:20:00.000Z", "11h 20m"],
  ])("formats %s", (until, label) => {
    expect(formatRemaining(until, now)).toBe(label);
  });
});

describe("formatPairingCode", () => {
  it("groups the code so it reads aloud", () => {
    expect(formatPairingCode("12345678")).toBe("1234 5678");
  });
});

describe("parseRemoteStreamEvent", () => {
  it("skips a frame the server would never send", () => {
    expect(parseRemoteStreamEvent("not json")).toBeNull();
    expect(parseRemoteStreamEvent('{"type":"ended","reason":"revoked"}')).toEqual({
      type: "ended",
      reason: "revoked",
    });
  });
});
