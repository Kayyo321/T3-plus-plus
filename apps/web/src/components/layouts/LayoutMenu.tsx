import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, LayoutDashboardIcon } from "lucide-react";

import { applyLayout, resetLayout } from "../../layouts/layoutActions";
import { DEFAULT_BUILT_IN_LAYOUT_ID } from "../../layouts/layoutDocument";
import { resolveDefaultLayout, selectLayouts, useLayoutStore } from "../../layouts/layoutStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../../rightPanelStore";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { requestSaveLayout } from "./SaveLayoutDialog";

/** Picks, saves, and manages layouts for the conversation it sits in. */
export function LayoutMenu(props: {
  threadRef: ScopedThreadRef | null;
  projectId: ProjectId | null;
}) {
  const { threadRef, projectId } = props;
  const navigate = useNavigate();
  const saved = useLayoutStore((state) => state.saved);
  const favoriteId = useLayoutStore((state) => state.favoriteId);
  const projectLayoutId = useLayoutStore((state) =>
    projectId === null ? undefined : state.projectLayoutIds[projectId],
  );
  const appliedId = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).arrangement?.layoutId,
  );
  const activeId = appliedId ?? DEFAULT_BUILT_IN_LAYOUT_ID;
  const layouts = selectLayouts({ saved });
  const defaultLayoutId = resolveDefaultLayout(
    {
      saved,
      favoriteId,
      projectLayoutIds: projectLayoutId && projectId ? { [projectId]: projectLayoutId } : {},
    },
    projectId,
  ).id;
  const trigger = (
    <Toggle
      className="shrink-0 [-webkit-app-region:no-drag]"
      pressed={activeId !== DEFAULT_BUILT_IN_LAYOUT_ID}
      aria-label="Layouts"
      data-layout-menu-trigger
      variant="ghost"
      size="sm"
      disabled={threadRef === null}
    >
      <LayoutDashboardIcon className="size-4" />
    </Toggle>
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <MenuTrigger render={trigger} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Layouts</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" sideOffset={6} className="min-w-52">
        {layouts.map((layout) => (
          <MenuItem
            key={layout.id}
            onClick={() => {
              if (threadRef) applyLayout(threadRef, layout);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{layout.name}</span>
            {layout.id === defaultLayoutId ? (
              <span className="text-xs text-muted-foreground">Default</span>
            ) : null}
            {layout.id === activeId ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem onClick={requestSaveLayout}>Save current layout…</MenuItem>
        <MenuItem
          onClick={() => useLayoutStore.getState().setFavorite(activeId)}
          disabled={favoriteId === activeId}
        >
          Use this for new conversations
        </MenuItem>
        {projectId === null ? null : (
          <MenuItem
            onClick={() =>
              useLayoutStore
                .getState()
                .setProjectLayout(projectId, projectLayoutId === activeId ? null : activeId)
            }
          >
            {projectLayoutId === activeId
              ? "Stop using this for this project"
              : "Always use this for this project"}
          </MenuItem>
        )}
        <MenuItem
          onClick={() => {
            if (threadRef) resetLayout(threadRef, projectId);
          }}
        >
          Reset to default
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/layouts" })}>
          Manage layouts…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
