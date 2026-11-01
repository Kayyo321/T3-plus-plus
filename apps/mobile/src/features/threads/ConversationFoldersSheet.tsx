import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildConversationFolderRows,
  type ConversationFolderRow,
  conversationFolderChoices,
  emptyConversationFolderState,
} from "@t3tools/client-runtime/state/conversationFolders";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { StackActions } from "@react-navigation/native";
import type { ConversationFolderId, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

type FoldersSheetRequest =
  | { readonly mode: "browse"; readonly environmentId: EnvironmentId }
  | { readonly mode: "move"; readonly thread: EnvironmentThreadShell };

const foldersSheetAtom = Atom.make<FoldersSheetRequest | null>(null).pipe(Atom.keepAlive);

export const openConversationFolders = (environmentId: EnvironmentId) =>
  appAtomRegistry.set(foldersSheetAtom, { mode: "browse", environmentId });

export const moveThreadToFolder = (thread: EnvironmentThreadShell) =>
  appAtomRegistry.set(foldersSheetAtom, { mode: "move", thread });

const closeFoldersSheet = () => appAtomRegistry.set(foldersSheetAtom, null);

const ROW_CLASS = "flex-row items-center gap-2 rounded-lg px-5 py-3";

function useFolderState(environmentId: EnvironmentId) {
  const result = useAtomValue(
    serverEnvironment.conversationFoldersLive({ environmentId, input: {} }),
  );
  return AsyncResult.getOrElse(result, () => emptyConversationFolderState);
}

function SheetFrame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-screen">
          <SafeAreaView style={{ flex: 1 }}>
            <SheetHeader
              presentation="inline"
              title={props.title}
              onClose={props.onClose}
              accessibilityLabel={`Close ${props.title}`}
            />
            {props.children}
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function MoveToFolderSheet(props: { readonly thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const state = useFolderState(thread.environmentId);
  const mutate = useAtomCommand(serverEnvironment.mutateConversationFolders, {
    label: "conversation folder change",
  });
  const moveTo = (folderId: ConversationFolderId | null) => {
    closeFoldersSheet();
    void mutate({
      environmentId: thread.environmentId,
      input: { type: "move-threads", threadIds: [thread.id], folderId },
    });
  };
  const current = state.folderByThread.get(thread.id) ?? null;
  const choices: ReadonlyArray<{
    readonly id: ConversationFolderId | null;
    readonly path: string;
  }> = [...conversationFolderChoices(state), { id: null, path: "Unfiled" }];
  return (
    <SheetFrame title="Move to folder" onClose={closeFoldersSheet}>
      <FlatList
        data={choices}
        keyExtractor={(choice) => choice.id ?? "unfiled"}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: item.id === current }}
            className={ROW_CLASS}
            onPress={() => moveTo(item.id)}
          >
            <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
            <Text className="flex-1 text-base text-foreground">{item.path}</Text>
            {item.id === current ? (
              <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon-muted" />
            ) : null}
          </Pressable>
        )}
      />
    </SheetFrame>
  );
}

function BrowseFoldersSheet(props: { readonly environmentId: EnvironmentId }) {
  const state = useFolderState(props.environmentId);
  const shells = useAtomValue(environmentThreadShells.navigationThreadShellsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  // Evaluated once per open: a smart folder's "this week" need not tick while the sheet is up.
  const [nowMs] = useState(() => Date.now());
  const collapsed = AsyncResult.isSuccess(preferences)
    ? (preferences.value.conversationFolderCollapsedKeys ?? [])
    : [];
  const toggle = (key: string) =>
    savePreferences({
      transform: (current) => {
        const keys = current.conversationFolderCollapsedKeys ?? [];
        return {
          conversationFolderCollapsedKeys: keys.includes(key)
            ? keys.filter((candidate) => candidate !== key)
            : [...keys, key],
        };
      },
    });
  const rows = buildConversationFolderRows({
    state,
    threads: shells
      .filter((thread) => thread.environmentId === props.environmentId)
      .map((thread) => ({ ...thread, running: thread.runtime?.activeRunId != null })),
    isCollapsed: (key) => collapsed.includes(key),
    nowMs,
  });
  const open = (thread: EnvironmentThreadShell) => {
    closeFoldersSheet();
    if (rootNavigationRef.isReady()) {
      rootNavigationRef.dispatch(
        StackActions.push("Thread", {
          environmentId: String(thread.environmentId),
          threadId: String(thread.id),
        }),
      );
    }
  };
  const renderRow = (row: ConversationFolderRow<EnvironmentThreadShell>) => {
    if (row.kind === "thread") {
      return (
        <Pressable
          accessibilityRole="button"
          className={ROW_CLASS}
          style={{ paddingLeft: 20 + row.depth * 16 }}
          onPress={() => open(row.thread)}
          onLongPress={() => moveThreadToFolder(row.thread)}
        >
          <Text numberOfLines={1} className="flex-1 text-base text-foreground">
            {row.thread.title}
          </Text>
        </Pressable>
      );
    }
    const isFolder = row.kind === "folder";
    const key = isFolder ? row.folder.id : row.key;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed.includes(key) }}
        className={ROW_CLASS}
        style={{ paddingLeft: 20 + (isFolder ? row.depth : 0) * 16 }}
        onPress={() => toggle(key)}
      >
        <SymbolView
          name={collapsed.includes(key) ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-icon-muted"
        />
        <SymbolView name="folder" size={16} tintColorClassName="accent-icon-muted" />
        <Text numberOfLines={1} className="flex-1 text-base font-medium text-foreground">
          {isFolder ? row.folder.name : "Unfiled"}
        </Text>
        <Text className="text-sm text-foreground-muted">{row.count}</Text>
      </Pressable>
    );
  };
  return (
    <SheetFrame title="Folders" onClose={closeFoldersSheet}>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        initialNumToRender={24}
        windowSize={7}
        renderItem={({ item }) => renderRow(item)}
      />
    </SheetFrame>
  );
}

export function ConversationFoldersHost() {
  const request = useAtomValue(foldersSheetAtom);
  if (request === null) return null;
  return request.mode === "move" ? (
    <MoveToFolderSheet thread={request.thread} />
  ) : (
    <BrowseFoldersSheet environmentId={request.environmentId} />
  );
}
