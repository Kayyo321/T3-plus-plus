import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, Columns2Icon, LayoutDashboardIcon, XIcon } from "lucide-react";

import {
  applyLayout,
  closeSplitPane,
  openEmptySplit,
  openThreadInSplit,
  setSplitLinked,
} from "../../layouts/layoutActions";
import type { LayoutDocument } from "../../layouts/layoutDocument";
import type { SplitViewState } from "../../layouts/splitView.logic";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { requestSaveLayout } from "./SaveLayoutDialog";

const threadRefOf = (thread: EnvironmentThreadShell) =>
  scopeThreadRef(thread.environmentId, thread.id);

/**
 * The palette's layout and split actions. `threadRef` is the focused conversation; `threads` lets
 * the parent and forks of that conversation be opened beside it by name.
 */
export function buildLayoutPaletteItems(input: {
  readonly threadRef: ScopedThreadRef;
  readonly thread: EnvironmentThreadShell | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly layouts: ReadonlyArray<LayoutDocument>;
  readonly activeLayoutId: string;
  readonly split: SplitViewState;
  readonly iconClassName: string;
}): CommandPaletteActionItem[] {
  const { threadRef, thread, threads, split, iconClassName } = input;
  const layoutItems = input.layouts.map((layout): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:layout:${layout.id}`,
    searchTerms: ["layout", "panels", "arrange", layout.name],
    title: `Layout: ${layout.name}`,
    icon:
      layout.id === input.activeLayoutId ? (
        <CheckIcon className={iconClassName} />
      ) : (
        <LayoutDashboardIcon className={iconClassName} />
      ),
    run: async () => applyLayout(threadRef, layout),
  }));
  const saveItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:layout:save",
    searchTerms: ["layout", "save", "panels"],
    title: "Layout: Save current…",
    icon: <LayoutDashboardIcon className={iconClassName} />,
    run: async () => requestSaveLayout(),
  };

  const splitItem = (
    value: string,
    title: string,
    run: () => void,
    icon = <Columns2Icon className={iconClassName} />,
  ): CommandPaletteActionItem => ({
    kind: "action",
    value: `action:split:${value}`,
    searchTerms: ["split", "side by side", "compare", "pane", title],
    title,
    icon,
    run: async () => run(),
  });
  const relatives = thread
    ? threads.filter(
        (entry) =>
          entry.id !== thread.id &&
          entry.environmentId === thread.environmentId &&
          (entry.id === thread.lineage.parentThreadId ||
            entry.lineage.parentThreadId === thread.id ||
            (thread.lineage.parentThreadId !== null &&
              entry.lineage.parentThreadId === thread.lineage.parentThreadId)),
      )
    : [];
  const focusedPaneId = split.focusedPaneId;
  return [
    ...layoutItems,
    saveItem,
    splitItem("open", "Split: Open a conversation beside this one", openEmptySplit),
    ...relatives
      .slice(0, 6)
      .map((entry) =>
        splitItem(
          `thread:${scopedThreadKey(threadRefOf(entry))}`,
          `Split: Open ${entry.title}`,
          () => openThreadInSplit(threadRefOf(entry)),
        ),
      ),
    ...(split.panes.length > 0 && focusedPaneId !== null
      ? [
          splitItem(
            "close",
            "Split: Close this pane",
            () => closeSplitPane(focusedPaneId),
            <XIcon className={iconClassName} />,
          ),
          splitItem(
            "link",
            split.linked ? "Split: Unlink panes" : "Split: Link panes by turn",
            () => setSplitLinked(!split.linked),
          ),
        ]
      : []),
  ];
}
