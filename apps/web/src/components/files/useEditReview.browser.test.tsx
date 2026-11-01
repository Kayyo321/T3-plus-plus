import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { useEditReviewStore } from "./agentEditReview";
import { EditReviewAnnotation, EditReviewBar } from "./EditReviewControls";
import { useEditReview } from "./useEditReview";

// A file with no checkpoints: every baseline here comes from a live change.
vi.mock("~/state/entities", () => ({ useThreadCheckpointSummaries: () => [] }));
vi.mock("~/state/queries", () => ({ useCheckpointDiff: () => ({ data: null }) }));

const lines = (...entries: string[]) => entries.map((entry) => `${entry}\n`).join("");
const original = lines("one", "two", "three", "four", "five", "six");
const agentEdit = lines("one", "TWO", "three", "four", "five", "SIX");

function Surface() {
  const [contents, setContents] = useState(original);
  const review = useEditReview({
    enabled: true,
    environmentId: EnvironmentId.make("env"),
    threadRef: scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread")),
    cwd: "/repo",
    relativePath: "a.ts",
    contents,
    localContents: null,
    onChange: setContents,
  });
  return (
    <div>
      <button type="button" onClick={() => setContents(agentEdit)}>
        Agent edits
      </button>
      <pre data-testid="file">{contents}</pre>
      {review.hunks.length > 0 ? (
        <EditReviewBar
          hunkCount={review.hunks.length}
          onAcceptAll={review.acceptAll}
          onRevertAll={review.revertAll}
        />
      ) : null}
      {review.hunks.map((hunk) => (
        <EditReviewAnnotation
          key={hunk.anchorLine}
          hunk={hunk}
          onAccept={review.accept}
          onRevert={review.revert}
        />
      ))}
    </div>
  );
}

const setup = () => {
  useEditReviewStore.setState({ baselines: {}, reviewedTurns: {} });
  return {
    [Symbol.dispose]: () => useEditReviewStore.setState({ baselines: {}, reviewedTurns: {} }),
  };
};

describe("useEditReview", () => {
  it("offers each agent change for review as it lands", async () => {
    using _state = setup();
    await using screen = await render(<Surface />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Agent edits" }));
    await expect.element(screen.getByText("2 changes to review")).toBeInTheDocument();
  });

  it("reverts one hunk and leaves the other under review", async () => {
    using _state = setup();
    await using screen = await render(<Surface />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Agent edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Revert", exact: true }).first());

    await expect.element(screen.getByText("1 change to review")).toBeInTheDocument();
    expect(screen.getByTestId("file").element().textContent).toBe(
      lines("one", "two", "three", "four", "five", "SIX"),
    );
  });

  it("accepts one hunk without touching the file", async () => {
    using _state = setup();
    await using screen = await render(<Surface />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Agent edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept", exact: true }).first());

    await expect.element(screen.getByText("1 change to review")).toBeInTheDocument();
    expect(screen.getByTestId("file").element().textContent).toBe(agentEdit);
  });

  it("ends the review when the last hunk is decided", async () => {
    using _state = setup();
    await using screen = await render(<Surface />, { router: false });
    await userEvent.click(screen.getByRole("button", { name: "Agent edits" }));
    await userEvent.click(screen.getByRole("button", { name: "Accept all" }));

    await expect.element(screen.getByText("2 changes to review")).not.toBeInTheDocument();
    expect(useEditReviewStore.getState().baselines).toEqual({});
  });
});
