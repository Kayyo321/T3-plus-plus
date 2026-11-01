import { ThreadId, type ComputerUseState, type ComputerUseStep } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerUseBannerModel,
  computerUseOffReason,
  computerUseStartModel,
  computerUseStepStatus,
  computerUseVirtualDisplayReason,
  mergeComputerUseSteps,
  olderComputerUseStepsCursor,
  type ComputerUsePermissions,
  type ComputerUseStartInput,
} from "./computerUse.logic";

const threadId = ThreadId.make("thread");

const ALLOWED: ComputerUsePermissions = {
  start: true,
  stop: true,
  takeOver: true,
  resume: true,
  answerApproval: true,
};
const READ_ONLY: ComputerUsePermissions = {
  start: false,
  stop: false,
  takeOver: false,
  resume: false,
  answerApproval: false,
};

const state = (overrides: Partial<ComputerUseState>): ComputerUseState => ({
  threadId,
  status: "active",
  target: "browser",
  startedAt: "2026-11-01T00:00:00.000Z",
  display: null,
  pendingApproval: null,
  ...overrides,
});

const approval = {
  id: "approval",
  action: "click",
  intent: "Press Buy now",
  sensitivity: "purchase",
  requestedAt: "2026-11-01T00:00:00.000Z",
} as const;

const step = (sequence: number): ComputerUseStep => ({
  id: `step:${sequence}`,
  threadId,
  sequence,
  at: "2026-11-01T00:00:00.000Z",
  target: "browser",
  action: "click",
  intent: "Press a button",
  sensitivity: null,
  status: "ok",
  result: "Done.",
  hasScreenshot: false,
});

const startInput = (overrides: Partial<ComputerUseStartInput> = {}): ComputerUseStartInput => ({
  settingEnabled: true,
  capabilityMode: "code",
  status: "off",
  canStart: true,
  driver: "claudeAgent",
  providerName: "Claude",
  virtualDisplay: { available: true, missing: [] },
  ...overrides,
});

describe("computerUseBannerModel", () => {
  it.each([
    ["no snapshot yet", null],
    ["off", state({ status: "off", target: null })],
  ])("shows nothing when %s", (_label, value) => {
    expect(computerUseBannerModel(value, ALLOWED, true)).toBeNull();
  });

  it.each([
    ["active", "active", "browser", "Computer use is on", "Built-in browser", "take-over"],
    [
      "taken over",
      "taken-over",
      "virtual-display",
      "You have control",
      "Virtual display. The agent is paused.",
      "hand-back",
    ],
  ] as const)("names the target while %s", (_label, status, target, title, detail, control) => {
    expect(computerUseBannerModel(state({ status, target }), ALLOWED, true)).toMatchObject({
      title,
      detail,
      control,
      canStop: true,
    });
  });

  it("shows a read-only viewer the indicator and the approval, with no control", () => {
    const model = computerUseBannerModel(state({ pendingApproval: approval }), READ_ONLY, true);
    expect(model).toMatchObject({ title: "Computer use is on", canStop: false, control: null });
    expect(model?.approval).toMatchObject({ canAnswer: false, intent: "Press Buy now" });
  });

  it("decides each control from its own permission", () => {
    const stopOnly = { ...READ_ONLY, stop: true };
    expect(computerUseBannerModel(state({}), stopOnly, true)).toMatchObject({
      canStop: true,
      control: null,
    });
    expect(
      computerUseBannerModel(
        state({ status: "taken-over" }),
        { ...READ_ONLY, takeOver: true },
        true,
      )?.control,
    ).toBeNull();
    expect(
      computerUseBannerModel(state({ status: "taken-over" }), { ...READ_ONLY, resume: true }, true)
        ?.control,
    ).toBe("hand-back");
  });

  it("describes a pending step by what it would do", () => {
    expect(
      computerUseBannerModel(state({ pendingApproval: approval }), ALLOWED, true)?.approval,
    ).toEqual({
      id: "approval",
      heading: "Makes a purchase: click",
      intent: "Press Buy now",
      canAnswer: true,
    });
  });

  it.each([
    ["browser", true, true],
    ["browser", false, false],
    ["virtual-display", true, false],
  ] as const)("reveals %s with preview %s: %s", (target, previewAvailable, expected) => {
    expect(
      computerUseBannerModel(state({ target }), ALLOWED, previewAvailable)?.revealsBrowser,
    ).toBe(expected);
  });
});

