import { describe, expect, it } from "vite-plus/test";

import { chatModeNotice, threadModeSwitch } from "./threadChatMode";

describe("chatModeNotice", () => {
  it.each([
    ["claudeAgent", null],
    [undefined, null],
    ["grok", "This provider can act without asking, so Chat is best effort here."],
    ["cursor", "This provider can't run Chat conversations. Pick another model or use Code."],
  ])("for %s", (driver, notice) => {
    expect(chatModeNotice(driver)).toBe(notice);
  });
});

describe("threadModeSwitch", () => {
  it("offers the other mode and gives the reason it is blocked during a run", () => {
    expect(threadModeSwitch({ mode: "chat", runActive: false })).toEqual({
      target: "code",
      label: "Continue in Code mode",
      blockedReason: null,
    });
    expect(threadModeSwitch({ mode: "code", runActive: true })).toEqual({
      target: "chat",
      label: "Switch to Chat",
      blockedReason: "Stop the current run to change mode.",
    });
  });
});
