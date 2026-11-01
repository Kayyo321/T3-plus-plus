import { useNavigation } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadCapabilityMode, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Keyboard, Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { chatModeNotice, threadModeLabel, threadModeSwitch } from "./threadChatMode";
import { partitionDocuments } from "./threadDocumentsPresentation";

function ModeRow(props: {
  readonly mode: ThreadCapabilityMode;
  readonly driver: string | undefined;
  readonly action: {
    readonly label: string;
    readonly blockedReason: string | null;
    readonly onPress: () => void;
  } | null;
  readonly documentCount: number;
  readonly onOpenDocuments: (() => void) | null;
}) {
  const notice = props.mode === "chat" ? chatModeNotice(props.driver) : null;
  const { action } = props;
  return (
    <View className="shrink-0 gap-1 px-4 pb-2">
      <View className="flex-row items-center gap-2">
        {props.mode === "chat" ? (
          <View className="flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1">
            <SymbolView name="bubble.left" size={12} tintColorClassName="accent-foreground-muted" />
            <Text className="text-xs text-foreground">{threadModeLabel(props.mode)}</Text>
          </View>
        ) : null}
        {props.onOpenDocuments && props.documentCount > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open documents, ${props.documentCount}`}
            onPress={props.onOpenDocuments}
            className="flex-row items-center gap-1.5 rounded-full bg-subtle px-2.5 py-1 active:opacity-70"
          >
            <SymbolView name="doc.text" size={12} tintColorClassName="accent-foreground-muted" />
            <Text className="text-xs text-foreground">Documents {props.documentCount}</Text>
          </Pressable>
        ) : null}
        <View className="flex-1" />
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.label}
            accessibilityHint={action.blockedReason ?? undefined}
            accessibilityState={{ disabled: action.blockedReason !== null }}
            onPress={action.onPress}
            hitSlop={6}
            className="active:opacity-70"
          >
            <Text
              className={cn(
                "font-t3-medium text-xs text-primary-text",
                action.blockedReason !== null && "opacity-50",
              )}
            >
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {notice ? <Text className="text-xs text-warning-foreground">{notice}</Text> : null}
    </View>
  );
}

/** A draft has no thread on the server yet, so its mode is a composer setting. */
export function DraftConversationBar(props: {
  readonly mode: ThreadCapabilityMode;
  readonly driver: string | undefined;
  readonly onChangeMode: (mode: ThreadCapabilityMode) => void;
}) {
  if (props.mode !== "chat") return null;
  const change = threadModeSwitch({ mode: props.mode, runActive: false });
  return (
    <ModeRow
      mode={props.mode}
      driver={props.driver}
      documentCount={0}
      onOpenDocuments={null}
      action={{
        label: change.label,
        blockedReason: null,
        onPress: () => props.onChangeMode(change.target),
      }}
    />
  );
}

/**
 * The conversation's mode and documents. Hidden for an ordinary Code conversation with no
 * documents; the thread settings sheet reaches the same controls there.
 */
export function ThreadConversationBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly mode: ThreadCapabilityMode;
  readonly driver: string | undefined;
  readonly runActive: boolean;
  readonly canOperate: boolean;
}) {
  const { environmentId, threadId, mode } = props;
  const navigation = useNavigation();
  const documents = useEnvironmentQuery(
    serverEnvironment.conversationDocumentsLive({ environmentId, input: { threadId } }),
  );
  const setMode = useAtomCommand(threadEnvironment.setCapabilityMode, { reportFailure: false });
  const [changing, setChanging] = useState(false);
  const documentCount = partitionDocuments(documents.data?.documents ?? []).active.length;
  if (mode !== "chat" && documentCount === 0) return null;

  const change = threadModeSwitch({ mode, runActive: props.runActive });
  const handleChange = async () => {
    if (change.blockedReason !== null) {
      Dialog.alert("Can't change mode yet", change.blockedReason);
      return;
    }
    setChanging(true);
    const result = await setMode({
      environmentId,
      input: { threadId, capabilityMode: change.target },
    });
    setChanging(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert("Could not change mode", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <ModeRow
      mode={mode}
      driver={props.driver}
      documentCount={documentCount}
      onOpenDocuments={() => {
        Keyboard.dismiss();
        navigation.navigate("ThreadDocuments", { environmentId, threadId });
      }}
      action={
        props.canOperate
          ? {
              label: changing ? "Changing…" : change.label,
              blockedReason: change.blockedReason,
              onPress: () => {
                if (!changing) void handleChange();
              },
            }
          : null
      }
    />
  );
}
