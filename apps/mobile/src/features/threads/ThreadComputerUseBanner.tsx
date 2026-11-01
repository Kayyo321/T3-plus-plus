import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { computerUseBanner } from "./computerUsePresentation";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(title, String(squashAtomCommandFailure(result)));
  }
}

/**
 * Pinned above the composer for as long as an agent holds the screen, so the phone can always stop
 * it. A connection that drops keeps the last state rather than hiding a session that may still run.
 */
export function ThreadComputerUseBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly connected: boolean;
}) {
  const { environmentId, threadId } = props;
  const navigation = useNavigation();
  const live = useEnvironmentQuery(
    serverEnvironment.computerUseLive({ environmentId, input: { threadId } }),
  );
  const canControl = useAtomValue(serverEnvironment.stopComputerUse.permissionAtom(environmentId));
  const stop = useAtomCommand(serverEnvironment.stopComputerUse, { reportFailure: false });
  const takeOver = useAtomCommand(serverEnvironment.takeOverComputerUse, { reportFailure: false });
  const resume = useAtomCommand(serverEnvironment.resumeComputerUse, { reportFailure: false });
  const answer = useAtomCommand(serverEnvironment.answerComputerUseApproval, {
    reportFailure: false,
  });
  const [stopping, setStopping] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [answeringId, setAnsweringId] = useState<string | null>(null);

  const banner = computerUseBanner(live.data, canControl);
  const openSteps = () => {
    Keyboard.dismiss();
    navigation.navigate("ThreadComputerUse", { environmentId, threadId });
  };

  if (banner === null) {
    if (!live.data?.recentSteps.length) return null;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the computer use log"
        onPress={openSteps}
        className="flex-row items-center gap-2 px-4 pb-2 active:opacity-70"
      >
        <SymbolView name="doc.text" size={12} tintColorClassName="accent-foreground-muted" />
        <Text className="text-xs text-foreground-muted">Computer use log</Text>
      </Pressable>
    );
  }

  const handleStop = async () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setStopping(true);
    const result = await stop({ environmentId, input: { threadId } });
    setStopping(false);
    reportFailure("Could not stop computer use", result);
  };
  const handleSwitch = async () => {
    setSwitching(true);
    const input = { environmentId, input: { threadId } };
    const result = await (banner.takenOver ? resume(input) : takeOver(input));
    setSwitching(false);
    reportFailure(banner.takenOver ? "Could not hand back" : "Could not take over", result);
  };
  const handleAnswer = async (approvalId: string, approved: boolean) => {
    setAnsweringId(approvalId);
    const result = await answer({ environmentId, input: { threadId, approvalId, approved } });
    setAnsweringId(null);
    reportFailure("Could not answer", result);
  };

  return (
    <View className="shrink-0 gap-2 px-4 pb-3">
      <View className="gap-2.5 rounded-[20px] border border-warning-foreground bg-card-alt p-3.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${banner.headline}. Open the step log`}
          onPress={openSteps}
          className="flex-row items-center gap-2 active:opacity-70"
        >
          <SymbolView
            name="exclamationmark.triangle"
            size={15}
            tintColorClassName="accent-warning-foreground"
          />
          <View className="min-w-0 flex-1">
            <Text className="font-t3-bold text-sm text-foreground" numberOfLines={2}>
              {banner.headline}
            </Text>
            {banner.detail ? (
              <Text className="text-xs text-foreground-muted">{banner.detail}</Text>
            ) : null}
            {props.connected ? null : (
              <Text className="text-xs text-warning-foreground">
                Reconnecting. This may be out of date.
              </Text>
            )}
          </View>
          <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
        </Pressable>
        {banner.controls ? (
          <View className="flex-row flex-wrap gap-2">
            <Button
              label={stopping ? "Stopping…" : "Stop"}
              tone="danger"
              icon="stop.fill"
              disabled={stopping}
              onPress={() => void handleStop()}
            />
            <Button
              label={banner.takenOver ? "Hand back" : "Take over"}
              disabled={switching}
              onPress={() => void handleSwitch()}
            />
          </View>
        ) : null}
      </View>
      {banner.approval ? (
        <View className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4">
          <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
            Approval needed
          </Text>
          <Text className="font-t3-bold text-lg text-foreground">{banner.approval.title}</Text>
          <Text className="text-sm leading-normal text-foreground-secondary">
            {banner.approval.intent}
          </Text>
          {banner.controls ? (
            <View className="flex-row flex-wrap gap-2.5">
              <Button
                label="Approve"
                tone="primary"
                disabled={answeringId === banner.approval.id}
                onPress={() => void handleAnswer(banner.approval?.id ?? "", true)}
              />
              <Button
                label="Deny"
                tone="danger"
                disabled={answeringId === banner.approval.id}
                onPress={() => void handleAnswer(banner.approval?.id ?? "", false)}
              />
            </View>
          ) : (
            <Text className="text-xs text-foreground-muted">
              This connection cannot respond to approvals.
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
