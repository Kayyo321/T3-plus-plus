import type { OrchestrationV2ProjectedTurnItem, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { orchestratorFeed } from "./orchestratorChat.logic";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 1, 15, minute));
const run = (id: string) => id as RunId;

const item = (fields: Record<string, unknown>) =>
  ({
    item: {
      id: `item-${String(fields["id"])}`,
      runId: run("run-1"),
      status: "completed",
      startedAt: at(0),
      updatedAt: at(0),
      ...fields,
    },
  }) as unknown as OrchestrationV2ProjectedTurnItem;

const owner = (id: string, fields: Record<string, unknown> = {}) =>
  item({ id, type: "user_message", messageId: `orchestrator-${id}`, text: id, ...fields });
const reply = (id: string, fields: Record<string, unknown> = {}) =>
  item({ id, type: "assistant_message", text: id, ...fields });
const tool = (id: string, fields: Record<string, unknown> = {}) =>
  item({ id, type: "dynamic_tool", toolName: "t3-code.t3_folder_update", input: {}, ...fields });

const kinds = (items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
  orchestratorFeed(items, null)
    .rows.filter((row) => row.kind !== "day")
    .map((row) => row.kind);

describe("orchestratorFeed", () => {
  const react = (id: string, emoji = "👋") =>
    tool(id, { toolName: "t3-code.orchestrator_react", input: { emoji } });

  it.each([
    ["alone", [react("wave")], ["owner"]],
    [
      "with a silent reply",
      [react("wave"), reply("(silent)", { id: "s" })],
      ["owner", "orchestrator"],
    ],
    ["echoed as text", [react("wave"), reply("👋", { id: "e", text: "👋" })], ["owner"]],
    ["beside a real reply", [react("wave"), reply("Done")], ["owner", "tools", "orchestrator"]],
    ["beside other work", [react("wave"), tool("work")], ["owner", "tools"]],
  ])("shows a reaction's call only when there is a reply: %s", (_name, rest, expected) => {
    expect(kinds([owner("thanks"), ...rest])).toEqual(expected);
  });

  it("hides prompts the server wrote, and their tool calls, keeping what it said out loud", () => {
    const review = {
      runId: run("run-review"),
    };
    expect(
      kinds([
        owner("mine"),
        owner("review", { ...review, messageId: "orchestrator-review-1" }),
        tool("reviewing", review),
        reply("heads-up", review),
        owner("wake", { ...review, messageId: "orchestrator-wake-1" }),
        owner("scheduled", { ...review, scheduledTaskId: "task-1" }),
      ]),
    ).toEqual(["owner", "orchestrator"]);
  });

  it("merges neighbouring tool calls and reports the one running", () => {
    const feed = orchestratorFeed(
      [
        owner("mine"),
        tool("first", { status: "completed" }),
        tool("second", { status: "running" }),
      ],
      run("run-1"),
    );
    const tools = feed.rows.find((row) => row.kind === "tools");
    expect(tools?.kind === "tools" ? tools.calls.map((call) => call.running) : []).toEqual([
      false,
      true,
    ]);
    expect(feed.currentTool?.label).toBe("Organizing conversation folders");
  });

  it.each([
    { name: "delivered until the run produces something", later: [], expected: "delivered" },
    {
      name: "read when the run's next item starts",
      later: [reply("answer", { startedAt: at(2) })],
      expected: "read",
    },
  ])("marks the latest message $name", ({ later, expected }) => {
    const row = orchestratorFeed([owner("mine"), ...later], null).rows.find(
      (candidate) => candidate.kind === "owner",
    );
    expect(row?.kind === "owner" ? row.receipt?.state : null).toBe(expected);
  });

  it("shows a receipt on the newest owner message only", () => {
    const owners = orchestratorFeed(
      [owner("old"), reply("answer"), owner("new")],
      null,
    ).rows.filter((row) => row.kind === "owner");
    expect(owners.map((row) => row.kind === "owner" && row.receipt !== null)).toEqual([
      false,
      true,
    ]);
  });

  it.each([
    { name: "same sender, close together", gap: 1, groupEnd: false },
    { name: "same sender, long gap", gap: 20, groupEnd: true },
  ])("groups messages: $name", ({ gap, groupEnd }) => {
    const [first] = orchestratorFeed(
      [reply("one", { startedAt: at(0) }), reply("two", { startedAt: at(gap) })],
      null,
    ).rows.filter((row) => row.kind === "orchestrator");
    expect(first?.kind === "orchestrator" && first.groupEnd).toBe(groupEnd);
  });

  it.each([
    {
      name: "the owner's run",
      items: [owner("mine")],
      active: run("run-1"),
      typing: true,
    },
    {
      name: "a review that has said nothing",
      items: [owner("review", { messageId: "orchestrator-review-1" })],
      active: run("run-1"),
      typing: false,
    },
    {
      name: "a review once its message streams",
      items: [
        owner("review", { messageId: "orchestrator-review-1" }),
        reply("writing", { status: "running" }),
      ],
      active: run("run-1"),
      typing: true,
    },
    { name: "an idle thread", items: [owner("mine"), reply("done")], active: null, typing: false },
  ])("shows typing for $name: $typing", ({ items, active, typing }) => {
    expect(orchestratorFeed(items, active).typing).toBe(typing);
  });
});
