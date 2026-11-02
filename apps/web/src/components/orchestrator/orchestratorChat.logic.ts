import { splitOrchestratorMessage } from "@t3tools/client-runtime/state/orchestratorMessages";
import type { OrchestrationV2ProjectedTurnItem, RunId } from "@t3tools/contracts";
import {
  resolveT3McpSummaryAction,
  resolveT3McpToolDefinition,
} from "@t3tools/shared/t3McpToolPresentation";
import * as DateTime from "effect/DateTime";

type TurnItem = OrchestrationV2ProjectedTurnItem["item"];
type UserMessageItem = Extract<TurnItem, { readonly type: "user_message" }>;

/** Runs the owner did not ask for: supervision, follow-ups, and scheduled work. */
const SYSTEM_MESSAGE_PREFIXES = ["orchestrator-review-", "orchestrator-wake-"];
const GROUP_GAP_MS = 5 * 60_000;

export type OrchestratorReceipt =
  | { readonly state: "delivered" }
  | { readonly state: "read"; readonly at: DateTime.Utc };

export interface OrchestratorToolCall {
  readonly id: string;
  readonly label: string;
  readonly running: boolean;
  readonly failed: boolean;
  readonly action: string | null;
}

export type OrchestratorFeedRow =
  | { readonly kind: "day"; readonly key: string; readonly at: DateTime.Utc }
  | {
      readonly kind: "owner";
      readonly key: string;
      readonly itemId: string;
      readonly text: string;
      readonly at: DateTime.Utc;
      readonly groupEnd: boolean;
      /** Only the newest message shows its receipt. */
      readonly receipt: OrchestratorReceipt | null;
    }
  | {
      readonly kind: "orchestrator";
      readonly key: string;
      readonly itemId: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly at: DateTime.Utc;
      readonly groupEnd: boolean;
    }
  | {
      readonly kind: "tools";
      readonly key: string;
      readonly calls: ReadonlyArray<OrchestratorToolCall>;
    };

export interface OrchestratorFeed {
  readonly rows: ReadonlyArray<OrchestratorFeedRow>;
  /** Show the typing bubble: the owner asked and the reply is not fully out yet. */
  readonly typing: boolean;
  readonly currentTool: OrchestratorToolCall | null;
}

const isOwnerMessage = (item: UserMessageItem) =>
  item.scheduledTaskId === undefined &&
  !SYSTEM_MESSAGE_PREFIXES.some((prefix) => item.messageId.startsWith(prefix));

const isActive = (item: TurnItem) =>
  item.status === "pending" || item.status === "running" || item.status === "waiting";

const toolLabel = (toolName: string | null, input: unknown, active: boolean) => {
  const definition = resolveT3McpToolDefinition(toolName, input);
  if (definition === null) return toolName ?? "A tool";
  const [action, running, , detail] = definition.labels;
  return `${active ? running : action} ${detail}`;
};

const isReaction = (item: TurnItem) =>
  item.type === "dynamic_tool" &&
  resolveT3McpSummaryAction(item.toolName, item.input) === "message-react";

const reactionEmoji = (item: TurnItem) => {
  if (item.type !== "dynamic_tool" || typeof item.input !== "object" || item.input === null) {
    return undefined;
  }
  const { emoji } = item.input as { readonly emoji?: unknown };
  return typeof emoji === "string" ? emoji : undefined;
};

/** A reply that only repeats the run's reaction says nothing the reaction did not. */
const isReactionEcho = (item: TurnItem, list: ReadonlyArray<TurnItem>) =>
  item.type === "assistant_message" &&
  list.some(
    (other) =>
      other.runId === item.runId && isReaction(other) && reactionEmoji(other) === item.text.trim(),
  );

const localDay = (at: DateTime.Utc) => new Date(DateTime.toEpochMillis(at)).toDateString();

/**
 * Turns the orchestrator's turn items into what a messaging app shows. Prompts the server wrote are
 * hidden with their tool calls, so a review that ends up saying nothing leaves no trace.
 */
