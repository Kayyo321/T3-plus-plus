import type {
  ComputerUseApproval,
  ComputerUseSensitivity,
  ComputerUseSnapshot,
  ComputerUseStep,
  ComputerUseTarget,
} from "@t3tools/contracts";

const TARGET_LABELS: Readonly<Record<ComputerUseTarget, string>> = {
  browser: "the built-in browser",
  "virtual-display": "a virtual display",
};

const APPROVAL_TITLES: Readonly<Record<ComputerUseSensitivity, string>> = {
  credentials: "Enter credentials",
  purchase: "Make a purchase",
  message: "Send a message",
  delete: "Delete something",
};

const ACTION_LABELS: Readonly<Record<ComputerUseStep["action"], string>> = {
  click: "Click",
  double_click: "Double click",
  type: "Type",
  key: "Press key",
  scroll: "Scroll",
  navigate: "Go to page",
  screenshot: "Screenshot",
};

const STEP_STATUS_LABELS: Readonly<Record<ComputerUseStep["status"], string>> = {
  ok: "Done",
  failed: "Failed",
  refused: "Refused",
  denied: "Denied",
};

export interface ComputerUseBannerModel {
  readonly headline: string;
  readonly detail: string | null;
  /** False for a viewer without the scope: they see the indicator and nothing to press. */
  readonly controls: boolean;
  readonly takenOver: boolean;
  readonly approval: ComputerUseApprovalModel | null;
}

export interface ComputerUseApprovalModel {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
}

function approvalModel(approval: ComputerUseApproval): ComputerUseApprovalModel {
  return {
    id: approval.id,
    title: APPROVAL_TITLES[approval.sensitivity],
    intent: approval.intent,
  };
}

/** Null when computer use is off, so nothing stays on screen for a finished session. */
export function computerUseBanner(
  snapshot: ComputerUseSnapshot | null,
  canControl: boolean,
): ComputerUseBannerModel | null {
  if (snapshot === null || snapshot.state.status === "off") return null;
  const { state } = snapshot;
  const target = state.target === null ? "the computer" : TARGET_LABELS[state.target];
  const takenOver = state.status === "taken-over";
  const viewOnly = canControl ? null : "View only on this connection.";
  return {
    headline: takenOver ? `You have control of ${target}` : `Agent is using ${target}`,
    detail: takenOver ? ["The agent is paused.", viewOnly].filter(Boolean).join(" ") : viewOnly,
    controls: canControl,
    takenOver,
    approval: state.pendingApproval === null ? null : approvalModel(state.pendingApproval),
  };
}

export function computerUseStepTitle(step: ComputerUseStep): string {
  return step.intent.trim() || ACTION_LABELS[step.action];
}

export function computerUseStepMeta(step: ComputerUseStep): string {
  return `${ACTION_LABELS[step.action]} · ${STEP_STATUS_LABELS[step.status]}`;
}

/** The next page starts below the oldest step already shown. */
export function olderStepsCursor(steps: ReadonlyArray<ComputerUseStep>): number | null {
  const sequences = steps.map((step) => step.sequence);
  return sequences.length === 0 ? null : Math.min(...sequences);
}
