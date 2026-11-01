import { describe, expect, it } from "@effect/vitest";
import { type BackgroundTask, BackgroundTaskId, ThreadId } from "@t3tools/contracts";

import {
  applyBackgroundTaskItem,
  backgroundTaskTransitions,
  orderBackgroundTasks,
} from "./backgroundTasks.ts";

const task = (id: string, overrides: Partial<BackgroundTask> = {}): BackgroundTask => ({
  id: BackgroundTaskId.make(id),
  threadId: ThreadId.make("thread"),
  kind: "command",
  name: id,
  command: "true",
  cwd: "/work",
  childThreadId: null,
  state: "running",
  exitCode: null,
  lastOutputLine: null,
  resumeAgent: false,
  startedAt: "2026-11-01T00:00:00.000Z",
  endedAt: null,
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

describe("background task stream", () => {
  it("folds a snapshot and its deltas", () => {
    let tasks = applyBackgroundTaskItem([], { type: "snapshot", tasks: [task("a")] });
    tasks = applyBackgroundTaskItem(tasks, { type: "upsert", task: task("b") });
    tasks = applyBackgroundTaskItem(tasks, {
      type: "upsert",
      task: task("a", { lastOutputLine: "ready" }),
    });
    tasks = applyBackgroundTaskItem(tasks, { type: "remove", id: BackgroundTaskId.make("b") });
    expect(tasks.map(({ id, lastOutputLine }) => [id, lastOutputLine])).toEqual([["a", "ready"]]);
  });

  it("lists live work above what already ended", () => {
    const ordered = orderBackgroundTasks([
      task("done", { state: "failed", startedAt: "2026-11-01T02:00:00.000Z" }),
      task("live", { startedAt: "2026-11-01T01:00:00.000Z" }),
    ]);
    expect(ordered.map(({ id }) => id)).toEqual(["live", "done"]);
  });

  it("announces endings and requests for input, not a task it just learned about", () => {
    const before = [task("a"), task("b"), task("c", { state: "needs_input" })];
    const after = [
      task("a", { state: "succeeded" }),
      task("b", { state: "needs_input" }),
      task("c"),
      task("new", { state: "failed" }),
    ];
    expect(backgroundTaskTransitions(before, after).map(({ id }) => id)).toEqual(["a", "b"]);
  });
});
