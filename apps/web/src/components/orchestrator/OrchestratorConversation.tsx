import { splitOrchestratorMessage } from "@t3tools/client-runtime/state/orchestratorMessages";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestratorReaction, RunId, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import {
  ArrowDownIcon,
  BotIcon,
  CheckCheckIcon,
  CheckIcon,
  FolderTreeIcon,
  GitBranchIcon,
  GlobeIcon,
  type LucideIcon,
  MessageCircleIcon,
  PanelTopIcon,
  SearchIcon,
  SettingsIcon,
  SmilePlusIcon,
  TimerIcon,
  WrenchIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";

import { useAssistantMessageText, useTimelineVisibleTurnItems } from "../../state/entities";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { OrchestratorGlyph } from "./OrchestratorGlyph";
import {
  orchestratorBubbleKey,
  type OrchestratorFeedRow,
  orchestratorFeed,
  type OrchestratorToolCall,
} from "./orchestratorChat.logic";

const VISIBLE_ITEM_LIMIT = 200;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "🙏"];
const BUBBLE_STAGGER_MS = 110;
const JUMP_THRESHOLD_PX = 160;

const toolIcon = (action: string | null): LucideIcon => {
  if (action === null) return WrenchIcon;
  if (action.startsWith("schedule")) return TimerIcon;
  if (action === "delegate" || action.startsWith("task")) return BotIcon;
  if (action === "thread-search") return SearchIcon;
  if (action === "thread-organize" || action === "thread-transfers") return FolderTreeIcon;
  if (action.startsWith("thread") || action.startsWith("queue")) return MessageCircleIcon;
  if (action.startsWith("git") || action.startsWith("worktree")) return GitBranchIcon;
  if (action.startsWith("project")) return FolderTreeIcon;
  if (action.startsWith("environment")) return SettingsIcon;
  if (action === "browser" || action.startsWith("html")) return GlobeIcon;
  if (action === "document") return PanelTopIcon;
  return WrenchIcon;
};

