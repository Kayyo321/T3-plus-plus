import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  REMOTE_CONTROL_LEVEL_INFO,
  type RemoteControlSwitch,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_CONFIG_ATOM = Atom.make(null);

function alertOnFailure(failureTitle: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
  }
}

function statusOf(remote: RemoteControlSwitch): string {
  const level = REMOTE_CONTROL_LEVEL_INFO[remote.accessLevel].label;
  const connected = remote.devices.filter((device) => device.connected);
  if (connected.length === 0) return `Remote control on, ${level}`;
  const names = connected.map((device) => device.label).join(", ");
  return `${names} connected, ${level}`;
}

/**
 * Owner status for remote control, above the composer, with the way to end it. The switch is
 * turned on from web or desktop, which show the link and answer pairing requests.
 */
export function ThreadRemoteControlBar(props: { readonly threadRef: ScopedThreadRef | null }) {
  const { threadRef } = props;
  const config = useAtomValue(
    threadRef === null
      ? NO_CONFIG_ATOM
      : serverEnvironment.configValueAtom(threadRef.environmentId),
  );
  // An older server has no such subscription to open.
  const remote = useEnvironmentQuery(
    threadRef === null || config?.environment.capabilities.remoteControl !== true
      ? null
      : serverEnvironment.remoteControlLive({
          environmentId: threadRef.environmentId,
          input: {},
        }),
  ).data?.switches.find((candidate) => candidate.threadId === threadRef?.threadId);
  const canOperate = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const disable = useAtomCommand(serverEnvironment.disableRemoteControl, "turn off remote control");
  const [busy, setBusy] = useState(false);
  if (threadRef === null || remote === undefined) return null;

  const turnOff = () =>
    Dialog.confirm({
      title: "Turn off remote control?",
      message: "Every device loses access at once and the link stops working.",
      confirmText: "Turn off",
      destructive: true,
      onConfirm: () => {
        if (busy) return;
        setBusy(true);
        void disable({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }).then((result) => {
          setBusy(false);
          alertOnFailure("Could not turn off remote control", result);
        });
      },
    });

  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="wifi" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        {statusOf(remote)}
      </Text>
      <Button label="Turn off" tone="text" disabled={busy || !canOperate} onPress={turnOff} />
    </View>
  );
}
