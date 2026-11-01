import { LegendList } from "@legendapp/list/react-native";
import {
  applyGitGraphPage,
  gitGraphLaneCount,
  gitGraphOperationTitle,
  gitGraphRiskLabels,
  gitGraphRowKey,
  gitGraphTextRow,
  type GitGraphView,
} from "@t3tools/client-runtime/git-graph";
import type { GitGraphListInput, GitGraphRow } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidSheetHeader } from "../../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../../components/ui/AppText";
import { ListRow } from "../../../components/ui/ListRow";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { SheetHeader } from "../../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { gitGraphEnvironment } from "../../../state/vcs";
import { useAdaptiveWorkspaceLayout } from "../../layout/AdaptiveWorkspaceLayout";

const PAGE_ROWS = 60;
/** Phones show this many lanes; wider history folds into the overflow column. */
const MAX_VISIBLE_LANES = 6;
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

const LANE_COLORS = {
  light: ["#0284c7", "#7c3aed", "#059669", "#d97706", "#e11d48", "#0891b2", "#c026d3", "#4d7c0f"],
  dark: ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#e879f9", "#a3e635"],
} as const;

function GraphRow(props: {
  readonly row: GitGraphRow;
  readonly laneCount: number;
  readonly headSha: string | null;
  readonly colors: ReadonlyArray<string>;
  readonly expanded: boolean;
  readonly onPress: () => void;
}) {
  const { row, laneCount, headSha, colors, expanded, onPress } = props;
  const label = row.refs.map((ref) => ref.name).join(", ");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.kind === "checkpoint" ? "Checkpoint" : "Commit"}: ${row.subject}`}
      accessibilityState={{ expanded }}
      onPress={onPress}
      className="flex-row items-center gap-2 px-3 py-1"
    >
      <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 18 }}>
        {gitGraphTextRow(row, laneCount, headSha).map((run, index) => (
          <Text
            // oxlint-disable-next-line react/no-array-index-key -- lanes have no identity beyond their column.
            key={index}
            style={{
              fontFamily: MONO,
              color: run.color === null ? undefined : colors[run.color],
            }}
          >
            {run.text}
          </Text>
        ))}
      </Text>
      <View className="min-w-0 flex-1">
        <Text numberOfLines={1} className="text-sm text-foreground">
          {row.subject}
        </Text>
        {label.length > 0 ? (
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {label}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function CommitDetail(props: {
  readonly environmentId: Parameters<typeof gitGraphEnvironment.commitDetail>[0]["environmentId"];
  readonly cwd: string;
  readonly row: GitGraphRow;
}) {
  const { environmentId, cwd, row } = props;
  const detail = useEnvironmentQuery(
    row.kind === "checkpoint"
      ? null
      : gitGraphEnvironment.commitDetail({ environmentId, input: { cwd, sha: row.sha } }),
  ).data;
  const conversation = row.conversation ?? detail?.conversation ?? null;
  return (
    <View className="gap-1 px-4 pb-3">
      <Text className="text-xs text-foreground-muted">
        {row.sha.slice(0, 10)} · {row.authorName}
      </Text>
      {detail === null ? null : <Text className="text-sm text-foreground">{detail.message}</Text>}
      {conversation === null ? null : (
        <Text className="text-xs text-foreground-muted">
          {conversation.turn === null ? "From" : `Turn ${conversation.turn} of`}{" "}
          {conversation.title || "a conversation"}
        </Text>
      )}
      {detail?.risk
        ? gitGraphRiskLabels(detail.risk).map((label) => (
            <Text key={label} className="text-xs text-foreground-muted">
              {label}
            </Text>
          ))
        : null}
      {detail?.files.slice(0, 12).map((file) => (
        <Text
          key={file.path}
          numberOfLines={1}
          className="text-xs text-foreground-muted"
          style={{ fontFamily: MONO }}
        >
          {file.status} {file.path}
        </Text>
      ))}
    </View>
  );
}

/** A read-friendly history. Commits and PR status stay one tap away; surgery stays on desktop. */
export function GitGraphSheet(
  _props: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>,
) {
  const { layout } = useAdaptiveWorkspaceLayout();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { selectedThread } = useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const listMore = useAtomCommand(gitGraphEnvironment.listMore, { reportFailure: false });
  const [extended, setExtended] = useState<GitGraphView | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const environmentId = selectedThread?.environmentId ?? null;
  const cwd = selectedThreadCwd;
  const input: GitGraphListInput | null = cwd === null ? null : { cwd, limit: PAGE_ROWS };
  const page = useEnvironmentQuery(
    environmentId !== null && input !== null
      ? gitGraphEnvironment.page({ environmentId, input })
      : null,
  );
  const first = page.data;
  const view =
    first === null
      ? null
      : extended?.revision === first.revision
        ? extended
        : applyGitGraphPage(null, first, false);
  const rows = view?.rows ?? [];
  const summary = view?.summary ?? null;
  const operation = summary?.operation ?? null;
  const laneCount = Math.min(gitGraphLaneCount(rows), MAX_VISIBLE_LANES);

  const loadMore = async () => {
    if (view?.nextCursor == null || environmentId === null || input === null) return;
    const result = await listMore({
      environmentId,
      input: { ...input, cursor: view.nextCursor },
    });
    if (result._tag === "Success") setExtended(applyGitGraphPage(view, result.value, true));
  };

  const header = (
    <View className="gap-1 pb-1">
      {summary === null ? null : (
        <Text className="px-4 pt-2 text-xs text-foreground-muted">
          {summary.branch ?? "Detached HEAD"} · ↑{summary.ahead} ↓{summary.behind}
          {summary.changedFiles > 0 ? ` · ${summary.changedFiles} changed` : ""}
        </Text>
      )}
      {operation === null ? null : (
        <Text className="px-4 text-xs text-foreground-muted">
          {gitGraphOperationTitle(operation)}. Finish it on desktop.
        </Text>
      )}
      {environmentId === null || selectedThread === null || summary?.readOnlyReason ? null : (
        <ListRow
          icon="plus"
          label="Commit changes"
          description="Write or generate a message"
          disabled={(summary?.changedFiles ?? 0) === 0}
          onPress={() =>
            navigation.navigate("GitCommit", {
              environmentId: String(environmentId),
              threadId: String(selectedThread.id),
            })
          }
        />
      )}
    </View>
  );

  const content = (
    <View className="flex-1 android:bg-sheet-solid ios:bg-screen">
      {/* oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling. */}
      <LegendList
        data={rows}
        keyExtractor={gitGraphRowKey}
        extraData={{ expandedKey, laneCount }}
        renderItem={({ item }) => {
          const key = gitGraphRowKey(item);
          return (
            <View>
              <GraphRow
                row={item}
                laneCount={laneCount}
                headSha={summary?.headSha ?? null}
                colors={LANE_COLORS[scheme]}
                expanded={expandedKey === key}
                onPress={() => setExpandedKey(expandedKey === key ? null : key)}
              />
              {expandedKey === key && environmentId !== null && cwd !== null ? (
                <CommitDetail environmentId={environmentId} cwd={cwd} row={item} />
              ) : null}
            </View>
          );
        }}
        estimatedItemSize={36}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.5}
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <ScrollView>
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              {page.error ?? (page.isPending ? "Loading history" : "No commits yet.")}
            </Text>
          </ScrollView>
        }
      />
    </View>
  );

  if (Platform.OS === "ios") {
    return (
      <View collapsable={false} className="flex-1 bg-sheet">
        <SheetHeader presentation="native" title="History" onClose={() => navigation.goBack()} />
        {content}
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet-solid">
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <AndroidSheetHeader title="History" />
      <ScreenContent insetHorizontal={layout.usesSplitView}>{content}</ScreenContent>
    </View>
  );
}
