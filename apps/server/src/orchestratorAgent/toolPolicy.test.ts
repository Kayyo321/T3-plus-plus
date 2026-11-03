import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_ORCHESTRATOR_GRANTS,
  orchestratorBrainAvailability,
  type ProviderInstanceId,
  RunId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { grantDecision, ORCHESTRATOR_TOOL_POLICY, startedThreadsFrom } from "./toolPolicy.ts";

const policy = (name: string) => {
  const entry = ORCHESTRATOR_TOOL_POLICY[name];
  if (entry === undefined) throw new Error(`No policy for ${name}`);
  return entry;
};

describe("grantDecision", () => {
  it("runs reads, asks before leaving the machine or destroying data", () => {
    const grants = DEFAULT_ORCHESTRATOR_GRANTS;
    assert.equal(grantDecision(grants, policy("t3_thread_read")), "run");
    assert.equal(grantDecision(grants, policy("t3_thread_organize")), "run");
    assert.equal(grantDecision(grants, policy("t3_thread_transfer")), "ask");
    assert.equal(grantDecision(grants, policy("t3_project_delete")), "ask");
    assert.equal(grantDecision(grants, policy("t3_thread_delete")), "ask");
    assert.equal(grantDecision(grants, policy("orchestrator_react")), "run");
  });

  it("refuses reads when the domain is off", () => {
    const grants = {
      ...DEFAULT_ORCHESTRATOR_GRANTS,
      domains: { ...DEFAULT_ORCHESTRATOR_GRANTS.domains, conversations: "off" as const },
    };
    assert.equal(grantDecision(grants, policy("t3_thread_read")), "deny");
  });

  it("holds each supervision step to its own grant, whatever the domain allows", () => {
    const grants = DEFAULT_ORCHESTRATOR_GRANTS;
    assert.equal(grantDecision(grants, policy("t3_thread_send")), "run");
    assert.equal(grantDecision(grants, policy("t3_thread_interrupt")), "ask");
    assert.equal(grantDecision(grants, policy("task_cancel")), "ask");
    const noNudges = {
      ...grants,
      supervisionActions: { ...grants.supervisionActions, message: "off" as const },
    };
    assert.equal(grantDecision(noNudges, policy("t3_thread_send")), "deny");
  });

  it("never lists the tool that touches secrets", () => {
    assert.equal(ORCHESTRATOR_TOOL_POLICY["request_secret"], undefined);
  });
});

const ready = {
  instanceId: "claude" as ProviderInstanceId,
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "haiku", name: "Haiku" }],
} as unknown as ServerProvider;
const brain = { instanceId: "claude" as ProviderInstanceId, model: "haiku" };

describe("orchestratorBrainAvailability", () => {
  const reason = (provider: ServerProvider | undefined) => {
    const availability = orchestratorBrainAvailability(brain, provider ? [provider] : []);
    return availability.status === "blocked" ? availability.reason : availability.status;
  };

  it("names the exact reason and never picks another provider", () => {
    assert.equal(reason(ready), "available");
    assert.equal(reason(undefined), "provider_removed");
    assert.equal(reason({ ...ready, enabled: false }), "provider_disabled");
    assert.equal(reason({ ...ready, installed: false }), "not_installed");
    assert.equal(reason({ ...ready, availability: "unavailable" }), "unavailable");
    assert.equal(
      reason({ ...ready, auth: { status: "unauthenticated" } } as ServerProvider),
      "signed_out",
    );
    assert.equal(reason({ ...ready, status: "error" }), "provider_error");
    assert.equal(reason({ ...ready, models: [] }), "available");
    assert.equal(
      reason({ ...ready, models: [{ slug: "other", name: "Other" }] } as unknown as ServerProvider),
      "model_retired",
    );
    assert.equal(
      reason({
        ...ready,
        usageLimits: { checkedAt: "now", windows: [{ usedPercent: 100 }] },
      } as unknown as ServerProvider),
      "quota_exhausted",
    );
  });

  it("refuses a provider whose tools cannot be withheld", () => {
    assert.equal(
      reason({ ...ready, driver: "grok" } as unknown as ServerProvider),
      "cannot_enforce_tools",
    );
  });

  it("stays unconfigured until a model is chosen", () => {
    assert.equal(orchestratorBrainAvailability(null, [ready]).status, "unconfigured");
  });
});

describe("startedThreadsFrom", () => {
  const work = ThreadId.make("work");
  const run = RunId.make("run-1");
  it.each([
    [
      "a launch",
      "t3_thread_launch",
      {},
      { threadId: work, runId: run },
      [{ threadId: work, runId: run }],
    ],
    [
      "an idle launch",
      "t3_thread_launch",
      {},
      { threadId: work, runId: null },
      [{ threadId: work, runId: null }],
    ],
    [
      "each thread of create_threads",
      "create_threads",
      {},
      {
        threads: [
          { threadId: work, runId: run, status: "starting" },
          { threadId: ThreadId.make("b"), runId: null },
        ],
      },
      [
        { threadId: work, runId: run },
        { threadId: ThreadId.make("b"), runId: null },
      ],
    ],
    [
      "a delegate's child thread",
      "delegate_task",
      { task: "x" },
      { taskId: "node-1", childThreadId: work, childRunId: run },
      [{ threadId: work, runId: run }],
    ],
    [
      "a delegate that runs elsewhere",
      "delegate_task",
      {},
      { taskId: "node-1", childThreadId: null, childRunId: null },
      [],
    ],
    [
      "a send to a thread, named by its params",
      "t3_thread_send",
      { threadId: work, message: "hi" },
      { threadId: work, runId: run, messageId: "m" },
      [{ threadId: work, runId: run }],
    ],
    ["a send that returns no thread", "t3_thread_send", { threadId: work }, { error: "gone" }, []],
    [
      "a failed or unrelated tool",
      "t3_thread_read",
      { threadId: work },
      { threadId: work, runId: run },
      [],
    ],
    ["a launch with an unreadable result", "t3_thread_launch", {}, { runId: run }, []],
  ])("%s", (_name, tool, params, result, expected) => {
    assert.deepStrictEqual(startedThreadsFrom(tool, params, result), expected);
  });
});
