import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const ideOpen = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:ide:open",
  tag: WS_METHODS.ideOpen,
});

export const ideSetTheme = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:ide:set-theme",
  tag: WS_METHODS.ideSetTheme,
});
