import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { INITIAL_SPLIT_VIEW, type SplitPane } from "../../layouts/splitView.logic";
import { useSplitViewStore } from "../../layouts/splitViewStore";
import type { ThreadRouteTarget } from "../../threadRoutes";

const mounted = vi.hoisted(() => ({ count: 0 }));

// The real pane is ChatView; these tests are about which pane holds the keyboard.
vi.mock("./ThreadPaneView", async () => {
  const { useEffect } = await import("react");
  return {
    ThreadPaneView: (props: { target: ThreadRouteTarget; inactive?: boolean }) => {
      useEffect(() => {
        mounted.count += 1;
      }, []);
      const id = props.target.kind === "server" ? props.target.threadRef.threadId : "draft";
      return <textarea aria-label={`Composer ${id}`} data-inactive={props.inactive === true} />;
    },
  };
});

const { SplitWorkspace } = await import("./SplitWorkspace");

const target = (id: string): ThreadRouteTarget => ({
  kind: "server",
  threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id)),
});

function wideContainer() {
  const container = document.createElement("div");
  container.style.width = "1400px";
  return container;
}

function setup(panes: ReadonlyArray<SplitPane>, focusedPaneId: string | null) {
  mounted.count = 0;
  useSplitViewStore.setState(
    {
      ...INITIAL_SPLIT_VIEW,
      panes,
      focusedPaneId,
      sizes: panes.map(() => 1 / panes.length),
    },
    true,
  );
  return { [Symbol.dispose]: () => useSplitViewStore.setState(INITIAL_SPLIT_VIEW, true) };
}

const twoPanes: SplitPane[] = [
  { id: "a", target: target("one") },
  { id: "b", target: target("two") },
];

describe("SplitWorkspace", () => {
  it("renders an empty pane's picker without looping", async () => {
    using _state = setup(
      [
        { id: "a", target: target("one") },
        { id: "b", target: null },
      ],
      "a",
    );
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
      { container: wideContainer() },
    );
    await expect
      .element(screen.getByText("Pick one here, or click any conversation in the sidebar."))
      .toBeInTheDocument();
  });

  it("gives the keyboard to the pane the pointer enters", async () => {
    using _state = setup(twoPanes, "a");
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
      { container: wideContainer() },
    );
    const one = screen.getByLabelText("Composer one");
    const two = screen.getByLabelText("Composer two");
    await expect.element(two).toHaveAttribute("data-inactive", "true");

    await userEvent.click(two);

    await expect.element(two).toHaveAttribute("data-inactive", "false");
    await expect.element(one).toHaveAttribute("data-inactive", "true");
  });

  it("gives the keyboard to the pane that focus tabs into", async () => {
    using _state = setup(twoPanes, "a");
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
      { container: wideContainer() },
    );
    const two = screen.getByLabelText("Composer two");
    await expect.element(two).toHaveAttribute("data-inactive", "true");

    two.element().focus();

    await expect.element(two).toHaveAttribute("data-inactive", "false");
  });

  it("moves focus when the route names the other pane's conversation", async () => {
    using _state = setup(twoPanes, "a");
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
    );

    await screen.rerender(<SplitWorkspace routeTarget={target("two")} background={false} />);

    await expect
      .element(screen.getByLabelText("Composer two"))
      .toHaveAttribute("data-inactive", "false");
  });

  it("keeps the first pane mounted while splitting and closing", async () => {
    using _state = setup([], null);
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
      { container: wideContainer() },
    );
    await expect.element(screen.getByLabelText("Composer one")).toBeInTheDocument();
    expect(mounted.count).toBe(1);

    useSplitViewStore.setState({
      panes: [
        { id: "primary", target: target("one") },
        { id: "b", target: target("two") },
      ],
      focusedPaneId: "primary",
      sizes: [0.5, 0.5],
    });
    await expect.element(screen.getByLabelText("Composer two")).toBeInTheDocument();
    expect(mounted.count).toBe(2);

    await userEvent.click(screen.getByRole("button", { name: "Close New conversation" }).last());
    await expect.element(screen.getByLabelText("Composer two")).not.toBeInTheDocument();
    expect(mounted.count).toBe(2);
  });

  it("renders a pane that does not fit as a rail, unmounting its conversation", async () => {
    using _state = setup(twoPanes, "a");
    const container = document.createElement("div");
    container.style.width = "400px";
    await using screen = await render(
      <SplitWorkspace routeTarget={target("one")} background={false} />,
      { container },
    );
    await expect.element(screen.getByLabelText("Composer one")).toBeInTheDocument();
    await expect.element(screen.getByLabelText("Composer two")).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Expand Conversation" }))
      .toBeInTheDocument();
  });
});