export const orchestratorFeed = (
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  activeRunId: RunId | null,
): OrchestratorFeed => {
  const list = items.map(({ item }) => item);
  const systemRuns = new Set<RunId>();
  for (const item of list) {
    if (item.type === "user_message" && !isOwnerMessage(item) && item.runId !== null) {
      systemRuns.add(item.runId);
    }
  }
  const lastOwnerItem = list.findLast(
    (item): item is UserMessageItem => item.type === "user_message" && isOwnerMessage(item),
  );

  // A run that only reacted leaves the reaction and nothing else, so its call stays out of view.
  const runsWithReply = new Set<RunId | null>(
    list
      .filter(
        (item) =>
          item.type === "assistant_message" &&
          !isActive(item) &&
          splitOrchestratorMessage(item.text).length > 0 &&
          !isReactionEcho(item, list),
      )
      .map((item) => item.runId),
  );

  const rows: Array<OrchestratorFeedRow> = [];
  let day: string | null = null;
  const openDay = (at: DateTime.Utc) => {
    const next = localDay(at);
    if (next === day) return;
    day = next;
    rows.push({ kind: "day", key: `day:${next}`, at });
  };

  list.forEach((item, index) => {
    const at = item.startedAt ?? item.updatedAt;
    switch (item.type) {
      case "user_message": {
        if (!isOwnerMessage(item)) return;
        openDay(at);
        const readBy = list
          .slice(index + 1)
          .find((later) => later.runId === item.runId && later.startedAt !== null);
        rows.push({
          kind: "owner",
          key: item.id,
          itemId: item.id,
          text: item.text,
          at,
          groupEnd: true,
          receipt:
            item.id !== lastOwnerItem?.id
              ? null
              : readBy?.startedAt != null
                ? { state: "read", at: readBy.startedAt }
                : { state: "delivered" },
        });
        return;
      }
      case "assistant_message":
        if (isReactionEcho(item, list)) return;
        openDay(at);
        rows.push({
          kind: "orchestrator",
          key: item.id,
          itemId: item.id,
          text: item.text,
          streaming: isActive(item),
          at,
          groupEnd: true,
        });
        return;
      case "dynamic_tool": {
        if (item.runId !== null && systemRuns.has(item.runId)) return;
        if (isReaction(item) && !runsWithReply.has(item.runId)) return;
        const running = isActive(item);
        const call: OrchestratorToolCall = {
          id: item.id,
          label: toolLabel(item.toolName, item.input, running),
          running,
          failed: item.status === "failed",
          action: resolveT3McpSummaryAction(item.toolName, item.input),
        };
        const previous = rows.at(-1);
        if (previous?.kind === "tools") {
          rows[rows.length - 1] = { ...previous, calls: [...previous.calls, call] };
          return;
        }
        openDay(at);
        rows.push({ kind: "tools", key: `tools:${item.id}`, calls: [call] });
        return;
      }
      default:
        return;
    }
  });

  const messages = rows.filter((row) => row.kind === "owner" || row.kind === "orchestrator");
  const grouped = rows.map((row) => {
    if (row.kind !== "owner" && row.kind !== "orchestrator") return row;
    const next = messages[messages.indexOf(row) + 1];
    const groupEnd =
      next === undefined ||
      next.kind !== row.kind ||
      DateTime.toEpochMillis(next.at) - DateTime.toEpochMillis(row.at) > GROUP_GAP_MS;
    return { ...row, groupEnd };
  });

  const replying =
    activeRunId !== null &&
    !systemRuns.has(activeRunId) &&
    list.some((item) => item.runId === activeRunId && item.type === "user_message");
  const streaming =
    rows.at(-1)?.kind === "orchestrator" &&
    list.some((item) => item.type === "assistant_message" && isActive(item));

  return {
    rows: grouped,
    typing: replying || streaming,
    currentTool:
      rows
        .flatMap((row) => (row.kind === "tools" ? row.calls : []))
        .findLast((call) => call.running) ?? null,
  };
};

/** Each bubble of a split message reacts on its own. */
export const orchestratorBubbleKey = (itemId: string, part: number) =>
  part === 0 ? itemId : `${itemId}#${part}`;
