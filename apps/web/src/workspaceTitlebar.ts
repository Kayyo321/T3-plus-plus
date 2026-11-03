import { observeResize } from "./lib/observeResize";

export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

export function attachWorkspaceTitlebarControls(element: HTMLDivElement | null) {
  const workspace = element?.closest<HTMLElement>("[data-workspace-titlebar-scope]");
  if (!element || !workspace) return;

  const measure = () => {
    const controls = element.getBoundingClientRect();
    workspace.style.setProperty("--workspace-titlebar-controls-width", `${controls.width}px`);
    workspace.style.setProperty(
      "--workspace-titlebar-controls-inset",
      `${Math.max(0, workspace.getBoundingClientRect().right - controls.left)}px`,
    );
  };
  measure();
  const stopObserving = observeResize([element, workspace], measure);
  return () => {
    stopObserving();
    workspace.style.removeProperty("--workspace-titlebar-controls-width");
    workspace.style.removeProperty("--workspace-titlebar-controls-inset");
  };
}
