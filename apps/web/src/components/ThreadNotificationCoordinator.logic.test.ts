import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNotificationGate,
  observeScheduledRuns,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import {
  ScheduledTaskId,
  ScheduledTaskRunId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskRun,
} from "@t3tools/contracts";

describe("observeScheduledRuns", () => {
  const taskId = ScheduledTaskId.make("task");
  const run = (id: string, outcome: string, finished = true): ScheduledTaskRun => ({
    id: ScheduledTaskRunId.make(id),
    taskId,
    trigger: "scheduled",
    scheduledFor: null,
    startedAt: "2026-11-01T09:00:00.000Z",
    finishedAt: finished ? "2026-11-01T09:05:00.000Z" : null,
    outcome,
    threadId: null,
    iteration: 0,
    summary: null,
    error: null,
    toolCalls: 0,
    costUsd: null,
  });
  const task = (latestRun?: ScheduledTaskRun, overrides: Partial<ScheduledTask> = {}) =>
    ({
      id: taskId,
      threadId: null,
      ...(latestRun === undefined ? {} : { latestRun }),
      ...overrides,
    }) as ScheduledTask;
  const announced = (seen: Map<ScheduledTaskId, string | null>, value: ScheduledTask) =>
    observeScheduledRuns(seen, [value]).length === 1;

  it("never announces the first sighting, even of a finished run", () => {
    expect(announced(new Map(), task(run("run-1", "failed")))).toBe(false);
  });

  it("announces each new state of a run once", () => {
    const seen = new Map();
    expect(announced(seen, task())).toBe(false);
    expect(announced(seen, task(run("run-1", "running", false)))).toBe(false);
    expect(announced(seen, task(run("run-1", "needs_input", false)))).toBe(true);
    expect(announced(seen, task(run("run-1", "needs_input", false)))).toBe(false);
    expect(announced(seen, task(run("run-1", "succeeded")))).toBe(true);
    expect(announced(seen, task(run("run-1", "succeeded")))).toBe(false);
    expect(announced(seen, task(run("run-2", "succeeded")))).toBe(true);
  });

  it("honors the task's notify policy", () => {
    const seen = new Map();
    const quiet = { policy: { notify: "failures" as const } };
    announced(seen, task(run("run-1", "running", false), quiet));
    expect(announced(seen, task(run("run-1", "succeeded"), quiet))).toBe(false);
    expect(announced(seen, task(run("run-2", "failed"), quiet))).toBe(true);
  });

  it("leaves a task that posts into a conversation to the thread notifier", () => {
    const seen = new Map();
    const bound = { threadId: ThreadId.make("thread") };
    announced(seen, task(run("run-1", "running", false), bound));
    expect(announced(seen, task(run("run-1", "succeeded"), bound))).toBe(false);
  });

  it("forgets deleted tasks, so one that returns counts as a first sighting", () => {
    const seen = new Map();
    announced(seen, task(run("run-1", "running", false)));
    observeScheduledRuns(seen, []);
    expect(announced(seen, task(run("run-1", "failed")))).toBe(false);
  });
});

const working: ThreadNotificationObservation = {
  attention: null,
  settled: false,
  completedAt: null,
};
const completed = (at: number): ThreadNotificationObservation => ({
  attention: null,
  settled: true,
  completedAt: at,
});
const visible = { archived: false, quiet: false };

function harness() {
  const notify = vi.fn();
  const gate = createThreadNotificationGate<string>(notify);
  let prior: ThreadNotificationObservation | undefined;
  const observe = (next: ThreadNotificationObservation, options = visible) => {
    gate.observe("thread", prior, next, options);
    prior = next;
  };
  return { gate, notify, observe };
}

describe("createThreadNotificationGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a completion when the thread resumes within the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    observe(working);
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });

  it("notifies a real completion once after the grace", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS - 1);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies attention at once and replaces a pending completion", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
    vi.advanceTimersByTime(60_000);
    // The request resolves and the same run reads as completed again.
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("notifies one completion across continuation gaps", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(2));
    vi.advanceTimersByTime(300);
    observe(working);
    vi.advanceTimersByTime(5_000);
    observe(completed(3));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("keeps a completion interrupted by attention after a working gap from firing", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe({ attention: "run-1:approval", settled: false, completedAt: null });
    vi.advanceTimersByTime(60_000);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([["thread", "input"]]);
  });

  it("adds nothing when attention follows a completion that already fired", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    observe({ attention: "run-1:limited", settled: false, completedAt: null });
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify.mock.calls).toEqual([
      ["thread", "completion"],
      ["thread", "input"],
    ]);
  });

  it("still notifies a newer completion after attention", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe({ attention: "run-2:approval", settled: false, completedAt: null });
    observe(working);
    observe(completed(2));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([
      ["thread", "input"],
      ["thread", "completion"],
    ]);
  });

  it("ignores unrelated updates while a completion waits", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe({ ...completed(1) });
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("notifies a run that settles again after a brief runtime blip", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(500);
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS);
    expect(notify.mock.calls).toEqual([["thread", "completion"]]);
  });

  it("restarts the grace when a newer completion replaces a pending one", () => {
    const { notify, observe } = harness();
    observe(working);
    observe(completed(1));
    vi.advanceTimersByTime(1_500);
    observe(completed(2));
    vi.advanceTimersByTime(1_500);
    expect(notify).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drops a pending completion on archive, stop request, removal or clear", () => {
    for (const end of [
      (h: ReturnType<typeof harness>) => h.observe(completed(1), { ...visible, archived: true }),
      (h: ReturnType<typeof harness>) =>
        h.observe({ ...completed(1) }, { ...visible, quiet: true }),
      (h: ReturnType<typeof harness>) => h.gate.retain(new Set()),
      (h: ReturnType<typeof harness>) => h.gate.clear(),
    ]) {
      const h = harness();
      h.observe(working);
      h.observe(completed(1));
      end(h);
      vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  });

  it("never notifies a stopped run or the first observation", () => {
    const { notify, observe } = harness();
    observe(completed(1));
    observe(working);
    observe(completed(2), { ...visible, quiet: true });
    vi.advanceTimersByTime(WORKING_EXIT_GRACE_MS * 2);
    expect(notify).not.toHaveBeenCalled();
  });
});
