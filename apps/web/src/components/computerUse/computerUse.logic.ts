import {
  computerUseSupportForDriver,
  type ComputerUseApproval,
  type ComputerUseSensitivity,
  type ComputerUseState,
  type ComputerUseStep,
  type ComputerUseStepStatus,
  type ComputerUseSupportResult,
  type ComputerUseTarget,
} from "@t3tools/contracts";

export interface ComputerUsePermissions {
  readonly start: boolean;
  readonly stop: boolean;
  readonly takeOver: boolean;
  readonly resume: boolean;
  readonly answerApproval: boolean;
}

const COMPUTER_USE_TARGET_LABELS: Record<ComputerUseTarget, string> = {
  browser: "Built-in browser",
  "virtual-display": "Virtual display",
};

const ACTION_LABELS: Record<ComputerUseStep["action"], string> = {
  click: "Click",
  double_click: "Double-click",
  type: "Type",
  key: "Press key",
  scroll: "Scroll",
  navigate: "Go to page",
  screenshot: "Screenshot",
};

const SENSITIVITY_LABELS: Record<ComputerUseSensitivity, string> = {
  credentials: "Enters credentials",
  purchase: "Makes a purchase",
  message: "Sends a message",
  delete: "Deletes something",
};

export const computerUseActionLabel = (action: ComputerUseStep["action"]) => ACTION_LABELS[action];

export const computerUseSensitivityLabel = (sensitivity: ComputerUseSensitivity) =>
  SENSITIVITY_LABELS[sensitivity];

type ComputerUseStepTone = "success" | "error" | "warning";

/** Refused and denied steps never ran, so they read apart from a step that ran and failed. */
export function computerUseStepStatus(status: ComputerUseStepStatus): {
  readonly label: string;
  readonly tone: ComputerUseStepTone;
} {
  switch (status) {
    case "ok":
      return { label: "Done", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "refused":
      return { label: "Refused", tone: "warning" };
    case "denied":
      return { label: "Denied", tone: "warning" };
  }
}

export function computerUseVirtualDisplayReason(
  virtualDisplay: ComputerUseSupportResult["virtualDisplay"],
): string {
  return virtualDisplay.missing.length === 0
    ? "A virtual display is not available on this machine."
    : `A virtual display needs ${virtualDisplay.missing.join(", ")} on this machine.`;
}

export interface ComputerUseApprovalModel {
  readonly id: string;
  readonly heading: string;
  readonly intent: string;
  readonly canAnswer: boolean;
}

interface ComputerUseBannerModel {
  readonly title: string;
  readonly detail: string;
  readonly takenOver: boolean;
  readonly canStop: boolean;
  /** Which of Take over and Hand back to show. At most one is ever offered. */
  readonly control: "take-over" | "hand-back" | null;
  readonly revealsBrowser: boolean;
  readonly approval: ComputerUseApprovalModel | null;
}

const approvalModel = (
  approval: ComputerUseApproval | null,
  canAnswer: boolean,
): ComputerUseApprovalModel | null =>
  approval === null
    ? null
    : {
        id: approval.id,
        heading: `${computerUseSensitivityLabel(approval.sensitivity)}: ${computerUseActionLabel(approval.action).toLowerCase()}`,
        intent: approval.intent,
        canAnswer,
      };

/** Null while nothing is running: the banner shows only for a live session. */
export function computerUseBannerModel(
  state: ComputerUseState | null,
  permissions: ComputerUsePermissions,
  previewAvailable: boolean,
): ComputerUseBannerModel | null {
  if (state === null || state.status === "off" || state.target === null) return null;
  const takenOver = state.status === "taken-over";
  const targetLabel = COMPUTER_USE_TARGET_LABELS[state.target];
  const control = takenOver
    ? permissions.resume
      ? "hand-back"
      : null
    : permissions.takeOver
      ? "take-over"
      : null;
  return {
    title: takenOver ? "You have control" : "Computer use is on",
    detail: takenOver ? `${targetLabel}. The agent is paused.` : targetLabel,
    takenOver,
    canStop: permissions.stop,
    control,
    revealsBrowser: state.target === "browser" && previewAvailable,
    approval: approvalModel(state.pendingApproval, permissions.answerApproval),
  };
}

interface ComputerUseTargetOption {
  readonly target: ComputerUseTarget;
  readonly label: string;
  readonly disabledReason: string | null;
}

interface ComputerUseStartModel {
  readonly providerSupported: boolean;
  readonly providerNote: string;
  readonly targets: ReadonlyArray<ComputerUseTargetOption>;
}

export interface ComputerUseStartInput {
  readonly settingEnabled: boolean;
  readonly capabilityMode: "code" | "chat" | undefined;
  readonly status: ComputerUseState["status"];
  readonly canStart: boolean;
  readonly driver: string | null;
  readonly providerName: string | null;
  /** Null until the environment has answered. */
  readonly virtualDisplay: ComputerUseSupportResult["virtualDisplay"] | null;
}

/** Null when turning it on is not on offer here at all. */
export function computerUseStartModel(input: ComputerUseStartInput): ComputerUseStartModel | null {
  if (
    !input.settingEnabled ||
    input.capabilityMode === "chat" ||
    input.status !== "off" ||
    !input.canStart
  ) {
    return null;
  }
  const provider = input.providerName ?? "this provider";
  const supported = input.driver !== null && computerUseSupportForDriver(input.driver) !== null;
  const unsupported = `Computer use is not supported on ${provider}.`;
  const virtualDisplayReason =
    input.virtualDisplay === null
      ? "Checking this machine."
      : input.virtualDisplay.available
        ? null
        : computerUseVirtualDisplayReason(input.virtualDisplay);
  return {
    providerSupported: supported,
    providerNote: supported ? `${provider} can use this through T3++ tools.` : unsupported,
    targets: [
      {
        target: "browser",
        label: COMPUTER_USE_TARGET_LABELS.browser,
        disabledReason: supported ? null : unsupported,
      },
      {
        target: "virtual-display",
        label: COMPUTER_USE_TARGET_LABELS["virtual-display"],
        disabledReason: supported ? virtualDisplayReason : unsupported,
      },
    ],
  };
}

/** Why the step log has no way to turn it on, for a conversation where it is off. */
export function computerUseOffReason(input: {
  readonly settingEnabled: boolean;
  readonly capabilityMode: "code" | "chat" | undefined;
  readonly canStart: boolean;
}): string {
  if (!input.settingEnabled) return "Computer use is off in Settings, Labs.";
  if (input.capabilityMode === "chat") return "Computer use is not available in Chat mode.";
  if (!input.canStart) return "This connection can watch computer use but not turn it on.";
  return "Computer use is off for this conversation.";
}

/**
 * Steps never change once logged, so this only adds. Newest first. Returns `known` itself when
 * there is nothing new, which is what lets a render merge the live window without looping.
 */
export function mergeComputerUseSteps(
  known: ReadonlyArray<ComputerUseStep>,
  incoming: ReadonlyArray<ComputerUseStep>,
): ReadonlyArray<ComputerUseStep> {
  const ids = new Set(known.map((step) => step.id));
  const added = incoming.filter((step) => !ids.has(step.id));
  if (added.length === 0) return known;
  return [...known, ...added].toSorted((left, right) => right.sequence - left.sequence);
}

/** Sequences start at 1 and leave no holes, so the oldest one says if older steps exist. */
export function olderComputerUseStepsCursor(steps: ReadonlyArray<ComputerUseStep>): number | null {
  const oldest = steps.at(-1);
  return oldest !== undefined && oldest.sequence > 1 ? oldest.sequence : null;
}
