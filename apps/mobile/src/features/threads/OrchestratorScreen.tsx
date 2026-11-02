import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { CommandId, type EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../lib/uuid";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { useEnvironmentQuery } from "../../state/query";
import { orchestratorEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** The brain is chosen on web or desktop; a blocked one disables sending, never falls back. */
export function OrchestratorScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return <OrchestratorBody environmentId={route.params.environmentId} />;
}

function OrchestratorBody({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const live = useEnvironmentQuery(orchestratorEnvironment.live({ environmentId, input: {} }));
  const send = useAtomCommand(orchestratorEnvironment.send);
  const answer = useAtomCommand(orchestratorEnvironment.answerApproval);
  const clearConversation = useAtomCommand(orchestratorEnvironment.clearConversation, {
    label: "clear the conversation",
  });
  const [text, setText] = useState("");
  const snapshot = live.data;
  if (snapshot === null) {
    return (
      <Text className="pt-6 text-center text-sm text-foreground-muted">
        {live.error ?? "Loading orchestrator…"}
      </Text>
    );
  }
  const { availability, threadId } = snapshot;
  const blockedReason =
    availability.status === "blocked"
      ? availability.message
      : availability.status === "unconfigured"
        ? "Choose the orchestrator's model on web or desktop first."
        : null;
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="gap-3 px-5 py-3">
      <Text className="text-xs text-foreground-muted">
        {snapshot.brain?.model ?? "No model chosen"}
      </Text>
      {blockedReason !== null ? (
        <Text className="text-sm text-foreground">{blockedReason}</Text>
      ) : null}
      {snapshot.pendingApprovals.map((approval) => (
        <View key={approval.id} className="gap-2 rounded-xl bg-card p-3">
          <Text className="text-sm text-foreground">{approval.summary}</Text>
          <View className="flex-row justify-end gap-2">
            <Button
              label="Deny"
              onPress={() => answer({ environmentId, input: { id: approval.id, allow: false } })}
            />
            <Button
              label="Allow"
              tone="primary"
              onPress={() => answer({ environmentId, input: { id: approval.id, allow: true } })}
            />
          </View>
        </View>
      ))}
      <TextInput
        accessibilityLabel="Message the orchestrator"
        className="min-h-20 rounded-xl bg-card p-3 text-sm text-foreground"
        editable={blockedReason === null}
        multiline
        placeholder="Ask the orchestrator"
        value={text}
        onChangeText={setText}
      />
      <View className="flex-row justify-end gap-2">
        {threadId !== null ? (
          <>
            <Button
              label="Clear conversation"
              onPress={() =>
                Alert.alert(
                  "Clear this conversation?",
                  "This permanently deletes it and stops anything the orchestrator is doing. Threads it started stay.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Clear",
                      style: "destructive",
                      onPress: () => void clearConversation({ environmentId, input: {} }),
                    },
                  ],
                )
              }
            />
            <Button
              label="Open conversation"
              onPress={() =>
                navigation.dispatch(StackActions.push("Thread", { environmentId, threadId }))
              }
            />
          </>
        ) : null}
        <Button
          label="Send"
          tone="primary"
          disabled={blockedReason !== null || text.trim().length === 0}
          onPress={async () => {
            const result = await send({
              environmentId,
              input: { commandId: CommandId.make(uuidv4()), text: text.trim() },
            });
            if (result._tag === "Success") setText("");
          }}
        />
      </View>
    </ScrollView>
  );
}

export function SettingsOrchestratorRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const environmentId = selectedTargets[0]?.environmentId;
  if (environmentId === undefined) {
    return (
      <Text className="pt-6 text-center text-sm text-foreground-muted">
        No environment connected.
      </Text>
    );
  }
  return <OrchestratorBody environmentId={environmentId} />;
}
