import { SplitWorkspace } from "./layouts/SplitWorkspace";
import { SidebarInset } from "./ui/sidebar";
import type { ThreadRouteTarget } from "../threadRoutes";

/**
 * Rendered by the `_chat` layout, since an element only survives a route swap when the same parent
 * renders it. `background` keeps the threads mounted, inert and in place under Settings or Usage.
 */
export function ThreadRouteView({
  target,
  background = false,
}: {
  target: ThreadRouteTarget;
  background?: boolean;
}) {
  return (
    <SidebarInset
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
      inert={background}
    >
      <SplitWorkspace routeTarget={target} background={background} />
    </SidebarInset>
  );
}
