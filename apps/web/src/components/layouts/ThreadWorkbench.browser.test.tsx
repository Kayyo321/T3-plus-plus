import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { BUILT_IN_LAYOUTS } from "../../layouts/layoutDocument";
import { arrangementFromDocument } from "../../layouts/threadArrangement";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";

const mounts = vi.hoisted(() => new Map<string, number>());

vi.mock("../chat/RightPanelSurfaceContent", async () => {
  const { useEffect } = await import("react");
  return {
    RightPanelSurfaceContent: (props: { surface: RightPanelSurface }) => {
      const { id } = props.surface;
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1);
      }, [id]);
      return <div>Surface {id}</div>;
    },
  };
});

vi.mock("../RightPanelTabs", () => ({
  RightPanelTabs: (props: { surfaces: readonly RightPanelSurface[]; layoutControls: unknown }) => (
    <div>
      {props.surfaces.map((surface) => `Tab ${surface.id}`).join(", ")}
      {props.layoutControls as never}
    </div>
  ),
}));

const { ThreadWorkbench } = await import("./ThreadWorkbench");

const threadRef = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
const layout = (id: string) => BUILT_IN_LAYOUTS.find((entry) => entry.id === id)!;
const diff: RightPanelSurface = { id: "diff", kind: "diff" };

function Workbench(props: { layoutId: string }) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const arrangement = useRightPanelStore(
    (state) => Object.values(state.byThreadKey)[0]?.arrangement,
  );
  return (
    <div
      ref={setContainer}
      data-layout={props.layoutId}
      style={{ position: "relative", height: 600 }}
    >
      {arrangement ? (
        <ThreadWorkbench
          threadRef={threadRef}
          arrangement={arrangementFromDocument(layout(props.layoutId), 1)!}
          surfaces={[diff]}
          activeSurfaceId="diff"
          maximized={false}
          container={container}
          tabs={{} as never}
          content={{} as never}
        />
      ) : null}
    </div>
  );
}

function setup() {
  mounts.clear();
  useRightPanelStore.setState({ byThreadKey: {} });
  useRightPanelStore
    .getState()
    .applyArrangement(threadRef, arrangementFromDocument(layout("review"), 1));
  return { [Symbol.dispose]: () => useRightPanelStore.setState({ byThreadKey: {} }) };
}

describe("ThreadWorkbench", () => {
  it("keeps a surface's instance when a layout moves it to another group", async () => {
    using _state = setup();
    await using screen = await render(<Workbench layoutId="review" />, { router: false });
    await expect.element(screen.getByText("Surface diff")).toBeInTheDocument();

    await screen.rerender(<Workbench layoutId="ide" />);

    await expect.element(screen.getByText("Surface diff")).toBeInTheDocument();
    expect(mounts.get("diff")).toBe(1);
  });

  it("publishes the conversation's place for the chat column", async () => {
    using _state = setup();
    await using screen = await render(<Workbench layoutId="ide" />, { router: false });
    await expect.element(screen.getByText("Surface diff")).toBeInTheDocument();
    const host = screen.container.querySelector<HTMLElement>("[data-layout]")!;
    expect(host.style.getPropertyValue("--workbench-chat-left")).toContain("calc(");
  });

  it("resizes from the keyboard through the store", async () => {
    using _state = setup();
    await using screen = await render(<Workbench layoutId="review" />, { router: false });
    const separator = screen.getByRole("separator");

    await userEvent.click(separator);
    await userEvent.keyboard("{ArrowRight}");

    const stored = Object.values(useRightPanelStore.getState().byThreadKey)[0]?.arrangement?.root;
    expect(stored).toMatchObject({ sizes: [expect.closeTo(0.47), expect.closeTo(0.53)] });
  });
});
