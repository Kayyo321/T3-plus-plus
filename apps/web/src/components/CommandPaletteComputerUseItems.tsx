import type { ScopedThreadRef } from "@t3tools/contracts";
import { MonitorIcon, MonitorOffIcon } from "lucide-react";

import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import {
  showComputerUseSteps,
  startComputerUse,
  stopComputerUse,
} from "./computerUse/computerUseActions";
import { useComputerUseControls } from "./computerUse/useComputerUse";

const COMPUTER_USE_TARGETS_GROUP = "computer-use-targets";

export function useCommandPaletteComputerUseItems(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const { settingEnabled, status, canStop, start } = useComputerUseControls(threadRef);
  if (threadRef === null) return [];
  const running = status !== "off";
  return [
    ...(running && canStop
      ? [
          {
            kind: "action" as const,
            value: "action:computer-use-stop",
            searchTerms: ["computer use", "stop", "agent", "screen", "browser"],
            title: "Stop computer use",
            icon: <MonitorOffIcon className={ITEM_ICON_CLASS} />,
            shortcutCommand: "computerUse.stop" as const,
            run: () => stopComputerUse(threadRef),
          },
        ]
      : []),
    ...(running || settingEnabled
      ? [
          {
            kind: "action" as const,
            value: "action:computer-use-steps",
            searchTerms: ["computer use", "steps", "log", "screenshots", "history"],
            title: "Show computer use steps",
            icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
            shortcutCommand: "computerUse.showSteps" as const,
            run: async () => showComputerUseSteps(threadRef),
          },
        ]
      : []),
    ...(start === null
      ? []
      : [
          {
            kind: "submenu" as const,
            value: "action:computer-use-start",
            searchTerms: ["computer use", "turn on", "start", "browser", "virtual display"],
            title: "Turn on computer use",
            description: start.providerNote,
            icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
            addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
            groups: [
              {
                value: COMPUTER_USE_TARGETS_GROUP,
                label: "Target",
                items: start.targets.map((option) => ({
                  kind: "action" as const,
                  value: `action:computer-use-start:${option.target}`,
                  searchTerms: [option.label],
                  title: option.label,
                  disabled: option.disabledReason !== null,
                  ...(option.disabledReason === null ? {} : { description: option.disabledReason }),
                  icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
                  run: () => startComputerUse(threadRef, option.target),
                })),
              },
            ],
          },
        ]),
  ];
}
