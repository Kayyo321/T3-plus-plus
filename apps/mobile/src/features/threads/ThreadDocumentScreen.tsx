import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ConversationDocumentId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type DocumentEdit,
  documentConflictVersion,
  documentEditIsDirty,
  documentEditProblem,
  documentMeta,
  documentUpdateFields,
} from "./threadDocumentsPresentation";

export function ThreadDocumentScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly documentId: ConversationDocumentId;
}>) {
  const { environmentId, documentId } = route.params;
  const loaded = useEnvironmentQuery(
    serverEnvironment.conversationDocument({ environmentId, input: { id: documentId } }),
  );
  const canEdit = useAtomValue(
    serverEnvironment.updateConversationDocument.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateConversationDocument, {
    reportFailure: false,
  });
  const [edit, setEdit] = useState<DocumentEdit | null>(null);
  const document = loaded.data;
  if (document === null) {
    return (
      <Text className="pt-6 text-center text-sm text-foreground-muted">
        {loaded.error ?? "Loading document…"}
      </Text>
    );
  }
  const current: DocumentEdit = edit ?? {
    baseVersion: document.version,
    baseTitle: document.title,
    baseContent: document.content,
    title: document.title,
    content: document.content,
  };
  const problem = edit === null ? null : documentEditProblem(edit);
  const save = async () => {
    const result = await update({
      environmentId,
      input: {
        id: documentId,
        expectedVersion: current.baseVersion,
        ...documentUpdateFields(current),
      },
    });
    if (result._tag === "Success") {
      setEdit(null);
      loaded.refresh();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    const conflict = documentConflictVersion(failure);
    // Your text stays in the editor; only the base moves if you choose to keep it.
    if (conflict === null) return Dialog.alert("Could not save document", String(failure));
    Dialog.alert(
      "A newer version exists",
      `Version ${conflict} was saved while you edited. Reopen the document to see it, or save again to keep yours.`,
    );
    setEdit({ ...current, baseVersion: conflict });
  };
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="gap-3 px-5 py-3">
      <TextInput
        accessibilityLabel="Title"
        className="text-lg font-semibold text-foreground"
        editable={canEdit}
        value={current.title}
        onChangeText={(title) => setEdit({ ...current, title })}
      />
      <Text className="text-xs text-foreground-muted">{documentMeta(document)}</Text>
      <TextInput
        accessibilityLabel="Document"
        className="min-h-64 text-sm text-foreground"
        editable={canEdit}
        multiline
        textAlignVertical="top"
        value={current.content}
        onChangeText={(content) => setEdit({ ...current, content })}
      />
      {problem !== null ? <Text className="text-xs text-foreground-muted">{problem}</Text> : null}
      {canEdit && documentEditIsDirty(edit) ? (
        <View className="flex-row justify-end">
          <Button label="Save" disabled={problem !== null} onPress={save} />
        </View>
      ) : null}
    </ScrollView>
  );
}
