import { orderBackgroundTasks } from "@t3tools/client-runtime/state/background-tasks";
import {
  type BackgroundTask,
  type EnvironmentId,
  isBackgroundTaskLive,
  type ThreadId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const EMPTY_TASKS: ReadonlyArray<BackgroundTask> = [];

const STATE_LABELS: Record<BackgroundTask["state"], string> = {
  running: "Running",
  needs_input: "Needs input",
  succeeded: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  lost: "Lost on restart",
};

/** What is running for this thread, from a phone. Starting a task stays on desktop and web. */
export function ThreadBackgroundTasks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.backgroundTasksLive({ environmentId: props.environmentId, input: {} }),
  );
  const stopTask = useAtomCommand(serverEnvironment.stopBackgroundTask, "background task stop");
  const tasks = orderBackgroundTasks(
    (query.data ?? EMPTY_TASKS).filter((task) => task.threadId === props.threadId),
  ).filter((task, index) => index < 3 || isBackgroundTaskLive(task.state));
  if (tasks.length === 0) return null;
  return (
    <View className="gap-1 px-4 pb-2">
      {tasks.map((task) => (
        <View key={task.id} className="flex-row items-center gap-2">
          <Text className="shrink text-xs font-medium" numberOfLines={1}>
            {task.name}
          </Text>
          <Text className="text-xs text-muted-foreground">{STATE_LABELS[task.state]}</Text>
          <Text className="flex-1 text-xs text-muted-foreground" numberOfLines={1}>
            {task.lastOutputLine ?? ""}
          </Text>
          {isBackgroundTaskLive(task.state) ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop ${task.name}`}
              onPress={() => {
                void stopTask({ environmentId: props.environmentId, input: { id: task.id } });
              }}
            >
              <Text className="text-xs text-destructive">Stop</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
