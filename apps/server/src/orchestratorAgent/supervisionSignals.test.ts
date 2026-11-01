import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SUPERVISION_THRESHOLDS,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  computeSignals,
  ownerIsPresent,
  trailingRepeats,
  supervisionEnabled,
} from "./supervisionSignals.ts";

it("supervises unattended work by default and honors explicit let-it-run choices", () => {
  assert.equal(supervisionEnabled(undefined, true), true);
  assert.equal(supervisionEnabled(undefined, false), false);
  assert.equal(supervisionEnabled({ mode: "off" }, true), false);
  assert.equal(supervisionEnabled({ mode: "on" }, false), true);
  assert.equal(supervisionEnabled({ mode: "on", automatic: true }, false), false);
});

const runId = RunId.make("run-1");
const now = DateTime.makeUnsafe("2026-11-01T12:00:00.000Z");
const minutesAgo = (minutes: number) => DateTime.subtract(now, { minutes });

const shell = (overrides: Partial<OrchestrationV2ThreadShell> = {}) =>
  ({
    activeRunId: runId,
    latestRunStartedAt: minutesAgo(1),
    updatedAt: minutesAgo(1),
    pendingRuntimeRequest: null,
    lastVisitedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

const command = (input: string) =>
  ({ type: "command_execution", runId, input }) as OrchestrationV2TurnItem;

const kinds = (
  thread: OrchestrationV2ThreadShell,
  items: ReadonlyArray<OrchestrationV2TurnItem> = [],
  attempts = 1,
) =>
  computeSignals({
    shell: thread,
    items,
    attempts,
    thresholds: DEFAULT_SUPERVISION_THRESHOLDS,
    now,
  }).map((signal) => signal.kind);

describe("trailingRepeats", () => {
  it.each([
    [[], 0],
    [["a"], 1],
    [["a", "b"], 1],
    [["b", "a", "a", "a"], 3],
    [["a", "b", "a", "b", "a", "b"], 3],
    [["c", "a", "b", "a", "b"], 2],
  ] as const)("counts %j as %i", (fingerprints, expected) => {
    assert.equal(trailingRepeats(fingerprints), expected);
  });
});

describe("computeSignals", () => {
  it("stays quiet for healthy work and idle threads", () => {
    assert.deepStrictEqual(kinds(shell()), []);
    assert.deepStrictEqual(kinds(shell({ activeRunId: null, updatedAt: minutesAgo(600) })), []);
  });

  it("fires on elapsed time and silence", () => {
    assert.deepStrictEqual(kinds(shell({ latestRunStartedAt: minutesAgo(46) })), ["long_running"]);
    assert.deepStrictEqual(kinds(shell({ updatedAt: minutesAgo(11) })), ["silent"]);
  });

  it("treats a long wait as waiting, not silence, unless the run keeps working past it", () => {
    const pendingRuntimeRequest = {
      kind: "command",
      createdAt: minutesAgo(31),
    } as OrchestrationV2ThreadShell["pendingRuntimeRequest"];
    assert.deepStrictEqual(kinds(shell({ pendingRuntimeRequest, updatedAt: minutesAgo(31) })), [
      "long_wait",
    ]);
    assert.deepStrictEqual(
      kinds(
        shell({
          pendingRuntimeRequest: { ...pendingRuntimeRequest!, blocking: false },
          updatedAt: minutesAgo(31),
        }),
      ),
      [],
    );
  });

  it("finds a repeated command and two steps undoing each other, in this run only", () => {
    const test = command("vp test run");
    assert.deepStrictEqual(kinds(shell(), [test, test, test, test]), ["loop"]);
    const flip = [command("git stash"), command("git stash pop")];
    assert.deepStrictEqual(kinds(shell(), [...flip, ...flip, ...flip, ...flip]), ["loop"]);
    const earlierRun = { ...test, runId: RunId.make("run-0") } as OrchestrationV2TurnItem;
    assert.deepStrictEqual(kinds(shell(), [earlierRun, earlierRun, earlierRun, earlierRun]), []);
  });

  it("counts retries of the same run", () => {
    assert.deepStrictEqual(kinds(shell(), [], 3), ["retries"]);
  });
});

describe("ownerIsPresent", () => {
  it("holds for two minutes after the owner last looked", () => {
    assert.isTrue(ownerIsPresent({ lastVisitedAt: minutesAgo(1) }, now));
    assert.isFalse(ownerIsPresent({ lastVisitedAt: minutesAgo(3) }, now));
    assert.isFalse(ownerIsPresent({ lastVisitedAt: null }, now));
  });
});
