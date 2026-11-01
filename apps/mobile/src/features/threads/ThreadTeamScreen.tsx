import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import { TEAM_PHASES, type EnvironmentId, type TeamRun, type ThreadId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function TeamRunCard(props: {
  readonly run: TeamRun;
  readonly environmentId: EnvironmentId;
  readonly onChanged: () => void;
}) {
  const { run, environmentId } = props;
  const act = useAtomCommand(serverEnvironment.actTeamwork);
  const startMember = useAtomCommand(serverEnvironment.startTeamMember);
  const canAct = useAtomValue(serverEnvironment.actTeamwork.permissionAtom(environmentId));
  const open = run.status !== "stopped" && run.status !== "completed";
  return (
    <View className="gap-2 rounded-xl bg-card p-3">
      <Text className="text-sm font-medium text-foreground">{run.request}</Text>
      <Text className="text-xs text-foreground-muted">
        {`Phase ${TEAM_PHASES.indexOf(run.phase) + 1} of ${TEAM_PHASES.length} · ${run.status.replace("_", " ")}`}
      </Text>
      {run.members.map((member) => (
        <View key={member.id} className="flex-row items-center justify-between">
          <Text className="text-xs capitalize text-foreground">{member.role}</Text>
          {member.threadId === null && canAct && open ? (
            <Button
              label="Start"
              onPress={async () => {
                await startMember({
                  environmentId,
                  input: { runId: run.id, memberId: member.id, message: run.request },
                });
                props.onChanged();
              }}
            />
          ) : (
            <Text className="text-xs text-foreground-muted">
              {member.threadId === null ? "Not started" : "Started"}
            </Text>
          )}
        </View>
      ))}
      {run.report ? <Text className="text-xs text-foreground">{run.report.summary}</Text> : null}
      {canAct && open ? (
        <View className="flex-row justify-end gap-2">
          {run.status === "awaiting_owner" ? (
            <Button
              label="Approve"
              tone="primary"
              onPress={async () => {
                await act({
                  environmentId,
                  input: { runId: run.id, action: { type: "owner_approve" } },
                });
                props.onChanged();
              }}
            />
          ) : null}
          <Button
            label="Stop"
            tone="danger"
            onPress={async () => {
              await act({
                environmentId,
                input: {
                  runId: run.id,
                  action: { type: "owner_stop", reason: "Stopped by the owner" },
                },
              });
              props.onChanged();
            }}
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
  const runs = useEnvironmentQuery(
    serverEnvironment.teamworkList({ environmentId, input: { parentThreadId: threadId } }),
  );
  return (
    <ScrollView className="flex-1 bg-screen" contentContainerClassName="gap-3 px-5 py-3">
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
