import type { AnyRouter } from "@tanstack/react-router";

import { isCommandPaletteOpen } from "../commandPaletteBus";
import { toastManager } from "../components/ui/toast";
import {
  bindLayoutRouter,
  closeSplitPane,
  cycleLayout,
  focusAdjacentPane,
  openEmptySplit,
  readFocusedThreadRef,
} from "../layouts/layoutActions";
import { useSplitViewStore } from "../layouts/splitViewStore";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import { type CommandHandler, registerCommands } from "./dispatcher";

const claim = (event: KeyboardEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/** Layout and split keys. They act on the focused pane, which the route always follows. */
export function installLayoutCommands(router: AnyRouter): () => void {
  bindLayoutRouter(router);
  const focusNeighbor =
    (direction: 1 | -1): CommandHandler =>
    (event) => {
      if (useSplitViewStore.getState().panes.length === 0) return false;
      claim(event);
      if (!event.repeat && focusAdjacentPane(direction)) {
        requestWorkspaceFocus({ area: "composer" });
      }
    };
  return registerCommands(
    {
      "layout.cycle": (event) => {
        const threadRef = readFocusedThreadRef();
        if (threadRef === null) return false;
        claim(event);
        if (event.repeat) return;
        const layout = cycleLayout(threadRef);
        if (layout) {
          toastManager.add({ id: "layout-cycle", title: `Layout: ${layout.name}`, timeout: 1500 });
        }
      },
      "split.open": (event) => {
        if (readFocusedThreadRef() === null) return false;
        claim(event);
        if (!event.repeat) openEmptySplit();
      },
      "split.close": (event) => {
        const { focusedPaneId } = useSplitViewStore.getState();
        if (focusedPaneId === null) return false;
        claim(event);
        if (!event.repeat) closeSplitPane(focusedPaneId);
      },
      "split.focusNext": focusNeighbor(1),
      "split.focusPrevious": focusNeighbor(-1),
    },
    { when: () => !isCommandPaletteOpen() },
  );
}
