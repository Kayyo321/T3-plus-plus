import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  capabilityModeSwitch,
  chatModeNotice,
  chatModeNoticeForInstance,
  chatModeSendBlockReason,
} from "./capabilityMode.logic";

const notice = (driver: string) => chatModeNotice({ mode: "chat", driver, providerName: "Agent" });

describe("chatModeNotice", () => {
  it.each(["claudeAgent", "codex", "opencode"])(
    "says nothing for %s, which is enforced",
    (driver) => {
      expect(notice(driver)).toEqual({ level: "none" });
    },
  );

  it.each(["grok", "acpRegistry"])("warns for %s, which is best-effort", (driver) => {
    expect(notice(driver)).toEqual({
      level: "warning",
      message: "Agent can act without asking: T3++ refuses what it sees.",
    });
  });

  it.each(["cursor", "antigravity", "replay"])("blocks %s, which cannot run chat", (driver) => {
    expect(notice(driver)).toEqual({
      level: "blocked",
      message: "Agent cannot run Chat conversations. Pick another model or switch to Code.",
    });
  });

  it("says nothing in Code, whatever the driver", () => {
    expect(chatModeNotice({ mode: "code", driver: "cursor", providerName: "Cursor" })).toEqual({
      level: "none",
    });
  });
});

describe("chatModeSendBlockReason", () => {
  const blocked = notice("cursor");
  const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt" };

  it("blocks only a Chat send that cannot run", () => {
    expect(
      chatModeSendBlockReason({ mode: "chat", notice: blocked, multipleModelSelections: null }),
    ).toBe(blocked.level === "blocked" ? blocked.message : "");
    expect(
      chatModeSendBlockReason({
        mode: "chat",
        notice: notice("grok"),
        multipleModelSelections: null,
      }),
    ).toBeNull();
    expect(
      chatModeSendBlockReason({
        mode: "code",
        notice: blocked,
        multipleModelSelections: [selection, selection],
      }),
    ).toBeNull();
  });

  it("refuses a multiple-model send in Chat, even on an enforced provider", () => {
    expect(
      chatModeSendBlockReason({
        mode: "chat",
        notice: notice("codex"),
        multipleModelSelections: [selection, selection],
      }),
    ).toBe("Chat conversations use one model. Pick one or switch to Code.");
  });
});

describe("chatModeNoticeForInstance", () => {
  const entries = [
    {
      instanceId: ProviderInstanceId.make("work-cursor"),
      driverKind: "cursor",
      displayName: "Work Cursor",
    },
  ];

  it("names the instance by its display name and tolerates an unknown one", () => {
    expect(
      chatModeNoticeForInstance("chat", entries, ProviderInstanceId.make("work-cursor")),
    ).toEqual({
      level: "blocked",
      message: "Work Cursor cannot run Chat conversations. Pick another model or switch to Code.",
    });
    expect(chatModeNoticeForInstance("chat", entries, ProviderInstanceId.make("gone"))).toEqual({
      level: "none",
    });
  });
});

describe("capabilityModeSwitch", () => {
  it("offers the way out of each mode", () => {
    expect(capabilityModeSwitch({ mode: "chat", runActive: false, canOperate: true })).toEqual({
      target: "code",
      label: "Continue in Code mode",
      disabledReason: null,
    });
    expect(capabilityModeSwitch({ mode: "code", runActive: false, canOperate: true })).toEqual({
      target: "chat",
      label: "Switch to Chat",
      disabledReason: null,
    });
  });

  it("explains a refusal in both directions, and names missing permission first", () => {
    for (const mode of ["chat", "code"] as const) {
      expect(capabilityModeSwitch({ mode, runActive: true, canOperate: true }).disabledReason).toBe(
        "Stop the current run to change mode.",
      );
      expect(
        capabilityModeSwitch({ mode, runActive: true, canOperate: false }).disabledReason,
      ).toBe("This connection cannot change conversations.");
    }
  });
});
