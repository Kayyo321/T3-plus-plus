import type { ComputerUseSnapshot, ComputerUseStep } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computerUseBanner, computerUseStepTitle, olderStepsCursor } from "./computerUsePresentation";

const threadId = ThreadId.make("thread-1");

function snapshot(state: Partial<ComputerUseSnapshot["state"]>): ComputerUseSnapshot {
  return {
    state: {
      threadId,
      status: "active",
      target: "browser",
      startedAt: "2026-11-01T10:00:00.000Z",
      display: null,
      pendingApproval: null,
      ...state,
    },
    recentSteps: [],
  };
}

function step(input: Partial<ComputerUseStep>): ComputerUseStep {
  return {
    id: "step-1",
    threadId,
    sequence: 1,
    at: "2026-11-01T10:00:00.000Z",
    target: "browser",
    action: "click",
    intent: "Open settings",
    sensitivity: null,
    status: "ok",
    result: null,
    hasScreenshot: false,
    ...input,
  };
}

describe("computerUseBanner", () => {
  it("shows nothing until a session is live", () => {
    expect(computerUseBanner(null, true)).toBeNull();
    expect(computerUseBanner(snapshot({ status: "off" }), true)).toBeNull();
  });

  it("names the target while active and when taken over", () => {
    expect(computerUseBanner(snapshot({}), true)).toMatchObject({
      headline: "Agent is using the built-in browser",
      takenOver: false,
    });
    expect(
      computerUseBanner(snapshot({ status: "taken-over", target: "virtual-display" }), true),
    ).toMatchObject({
      headline: "You have control of a virtual display",
      detail: "The agent is paused.",
      takenOver: true,
    });
  });

  it("keeps the indicator and approval text but no controls for a viewer", () => {
    const banner = computerUseBanner(
      snapshot({
        pendingApproval: {
          id: "approval-1",
          action: "click",
          intent: "Buy the plan",
          sensitivity: "purchase",
          requestedAt: "2026-11-01T10:00:00.000Z",
        },
      }),
      false,
    );
    expect(banner).toMatchObject({
      controls: false,
      detail: "View only on this connection.",
      approval: { id: "approval-1", title: "Make a purchase", intent: "Buy the plan" },
    });
  });
});

describe("computer use steps", () => {
  it("falls back to the action when a step has no readable intent", () => {
    expect(computerUseStepTitle(step({ intent: "  ", action: "screenshot" }))).toBe("Screenshot");
  });

  it("pages below the oldest step shown", () => {
    expect(olderStepsCursor([])).toBeNull();
    expect(olderStepsCursor([step({ sequence: 9 }), step({ sequence: 4 })])).toBe(4);
  });
});