const dayLabel = (at: DateTime.Utc) => {
  const date = new Date(DateTime.toEpochMillis(at));
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const timeOf = (at: DateTime.Utc, format: TimestampFormat) =>
  formatShortTimestamp(DateTime.formatIso(at), format);

function ToolStrip(props: {
  readonly calls: ReadonlyArray<OrchestratorToolCall>;
  readonly animate: boolean;
}) {
  const running = props.calls.findLast((call) => call.running);
  return (
    <div
      className={cn(
        "flex max-w-[85%] items-center gap-1.5 self-start pl-9",
        props.animate && "orchestrator-bubble-enter",
      )}
    >
      <div className="flex flex-wrap items-center gap-1">
        {props.calls.map((call) => {
          const Icon = toolIcon(call.action);
          return (
            <Tooltip key={call.id}>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label={call.label}
                    data-running={call.running}
                    className={cn(
                      "orchestrator-tool-pop flex size-6 items-center justify-center rounded-full border border-foreground/10 bg-card/60 text-muted-foreground backdrop-blur-md",
                      "data-[running=true]:border-primary/50 data-[running=true]:text-primary",
                      call.failed && "text-destructive-foreground",
                    )}
                  />
                }
              >
                <Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>{call.label}</TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
      {running ? (
        <span className="orchestrator-fade-in truncate text-2xs text-muted-foreground">
          {running.label}
        </span>
      ) : null}
    </div>
  );
}

function ReactionPicker(props: {
  readonly align: "start" | "end";
  readonly onPick: (emoji: string) => void;
}) {
  return (
    <div
      role="menu"
      aria-label="React"
      className={cn(
        "orchestrator-reaction-tray absolute -top-9 z-20 flex gap-0.5 rounded-full border border-foreground/10 bg-popover/90 p-1 shadow-lg backdrop-blur-xl",
        props.align === "end" ? "right-0" : "left-0",
      )}
    >
      {QUICK_REACTIONS.map((emoji, index) => (
        <button
          key={emoji}
          type="button"
          role="menuitem"
          aria-label={`React with ${emoji}`}
          className="orchestrator-reaction-option flex size-7 items-center justify-center rounded-full text-base transition-transform duration-150 hover:scale-125 hover:bg-accent focus-visible:scale-125"
          style={{ "--option-index": index } as CSSProperties}
          onClick={() => props.onPick(emoji)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

function Bubble(props: {
  readonly mine: boolean;
  readonly tail: boolean;
  readonly bubbleKey: string;
  readonly animate: boolean;
  readonly delayIndex: number;
  readonly reactions: ReadonlyArray<OrchestratorReaction>;
  readonly excerpt: string;
  readonly onReact: (bubbleKey: string, emoji: string, excerpt: string) => void;
  readonly children: React.ReactNode;
}) {
  const [picking, setPicking] = useState(false);
  const react = (emoji: string) => {
    setPicking(false);
    props.onReact(props.bubbleKey, emoji, props.excerpt);
  };
  return (
    <div
      className={cn(
        "group/bubble relative flex max-w-[85%] items-center gap-1",
        props.mine ? "flex-row-reverse self-end" : "self-start",
        props.animate && "orchestrator-bubble-enter",
        props.reactions.length > 0 && "mb-2.5",
      )}
      data-mine={props.mine}
      style={{ "--bubble-delay": `${props.delayIndex * BUBBLE_STAGGER_MS}ms` } as CSSProperties}
      onMouseLeave={() => setPicking(false)}
    >
      <div
        className={cn(
          "relative min-w-0 rounded-2xl border px-3 py-1.5 text-sm wrap-anywhere shadow-sm backdrop-blur-xl",
          props.mine
            ? "orchestrator-bubble-mine border-primary/40 text-primary-foreground"
            : "border-foreground/10 bg-card/60 text-foreground",
          props.tail && (props.mine ? "rounded-br-md" : "rounded-bl-md"),
        )}
      >
        {props.children}
        {props.reactions.length > 0 ? (
          <div className={cn("absolute -bottom-3 flex gap-0.5", props.mine ? "left-2" : "right-2")}>
            {props.reactions.map((reaction) => (
              <button
                key={`${reaction.by}:${reaction.emoji}`}
                type="button"
                disabled={reaction.by !== "owner"}
                aria-label={`${reaction.by === "owner" ? "Your" : "The orchestrator's"} reaction ${reaction.emoji}`}
                className={cn(
                  "orchestrator-reaction-pop flex h-5 min-w-5 items-center justify-center rounded-full border bg-popover/90 px-1 text-xs shadow-sm backdrop-blur-md",
                  reaction.by === "owner" ? "border-primary/60" : "border-foreground/15",
                )}
                onClick={() => react(reaction.emoji)}
              >
                {reaction.emoji}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        aria-label="Add a reaction"
        aria-expanded={picking}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-within/bubble:opacity-100 group-hover/bubble:opacity-100 hover:bg-accent hover:text-foreground aria-expanded:opacity-100 pointer-coarse:opacity-60"
        onClick={() => setPicking((open) => !open)}
      >
        <SmilePlusIcon className="size-3.5" />
      </button>
      {picking ? <ReactionPicker align={props.mine ? "end" : "start"} onPick={react} /> : null}
    </div>
  );
}

function OrchestratorMessage(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly row: Extract<OrchestratorFeedRow, { readonly kind: "orchestrator" }>;
  readonly animate: boolean;
  readonly reactions: Readonly<Record<string, ReadonlyArray<OrchestratorReaction>>>;
  readonly timestampFormat: TimestampFormat;
  readonly onReact: (bubbleKey: string, emoji: string, excerpt: string) => void;
}) {
  const { row } = props;
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const liveText = useAssistantMessageText(threadRef, row.itemId);
  const parts = splitOrchestratorMessage(liveText ?? row.text);
  // A message lands whole, as in any messenger; the typing bubble stands in for the one being written.
  const shown = row.streaming ? parts.slice(0, -1) : parts;
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((text, index) => {
        const last = index === shown.length - 1;
        const tail = last && row.groupEnd && !row.streaming;
        const bubbleKey = orchestratorBubbleKey(row.itemId, index);
        return (
          <div key={bubbleKey} className="flex items-end gap-1.5">
            <span className="flex size-7 shrink-0 items-center justify-center">
              {tail ? (
                <span className="orchestrator-fade-in flex size-7 items-center justify-center rounded-full border border-foreground/10 bg-card/70 backdrop-blur-md">
                  <OrchestratorGlyph size={18} motion="still" />
                </span>
              ) : null}
            </span>
            <Bubble
              mine={false}
              tail={tail}
              bubbleKey={bubbleKey}
              animate={props.animate}
              delayIndex={index}
              reactions={props.reactions[bubbleKey] ?? []}
              excerpt={text.slice(0, 120)}
              onReact={props.onReact}
            >
              <ChatMarkdown
                text={text}
                cwd={undefined}
                threadRef={threadRef}
                environmentId={props.environmentId}
                className="orchestrator-markdown text-sm"
              />
            </Bubble>
          </div>
        );
      })}
      {row.groupEnd && !row.streaming ? (
        <time className="orchestrator-fade-in pl-9 text-2xs text-muted-foreground">
          {timeOf(row.at, props.timestampFormat)}
        </time>
      ) : null}
    </>
  );
}

function TypingBubble() {
  return (
    <div
      role="status"
      aria-label="The orchestrator is typing"
      className="orchestrator-bubble-enter flex items-end gap-1.5 self-start"
    >
      <span className="flex size-7 items-center justify-center rounded-full border border-foreground/10 bg-card/70 backdrop-blur-md">
        <OrchestratorGlyph size={18} motion="working" />
      </span>
      <span className="flex h-8 items-center gap-1 rounded-2xl rounded-bl-md border border-foreground/10 bg-card/60 px-3.5 backdrop-blur-xl">
        <span className="orchestrator-typing-dot" />
        <span className="orchestrator-typing-dot" />
        <span className="orchestrator-typing-dot" />
      </span>
    </div>
  );
}

/** Keeps the owner's on-screen bubbles aligned to one gradient, at most once a frame. */
function useBubbleGradient(scroller: HTMLDivElement | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows scroll position and layout, which live in the DOM
  useEffect(() => {
    if (scroller === null) return;
    let frame = 0;
    const align = () => {
      frame = 0;
      const { top, bottom, height } = scroller.getBoundingClientRect();
      scroller.style.setProperty("--orchestrator-gradient-height", `${height}px`);
      for (const bubble of scroller.querySelectorAll<HTMLElement>(".orchestrator-bubble-mine")) {
        const rect = bubble.getBoundingClientRect();
        if (rect.bottom < top || rect.top > bottom) continue;
        bubble.style.backgroundPositionY = `${top - rect.top}px`;
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(align);
    };
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const stopScroller = observeResize(scroller, schedule);
    const log = scroller.firstElementChild;
    const stopLog = log === null ? undefined : observeResize(log, schedule);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      stopScroller();
      stopLog?.();
    };
  }, [scroller]);
}

export function useOrchestratorFeed(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  activeRunId: RunId | null,
) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const items = useTimelineVisibleTurnItems(threadRef).slice(-VISIBLE_ITEM_LIMIT);
  return orchestratorFeed(items, activeRunId);
}

export function OrchestratorConversation(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly feed: ReturnType<typeof orchestratorFeed>;
  readonly reactions: Readonly<Record<string, ReadonlyArray<OrchestratorReaction>>>;
  readonly timestampFormat: TimestampFormat;
  readonly clearing?: boolean;
  readonly onReact: (bubbleKey: string, emoji: string, excerpt: string) => void;
}) {
  const { rows, typing } = props.feed;
  // What was already here when the panel opened arrives without a flourish.
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(() =>
    rows.length === 0 ? null : new Set(rows.map((row) => row.key)),
  );
  if (baseline === null && rows.length > 0) setBaseline(new Set(rows.map((row) => row.key)));
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useBubbleGradient(scroller);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={setScroller}
        className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overflow-x-hidden"
        // A reversed column measures scrollTop as a negative distance from the newest message.
        onScroll={(event) => setAwayFromLatest(event.currentTarget.scrollTop < -JUMP_THRESHOLD_PX)}
      >
        <div
          className={cn(
            "flex flex-col gap-1 px-3 pt-10 pb-3",
            props.clearing && "orchestrator-clearing",
          )}
          role="log"
          aria-label="Conversation"
        >
          {rows.map((row) => {
            const animate = baseline !== null && !baseline.has(row.key);
            switch (row.kind) {
              case "day":
                return (
                  <div
                    key={row.key}
                    className="orchestrator-fade-in my-2 self-center rounded-full bg-background/50 px-2.5 py-0.5 text-2xs text-muted-foreground backdrop-blur-md"
                  >
                    {dayLabel(row.at)}
                  </div>
                );
              case "tools":
                return <ToolStrip key={row.key} calls={row.calls} animate={animate} />;
              case "orchestrator":
                return (
                  <OrchestratorMessage
                    key={row.key}
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    row={row}
                    animate={animate}
                    reactions={props.reactions}
                    timestampFormat={props.timestampFormat}
                    onReact={props.onReact}
                  />
                );
              case "owner":
                return (
                  <div key={row.key} className="flex flex-col gap-0.5">
                    <Bubble
                      mine
                      tail={row.groupEnd}
                      bubbleKey={row.itemId}
                      animate={animate}
                      delayIndex={0}
                      reactions={props.reactions[row.itemId] ?? []}
                      excerpt={row.text.slice(0, 120)}
                      onReact={props.onReact}
                    >
                      <p className="whitespace-pre-wrap">{row.text}</p>
                    </Bubble>
                    {row.receipt === null ? (
                      row.groupEnd ? (
                        <time className="self-end pr-1 text-2xs text-muted-foreground">
                          {timeOf(row.at, props.timestampFormat)}
                        </time>
                      ) : null
                    ) : (
                      <span
                        key={row.receipt.state}
                        className="orchestrator-fade-in flex items-center gap-1 self-end pr-1 text-2xs text-muted-foreground"
                      >
                        {row.receipt.state === "read" ? (
                          <>
                            <CheckCheckIcon className="size-3 text-primary" />
                            Read at {timeOf(row.receipt.at, props.timestampFormat)}
                          </>
                        ) : (
                          <>
                            <CheckIcon className="size-3" />
                            Delivered
                          </>
                        )}
                      </span>
                    )}
                  </div>
                );
            }
          })}
          {typing ? <TypingBubble /> : null}
        </div>
      </div>
      {awayFromLatest ? (
        <button
          type="button"
          aria-label="Jump to the latest message"
          className="orchestrator-fade-in absolute right-3 bottom-2 flex size-8 items-center justify-center rounded-full border border-foreground/10 bg-popover/90 text-foreground shadow-md backdrop-blur-xl hover:bg-accent"
          onClick={() => scroller?.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <ArrowDownIcon className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
