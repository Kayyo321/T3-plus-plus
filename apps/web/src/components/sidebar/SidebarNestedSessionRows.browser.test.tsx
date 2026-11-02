import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useConversationFolderViewStore } from "../../conversationFolderViewStore";
import { render } from "../../../test/render";
import { SidebarNestedSessionRows } from "./SidebarNestedSessionRows";

const shell = (id: string, title: string) =>
  ({
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("env"),
    title,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: null,
  }) as unknown as EnvironmentThreadShell;

it("collapses a branch from the connector and expands it from the collapsed row", async () => {
  const initial = useConversationFolderViewStore.getState();
  using _store = {
    [Symbol.dispose]: () => useConversationFolderViewStore.setState(initial, true),
  };
  useConversationFolderViewStore.setState({ collapsedKeys: {} });
  const parent = shell("parent", "Parent");
  const nested = new Map([[parent.id, [shell("child", "Child")]]]);
  await using screen = await render(
    <SidebarNestedSessionRows
      nested={nested}
      parent={parent}
      activeThreadKey={null}
      onOpenThreadMenu={vi.fn()}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Collapse nested sessions of Parent" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await userEvent.click(toggle);
  await expect.element(screen.getByText("Child")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Expand nested sessions of Parent" }));
  await expect.element(screen.getByText("Child")).toBeInTheDocument();
});
