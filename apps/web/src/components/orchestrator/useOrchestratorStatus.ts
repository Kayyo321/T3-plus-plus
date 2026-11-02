import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { orchestratorEnvironment } from "../../state/orchestratorAgent";
import type { OrchestratorGlyphMotion } from "./OrchestratorGlyph";

export interface OrchestratorStatus {
  readonly label: string;
  readonly motion: OrchestratorGlyphMotion;
  readonly needsYou: boolean;
}

const LOADING: OrchestratorStatus = { label: "Connecting", motion: "still", needsYou: false };

export function useOrchestratorStatus(environmentId: EnvironmentId): OrchestratorStatus {
  const result = useAtomValue(orchestratorEnvironment.live({ environmentId, input: {} }));
  if (result._tag !== "Success") return LOADING;
  const snapshot = result.value;
  const waiting = snapshot.pendingApprovals.length;
  if (waiting > 0) {
    return {
      label: waiting === 1 ? "1 approval waiting" : `${waiting} approvals waiting`,
      motion: "working",
      needsYou: true,
    };
  }
  if (snapshot.needsAttention) {
    return { label: "Needs you", motion: "working", needsYou: true };
  }
  if (snapshot.brain === null) return { label: "Choose a model", motion: "still", needsYou: false };
  if (snapshot.supervision.status === "paused") {
    return { label: "Supervision paused", motion: "still", needsYou: false };
  }
  const watching = snapshot.supervision.watching;
  if (watching > 0) {
    return {
      label: watching === 1 ? "Watching 1 thread" : `Watching ${watching} threads`,
      motion: "working",
      needsYou: false,
    };
  }
  return { label: "Ready", motion: "idle", needsYou: false };
}