describe("computerUseStartModel", () => {
  it.each([
    ["the setting is off", { settingEnabled: false }],
    ["the conversation is in Chat mode", { capabilityMode: "chat" }],
    ["a session is running", { status: "active" }],
    ["this connection may not start it", { canStart: false }],
  ] as const)("is not offered when %s", (_label, overrides) => {
    expect(computerUseStartModel(startInput(overrides))).toBeNull();
  });

  it("treats a conversation with no recorded mode as Code", () => {
    expect(computerUseStartModel(startInput({ capabilityMode: undefined }))).not.toBeNull();
  });

  it("offers both targets on a supported provider", () => {
    expect(computerUseStartModel(startInput())).toEqual({
      providerSupported: true,
      providerNote: "Claude can use this through T3++ tools.",
      targets: [
        { target: "browser", label: "Built-in browser", disabledReason: null },
        { target: "virtual-display", label: "Virtual display", disabledReason: null },
      ],
    });
  });

  it("disables only the virtual display, with the missing programs, when it is unavailable", () => {
    const model = computerUseStartModel(
      startInput({ virtualDisplay: { available: false, missing: ["Xvfb", "xdotool"] } }),
    );
    expect(model?.targets.map((target) => target.disabledReason)).toEqual([
      null,
      "A virtual display needs Xvfb, xdotool on this machine.",
    ]);
  });

  it("does not offer the virtual display before the machine has answered", () => {
    const model = computerUseStartModel(startInput({ virtualDisplay: null }));
    expect(model?.targets[1]?.disabledReason).toBe("Checking this machine.");
  });

  it.each([
    ["an unsupported driver", "antigravity", "Antigravity"],
    ["an unknown provider", null, null],
  ])("says so plainly for %s and disables every target", (_label, driver, providerName) => {
    const note = `Computer use is not supported on ${providerName ?? "this provider"}.`;
    const model = computerUseStartModel(startInput({ driver, providerName }));
    expect(model).toMatchObject({ providerSupported: false, providerNote: note });
    expect(model?.targets.map((target) => target.disabledReason)).toEqual([note, note]);
  });
});

describe("computerUseOffReason", () => {
  it.each([
    [{ settingEnabled: false, capabilityMode: "chat", canStart: true }, "off in Settings"],
    [{ settingEnabled: true, capabilityMode: "chat", canStart: true }, "Chat mode"],
    [{ settingEnabled: true, capabilityMode: "code", canStart: false }, "watch"],
  ] as const)("explains %j", (input, expected) => {
    expect(computerUseOffReason(input)).toContain(expected);
  });
});

describe("computerUseVirtualDisplayReason", () => {
  it("still says something when no program is named", () => {
    expect(computerUseVirtualDisplayReason({ available: false, missing: [] })).toBe(
      "A virtual display is not available on this machine.",
    );
  });
});

describe("computerUseStepStatus", () => {
  it.each([
    ["ok", "Done", "success"],
    ["failed", "Failed", "error"],
    ["refused", "Refused", "warning"],
    ["denied", "Denied", "warning"],
  ] as const)("reads %s as %s", (status, label, tone) => {
    expect(computerUseStepStatus(status)).toEqual({ label, tone });
  });
});

describe("mergeComputerUseSteps", () => {
  it("returns the same list when nothing is new", () => {
    const known = [step(2), step(1)];
    expect(mergeComputerUseSteps(known, [step(1), step(2)])).toBe(known);
  });

  it("keeps steps that left the live window and orders newest first", () => {
    const known = [step(21), step(20)];
    const merged = mergeComputerUseSteps(mergeComputerUseSteps(known, [step(22)]), [step(5)]);
    expect(merged.map((entry) => entry.sequence)).toEqual([22, 21, 20, 5]);
  });
});

describe("olderComputerUseStepsCursor", () => {
  it.each([
    ["nothing loaded", [], null],
    ["the first step loaded", [step(2), step(1)], null],
    ["older steps left", [step(30), step(21)], 21],
  ])("with %s", (_label, steps, expected) => {
    expect(olderComputerUseStepsCursor(steps)).toBe(expected);
  });
});
