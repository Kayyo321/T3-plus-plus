import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestratorUiDirective, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import { applyUiDirective, type UiDirective } from "../../layouts/uiDirectives";
import { useQuietThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { orchestratorEnvironment, useOrchestratorDock } from "../../state/orchestratorAgent";
import { toastManager } from "../ui/toast";
import OrchestratorPanel from "./OrchestratorPanel";

const uiDirectiveFor = (
  request: Exclude<
    OrchestratorUiDirective,
    { readonly type: "escalate" | "open-settings" | "open-thread" }
  >,
  environmentId: EnvironmentId,
): UiDirective => {
  switch (request.type) {
    case "open-panel":
      return { type: "panel.open", panel: request.panel };
    case "close-panel":
      return { type: "panel.close", panel: request.panel };
    case "apply-layout":
      return { type: "layout.apply", layout: request.name };
    case "split-thread":
      return { type: "split.open", environmentId, threadId: request.threadId };
  }
};

/** Runs the requests the orchestrator sends to the owner's clients. */
function DirectiveListener(props: { readonly environmentId: EnvironmentId }) {
  const navigate = useNavigate();
  const result = useAtomValue(
    orchestratorEnvironment.directives({ environmentId: props.environmentId, input: {} }),
  );
  const directive = result._tag === "Success" ? result.value : null;
  const run = useEffectEvent((request: OrchestratorUiDirective) => {
    switch (request.type) {
      case "escalate":
        toastManager.add({ type: "warning", title: "Needs you", description: request.message });
        return;
      case "open-thread":
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: props.environmentId, threadId: request.threadId },
        });
        return;
      case "open-settings":
        void navigate({
          to: request.page === undefined ? "/settings" : `/settings/${request.page}`,
        });
        return;
    }
    const result = applyUiDirective(uiDirectiveFor(request, props.environmentId));
    if (!result.ok) {
      toastManager.add({
        type: "warning",
        title: "The orchestrator could not do that",
        description: result.reason,
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a server stream asks this client to act once per directive
  useEffect(() => {
    if (directive !== null) run(directive);
  }, [directive]);
  return null;
}

export function OrchestratorDock(props: { readonly threadRef: ScopedThreadRef | null }) {
  const open = useOrchestratorDock((state) => state.open);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.threadRef?.environmentId ?? primaryEnvironmentId;
  const shell = useQuietThreadShell(props.threadRef);
  if (environmentId === null) return null;
  const focus =
    shell === null
      ? undefined
      : {
          threadId: shell.id,
          projectId: shell.projectId,
          ...(shell.branch === null ? {} : { branch: shell.branch }),
        };
  return (
    <>
      <DirectiveListener environmentId={environmentId} />
      {open ? <OrchestratorPanel environmentId={environmentId} focus={focus} /> : null}
    </>
  );
}
