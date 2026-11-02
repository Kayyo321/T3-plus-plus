import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { orchestratorEnvironment } from "../../state/orchestratorAgent";
import type { OrchestratorGlyphMotion } from "./OrchestratorGlyph";

export interface OrchestratorStatus {
  readonly label: string;
  readonly motion: OrchestratorGlyphMotion;
  readonly needsYou: boolean;
  readonly unread: boolean;
}

const LOADING: OrchestratorStatus = {
  label: "Connecting",
  motion: "still",
  needsYou: false,
  unread: false,
};

export function useOrchestratorStatus(environmentId: EnvironmentId): OrchestratorStatus {
  const result = useAtomValue(orchestratorEnvironment.live({ environmentId, input: {} }));
  if (result._tag !== "Success") return LOADING;
  const snapshot = result.value;
  const latest = snapshot.latestMessageAt ?? null;
  const readAt = snapshot.ownerReadAt ?? null;
  const unread = latest !== null && (readAt === null || latest > readAt);
  const waiting = snapshot.pendingApprovals.length;
  if (waiting > 0) {
    return {
      label: waiting === 1 ? "1 approval waiting" : `${waiting} approvals waiting`,
      motion: "working",
      needsYou: true,
      unread,
    };
  }
  if (snapshot.needsAttention) {
    return { label: "Needs you", motion: "working", needsYou: true, unread };
  }
  if (snapshot.brain === null)
    return { label: "Choose a model", motion: "still", needsYou: false, unread };
  if (snapshot.supervision.status === "paused") {
    return { label: "Supervision paused", motion: "still", needsYou: false, unread };
  }
  if (snapshot.supervisionReviewing != null) {
    return { label: "Reviewing a thread", motion: "working", needsYou: false, unread };
  }
  // Every running thread counts as watched by default, so watching alone must not repaint.
  const watching = snapshot.supervision.watching;
  if (watching > 0) {
    return {
      label: watching === 1 ? "Watching 1 thread" : `Watching ${watching} threads`,
      motion: "idle",
      needsYou: false,
      unread,
    };
  }
  return {
    label: unread ? "New message" : "Ready",
    motion: "idle",
    needsYou: false,
    unread,
  };
}
