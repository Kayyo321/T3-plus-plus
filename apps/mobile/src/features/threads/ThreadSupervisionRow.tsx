import {
  type EnvironmentId,
  type ProjectId,
  resolveThreadSupervisionMode,
  type ServerSettings,
  SUPERVISION_MODE_INFO,
  SUPERVISION_MODES,
  type ThreadId,
} from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useEnvironmentQuery } from "../../state/query";
import { orchestratorEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export interface ThreadSupervisionTarget {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly settings: ServerSettings;
}

/** A project's mode is changed in its settings on web or desktop, so here it only reads. */
export function ThreadSupervisionRow(props: {
  readonly environmentId: EnvironmentId;
  readonly target: ThreadSupervisionTarget;
}) {
  const { environmentId } = props;
  const { threadId, projectId, settings } = props.target;
  const live = useEnvironmentQuery(orchestratorEnvironment.live({ environmentId, input: {} }));
  const setMode = useAtomCommand(orchestratorEnvironment.setThreadSupervision, {
    label: "change supervision",
  });
  if (live.data === null) return null;
  const { mode, source } = resolveThreadSupervisionMode(
    settings,
    projectId,
    live.data.supervisionThreadModes?.[threadId],
  );
  return (
    <>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        Supervision
      </Text>
      {source === "project" ? (
        <View className="mx-4 rounded-2xl bg-grouped-card px-4 py-3">
          <Text className="text-sm text-foreground">
            {SUPERVISION_MODE_INFO[mode].label}, managed by project
          </Text>
        </View>
      ) : (
        <View
          accessibilityRole="radiogroup"
          className="mx-4 flex-row gap-1 rounded-2xl bg-grouped-card p-1"
        >
          {SUPERVISION_MODES.map((candidate) => (
            <Pressable
              key={candidate}
              accessibilityRole="radio"
              accessibilityState={{ checked: candidate === mode }}
              className={cn(
                "flex-1 items-center rounded-xl py-2",
                candidate === mode && "bg-primary",
              )}
              onPress={() => void setMode({ environmentId, input: { threadId, mode: candidate } })}
            >
              <Text
                className={cn(
                  "text-sm font-t3-medium",
                  candidate === mode ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {SUPERVISION_MODE_INFO[candidate].label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </>
  );
}
