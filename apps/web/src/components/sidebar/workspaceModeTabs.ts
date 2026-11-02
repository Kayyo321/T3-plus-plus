import type { ThreadCapabilityMode } from "@t3tools/contracts";
import { CodeXmlIcon, type LucideIcon, MessageCircleIcon } from "lucide-react";

export const WORKSPACE_MODE_TABS: ReadonlyArray<{
  readonly mode: ThreadCapabilityMode;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { mode: "chat", label: "Chat", icon: MessageCircleIcon },
  { mode: "code", label: "Code", icon: CodeXmlIcon },
];
