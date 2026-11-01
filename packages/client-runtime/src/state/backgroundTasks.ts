import type { BackgroundTask, BackgroundTaskStreamItem } from "@t3tools/contracts";
import { isBackgroundTaskLive } from "@t3tools/contracts";

/** The stream sends one snapshot, then deltas; this folds them into the list to show. */
export function applyBackgroundTaskItem(
  tasks: ReadonlyArray<BackgroundTask>,
  item: BackgroundTaskStreamItem,
): ReadonlyArray<BackgroundTask> {
  switch (item.type) {
    case "snapshot":
      return item.tasks;
    case "remove":
      return tasks.filter((task) => task.id !== item.id);
    case "upsert":
      return tasks.some((task) => task.id === item.task.id)
        ? tasks.map((task) => (task.id === item.task.id ? item.task : task))
        : [item.task, ...tasks];
  }
}

/** Live work first, then the newest endings. */
export function orderBackgroundTasks(
  tasks: ReadonlyArray<BackgroundTask>,
): ReadonlyArray<BackgroundTask> {
  const rank = (task: BackgroundTask) => (isBackgroundTaskLive(task.state) ? 0 : 1);
  return [...tasks].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      right.startedAt.localeCompare(left.startedAt) ||
      left.id.localeCompare(right.id),
  );
}

/** Tasks that just ended or asked for input, for a notification. */
export function backgroundTaskTransitions(
  previous: ReadonlyArray<BackgroundTask>,
  next: ReadonlyArray<BackgroundTask>,
): ReadonlyArray<BackgroundTask> {
  const before = new Map(previous.map((task) => [task.id, task.state]));
  return next.filter((task) => {
    const state = before.get(task.id);
    return state !== undefined && state !== task.state && task.state !== "running";
  });
}
