import { chatModeEnforcementForDriver, type ThreadCapabilityMode } from "@t3tools/contracts";

export const THREAD_MODE_CHOICES: ReadonlyArray<{
  readonly mode: ThreadCapabilityMode;
  readonly label: string;
  readonly description: string;
}> = [
  { mode: "code", label: "Code", description: "Read and edit files and run commands." },
  { mode: "chat", label: "Chat", description: "Talk and write documents. No files or commands." },
];

export function threadModeLabel(mode: ThreadCapabilityMode): string {
  return mode === "chat" ? "Chat" : "Code";
}

/** Null for a provider that keeps chat enforced, and when the provider is not known yet. */
export function chatModeNotice(driver: string | undefined): string | null {
  if (driver === undefined) return null;
  const enforcement = chatModeEnforcementForDriver(driver);
  if (enforcement === "enforced") return null;
  return enforcement === "best-effort"
    ? "This provider can act without asking, so Chat is best effort here."
    : "This provider can't run Chat conversations. Pick another model or use Code.";
}

export function threadModeSwitch(input: {
  readonly mode: ThreadCapabilityMode;
  readonly runActive: boolean;
}): {
  readonly target: ThreadCapabilityMode;
  readonly label: string;
  readonly blockedReason: string | null;
} {
  return {
    target: input.mode === "chat" ? "code" : "chat",
    label: input.mode === "chat" ? "Continue in Code mode" : "Switch to Chat",
    blockedReason: input.runActive ? "Stop the current run to change mode." : null,
  };
}
