import {
  CONVERSATION_PANEL,
  LAYOUT_DOCUMENT_VERSION,
  type LayoutDocument,
} from "../src/layouts/layoutDocument";

/** Explorer, editor, and docked conversation over a tools strip: the deepest tree tests need. */
export const WORKBENCH_LAYOUT: LayoutDocument = {
  version: LAYOUT_DOCUMENT_VERSION,
  id: "workbench",
  name: "Workbench",
  panes: null,
  settings: { threadDetails: false, terminalDrawer: false },
  root: {
    type: "split",
    direction: "column",
    sizes: [0.72, 0.28],
    children: [
      {
        type: "split",
        direction: "row",
        sizes: [0.18, 0.54, 0.28],
        children: [
          { type: "group", id: "explorer", kinds: ["files"], opens: ["files"] },
          { type: "group", id: "editor", kinds: ["file"], opens: [] },
          {
            type: "group",
            id: CONVERSATION_PANEL,
            kinds: [CONVERSATION_PANEL],
            opens: [],
          },
        ],
      },
      {
        type: "group",
        id: "tools",
        kinds: ["terminal", "diff", "git-graph"],
        opens: ["terminal", "diff", "git-graph"],
      },
    ],
  },
};
