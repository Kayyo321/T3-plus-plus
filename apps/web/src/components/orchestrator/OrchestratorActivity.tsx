import { useAtomValue } from "@effect/atom-react";
import type { AuditEntry, EnvironmentId } from "@t3tools/contracts";

import { orchestratorEnvironment } from "../../state/orchestratorAgent";

const OUTCOME_GLYPH: Record<AuditEntry["outcome"], string> = {
  succeeded: "✓",
  failed: "✕",
  denied: "⊘",
  pending: "…",
};

/** The audit trail for what the orchestrator did, newest first. */
export default function OrchestratorActivity(props: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(
    orchestratorEnvironment.audit({
      environmentId: props.environmentId,
      input: { actor: "orchestrator", limit: 100 },
    }),
  );
  const entries = result._tag === "Success" ? result.value.entries : [];
  return (
    <ol className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2">
      {entries.length === 0 ? (
        <li className="p-4 text-center text-xs text-muted-foreground">
          What the orchestrator does shows here.
        </li>
      ) : null}
      {entries.map((entry) => (
        <li key={entry.id} className="flex gap-2 px-1 py-1 text-xs">
          <span aria-label={entry.outcome} className="font-mono text-muted-foreground">
            {OUTCOME_GLYPH[entry.outcome]}
          </span>
          <span className="min-w-0 flex-1">
            <span className="font-mono">{entry.action}</span>
            {entry.reasoning ? (
              <span className="block text-muted-foreground">{entry.reasoning}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
