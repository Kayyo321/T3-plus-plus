import { useOpenWorkspaceMode } from "~/hooks/useWorkspaceModeRouting";
import { cn } from "~/lib/utils";
import { useWorkspaceMode } from "~/state/workspaceMode";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WORKSPACE_MODE_TABS } from "./workspaceModeTabs";

/** The app's two halves. Chat never touches this machine's files; Code works in your projects. */
export function SidebarModeTabs() {
  const current = useWorkspaceMode((state) => state.mode);
  const openMode = useOpenWorkspaceMode();
  return (
    <div
      role="tablist"
      aria-label="Workspace"
      className="flex shrink-0 items-center gap-0.5 rounded-lg bg-sidebar-control-surface p-0.5 [-webkit-app-region:no-drag]"
    >
      {WORKSPACE_MODE_TABS.map(({ mode, label, icon: Icon }) => (
        <Tooltip key={mode}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="tab"
                aria-selected={current === mode}
                aria-label={label}
                className={cn(
                  "flex size-7 cursor-pointer items-center justify-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  current === mode
                    ? "bg-sidebar-row-active text-sidebar-foreground"
                    : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
                )}
                onClick={() => void openMode(mode)}
              />
            }
          >
            <Icon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{label}</TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}
