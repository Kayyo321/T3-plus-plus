import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import type {
  EnvironmentId,
  TeamAction,
  TeamRun,
  TeamRunStatus,
  ThreadId,
} from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const STOPPABLE_STATUSES: ReadonlyArray<TeamRunStatus> = [
  "running",
  "awaiting_owner",
  "blocked",
  "over_budget",
];

function TeamRunCard(props: {
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly onChanged: () => void;
}) {
  const { run, environmentId, onChanged } = props;
  const act = useAtomCommand(serverEnvironment.actTeamwork);
  const canAct = useAtomValue(serverEnvironment.actTeamwork.permissionAtom(environmentId));
  const activeNode =
    run.activeNodeId === null
      ? undefined
      : run.flow.nodes.find((node) => node.id === run.activeNodeId);
  const status = run.status.replace("_", " ");
  const pendingGrowth = run.growth.filter((request) => request.status === "awaiting_owner");
  const refusedGrowth = run.growth.filter(
    (request) =>
      (request.status === "denied" || request.status === "refused") && request.reason !== null,
  );
  const send = async (action: TeamAction) => {
    await act({ environmentId, input: { runId: run.id, action } });
    onChanged();
  };
  return (
    <View className="gap-2 rounded-xl bg-card p-3">
      <Text className="text-sm font-medium text-foreground">{run.request}</Text>
      <Text className="text-xs text-foreground-muted">
        {activeNode ? `${status} · ${activeNode.name}` : status}
      </Text>
      {run.members.map((member) => (
        <View key={member.id} className="gap-0.5">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs text-foreground">{member.name}</Text>
            <Text className="text-xs capitalize text-foreground-muted">{member.state}</Text>
          </View>
          {member.state === "blocked" && member.detail ? (
            <Text className="text-xs text-warning-foreground">{member.detail}</Text>
          ) : null}
        </View>
      ))}
      {run.report ? <Text className="text-xs text-foreground">{run.report.summary}</Text> : null}
      {pendingGrowth.map((request) => (
        <View key={request.id} className="gap-1 rounded-lg bg-subtle p-2">
          <Text className="text-xs font-medium text-foreground">{`Capacity: ${request.capacity}`}</Text>
          <Text className="text-xs text-foreground-muted">{`Why: ${request.why}`}</Text>
          {canAct ? (
            <View className="flex-row justify-end gap-2">
              <Button
                label="Deny"
                tone="danger"
                onPress={() =>
                  send({ type: "owner_growth_answer", requestId: request.id, allow: false })
                }
              />
              <Button
                label="Allow"
                tone="primary"
                onPress={() =>
                  send({ type: "owner_growth_answer", requestId: request.id, allow: true })
                }
              />
            </View>
          ) : null}
        </View>
      ))}
      {refusedGrowth.map((request) => (
        <Text key={request.id} className="text-xs text-foreground-muted">
          {`${request.capacity}: ${request.reason}`}
        </Text>
      ))}
      {canAct && STOPPABLE_STATUSES.includes(run.status) ? (
        <View className="flex-row justify-end gap-2">
          <Button
            label="Stop"
            tone="danger"
            onPress={() => send({ type: "owner_stop", reason: "Stopped by the owner" })}
          />
        </View>
      ) : null}
    </View>
  );
}

export function ThreadTeamScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }>) {
  const { environmentId, threadId } = route.params;
  const sheet = useEnvironmentQuery(
    serverEnvironment.threadTeamSheet({ environmentId, input: { threadId } }),
  );
  const runs = useEnvironmentQuery(
    serverEnvironment.teamworkList({ environmentId, input: { parentThreadId: threadId } }),
  );
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="gap-3 px-5 py-3">
      {sheet.data === null ? (
        <Text className="text-sm text-foreground-muted">{sheet.error ?? "Loading sheet…"}</Text>
      ) : (
        <Text className="text-sm font-medium text-foreground">
          {sheet.data.sheetName ?? "Teamwork off"}
        </Text>
      )}
      {runs.data === null ? (
        <Text className="text-sm text-foreground-muted">{runs.error ?? "Loading teams…"}</Text>
      ) : (
        runs.data.runs.map((run) => (
          <TeamRunCard
            key={run.id}
            run={run}
            environmentId={environmentId}
            onChanged={runs.refresh}
          />
        ))
      )}
    </ScrollView>
  );
}
