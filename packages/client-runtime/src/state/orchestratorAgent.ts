import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createOrchestratorAgentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    live: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestrator:live",
      tag: WS_METHODS.orchestratorAgentSubscribe,
    }),
    directives: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:orchestrator:directives",
      tag: WS_METHODS.orchestratorAgentSubscribeDirectives,
    }),
    threadSupervision: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:supervision:thread",
      tag: WS_METHODS.supervisionGetThread,
    }),
    audit: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:audit:list",
      tag: WS_METHODS.auditList,
    }),
    checkAvailability: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:check-availability",
      tag: WS_METHODS.orchestratorAgentCheckAvailability,
    }),
    setBrain: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:set-brain",
      tag: WS_METHODS.orchestratorAgentSetBrain,
    }),
    setGrants: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:set-grants",
      tag: WS_METHODS.orchestratorAgentSetGrants,
    }),
    setThresholds: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:set-thresholds",
      tag: WS_METHODS.orchestratorAgentSetThresholds,
    }),
    send: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:send",
      tag: WS_METHODS.orchestratorAgentSend,
    }),
    interrupt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:interrupt",
      tag: WS_METHODS.orchestratorAgentInterrupt,
    }),
    answerApproval: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:answer-approval",
      tag: WS_METHODS.orchestratorAgentAnswerApproval,
    }),
    react: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:react",
      tag: WS_METHODS.orchestratorAgentReact,
    }),
    markRead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:orchestrator:mark-read",
      tag: WS_METHODS.orchestratorAgentMarkRead,
    }),
    setThreadSupervision: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:supervision:set-thread",
      tag: WS_METHODS.supervisionSetThread,
    }),
  };
}
