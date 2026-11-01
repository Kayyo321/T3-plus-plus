import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ConversationDocumentSummary,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { documentMeta, partitionDocuments } from "./threadDocumentsPresentation";

type DocumentsTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

function DocumentRow(props: {
  readonly document: ConversationDocumentSummary;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.document.title}`}
      onPress={props.onPress}
      className="flex-row items-center gap-3 border-b border-border py-3.5 active:opacity-70"
    >
      <SymbolView name="doc.text" size={16} tintColorClassName="accent-foreground-muted" />
      <View className="min-w-0 flex-1">
        <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
          {props.document.title}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {documentMeta(props.document)} · <RelativeTime timestamp={props.document.updatedAt} />
        </Text>
      </View>
      <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
    </Pressable>
  );
}

export function ThreadDocumentsScreen({ route }: StaticScreenProps<DocumentsTarget>) {
  const { environmentId, threadId } = route.params;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const live = useEnvironmentQuery(
    serverEnvironment.conversationDocumentsLive({ environmentId, input: { threadId } }),
  );
  const canEdit = useAtomValue(
    serverEnvironment.restoreConversationDocument.permissionAtom(environmentId),
  );
  const restore = useAtomCommand(serverEnvironment.restoreConversationDocument, {
    reportFailure: false,
  });
  const { active, deleted } = partitionDocuments(live.data?.documents ?? []);
  const handleRestore = async (document: ConversationDocumentSummary) => {
    const result = await restore({ environmentId, input: { id: document.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert("Could not restore document", String(squashAtomCommandFailure(result)));
    }
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerClassName="px-5 pt-2"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {live.data === null ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          {live.error ?? "Loading documents…"}
        </Text>
      ) : active.length === 0 && deleted.length === 0 ? (
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          No documents in this conversation yet.
        </Text>
      ) : (
        active.map((document) => (
          <DocumentRow
            key={document.id}
            document={document}
            onPress={() =>
              navigation.navigate("ThreadDocument", {
                environmentId,
                threadId,
                documentId: document.id,
              })
            }
          />
        ))
      )}
      {deleted.length > 0 ? (
        <View className="gap-1 pt-6">
          <Text className="text-sm font-t3-medium text-foreground-muted">Deleted</Text>
          {deleted.map((document) => (
            <View
              key={document.id}
              className="flex-row items-center gap-3 border-b border-border py-2"
            >
              <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={2}>
                {document.title}
              </Text>
              {canEdit ? (
                <Button
                  label="Restore"
                  tone="text"
                  onPress={() => void handleRestore(document)}
                />
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
