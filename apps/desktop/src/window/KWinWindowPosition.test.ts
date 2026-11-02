import { assert, describe, it } from "@effect/vitest";

import {
  decodeKWinPosition,
  isKWinWaylandSession,
  kwinPositionScript,
} from "./KWinWindowPosition.ts";

describe("KWinWindowPosition", () => {
  it("only asks KWin on a KDE Wayland session", () => {
    const kde = { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "KDE" };
    assert.isTrue(isKWinWaylandSession(kde));
    assert.isTrue(isKWinWaylandSession({ ...kde, XDG_CURRENT_DESKTOP: "ubuntu:KDE" }));
    assert.isFalse(isKWinWaylandSession({ ...kde, XDG_SESSION_TYPE: "x11" }));
    assert.isFalse(isKWinWaylandSession({ ...kde, XDG_CURRENT_DESKTOP: "GNOME" }));
    assert.isFalse(isKWinWaylandSession({}));
  });

  it("reads only well-formed moves", () => {
    const message = { interface: "dev.t3pp.WindowPosition", member: "Moved" };
    assert.deepEqual(decodeKWinPosition({ ...message, body: [709, 375] }), { x: 709, y: 375 });
    assert.isNull(decodeKWinPosition({ ...message, body: ["709", 375] }));
    assert.isNull(decodeKWinPosition({ ...message, member: "Other", body: [1, 2] }));
    assert.isNull(decodeKWinPosition({ interface: "other", member: "Moved", body: [1, 2] }));
  });

  it("escapes the bus name into the script", () => {
    const script = kwinPositionScript({ pid: 42, service: ':1.7"' });
    assert.include(script, "const pid = 42;");
    assert.include(script, JSON.stringify(':1.7"'));
  });
});
