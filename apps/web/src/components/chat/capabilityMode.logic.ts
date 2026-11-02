import {
  chatModeEnforcementForDriver,
  type ModelSelection,
  type ProviderInstanceId,
  type ThreadCapabilityMode,
} from "@t3tools/contracts";

const BEST_EFFORT_CHAT_WARNING = "can act without asking: T3++ refuses what it sees";

export type ChatModeNotice =
  | { readonly level: "none" }
  | { readonly level: "warning"; readonly message: string }
  | { readonly level: "blocked"; readonly message: string };

/** What to tell someone about to send to `driver`, labelled `providerName`, in `mode`. */
export function chatModeNotice(input: {
  readonly mode: ThreadCapabilityMode;
  readonly driver: string;
  readonly providerName: string;
}): ChatModeNotice {
  if (input.mode !== "chat") return { level: "none" };
  switch (chatModeEnforcementForDriver(input.driver)) {
    case "enforced":
      return { level: "none" };
    case "best-effort":
      return {
        level: "warning",
        message: `${input.providerName} ${BEST_EFFORT_CHAT_WARNING}.`,
      };
    case null:
      return {
        level: "blocked",
        message: `${input.providerName} cannot run Chat conversations. Pick another model or switch to Code.`,
      };
  }
}

/**
 * Why a send cannot start in `mode`, or null. Chat runs one model in the Scratch project, and the
 * models a person fans out to each need a worktree, so Chat refuses a multiple-model send.
 */
export function chatModeSendBlockReason(input: {
  readonly mode: ThreadCapabilityMode;
  readonly notice: ChatModeNotice;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
}): string | null {
  if (input.mode !== "chat") return null;
  if (input.multipleModelSelections !== null) {
    return "Chat conversations use one model. Pick one or switch to Code.";
  }
  return input.notice.level === "blocked" ? input.notice.message : null;
}

export interface ChatModeProviderEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: string;
  readonly displayName: string;
}

/** A model picker row's notice while in Chat mode; rows of one provider share one. */
export function chatModeNoticeForInstance(
  mode: ThreadCapabilityMode,
  entries: ReadonlyArray<ChatModeProviderEntry>,
  instanceId: ProviderInstanceId,
): ChatModeNotice {
  const entry = entries.find((candidate) => candidate.instanceId === instanceId);
  if (!entry) return { level: "none" };
  return chatModeNotice({ mode, driver: entry.driverKind, providerName: entry.displayName });
}

/** Blocks the rows Chat cannot use. Code keeps `disabledReason` itself, so nothing else re-renders. */
export function makeChatModelDisabledReason(
  mode: ThreadCapabilityMode,
  entries: ReadonlyArray<ChatModeProviderEntry>,
  disabledReason: (instanceId: ProviderInstanceId, model: string) => string | null,
) {
  if (mode !== "chat") return disabledReason;
  return (instanceId: ProviderInstanceId, model: string): string | null => {
    const notice = chatModeNoticeForInstance(mode, entries, instanceId);
    return notice.level === "blocked" ? notice.message : disabledReason(instanceId, model);
  };
}

/** The warning a usable provider's rows carry in Chat. Undefined in Code. */
export function makeChatModelNotice(
  mode: ThreadCapabilityMode,
  entries: ReadonlyArray<ChatModeProviderEntry>,
) {
  if (mode !== "chat") return undefined;
  return (instanceId: ProviderInstanceId): string | null => {
    const notice = chatModeNoticeForInstance(mode, entries, instanceId);
    return notice.level === "warning" ? notice.message : null;
  };
}

export interface CapabilityModeSwitch {
  readonly target: ThreadCapabilityMode;
  readonly label: "Continue in Code mode" | "Switch to Chat";
  readonly disabledReason: string | null;
}

/** The one mode change a started conversation offers, and why it cannot happen right now. */
export function capabilityModeSwitch(input: {
  readonly mode: ThreadCapabilityMode;
  readonly runActive: boolean;
  readonly canOperate: boolean;
}): CapabilityModeSwitch {
  const target = input.mode === "chat" ? "code" : "chat";
  return {
    target,
    label: target === "code" ? "Continue in Code mode" : "Switch to Chat",
    disabledReason: !input.canOperate
      ? "This connection cannot change conversations."
      : input.runActive
        ? "Stop the current run to change mode."
        : null,
  };
}
