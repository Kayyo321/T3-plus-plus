import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, TeamSheetId, ThreadId, type TeamSheet } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { AsyncResult, Atom } from "effect/reactivity";

import { render } from "../../../test/render";
import { TeamworkToggle } from "./TeamworkToggle";

const mocks = vi.hoisted(() => ({
  setThreadTeamSheet: vi.fn(),
  openTeamSheetEditor: vi.fn(),
}));

vi.mock("../teamwork/openTeamSheetEditor", () => ({
  openTeamSheetEditor: mocks.openTeamSheetEditor,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mocks.setThreadTeamSheet,
}));

vi.mock("~/state/server", () => {
  const allowed = () => Atom.make(true);
  return {
    serverEnvironment: {
      threadTeamSheet: () =>
        Atom.make(AsyncResult.success({ threadId: "thread", sheetId: null, sheetName: null })),
      teamSheets: () =>
        Atom.make(
          AsyncResult.success({
            sheets: [
              { id: "default", name: "Default teamwork", builtIn: true },
              { id: "saved", name: "Release crew", builtIn: false },
            ] as unknown as ReadonlyArray<TeamSheet>,
          }),
        ),
      teamworkChanges: () => Atom.make(AsyncResult.initial(false)),
      setThreadTeamSheet: { permissionAtom: allowed },
      createTeamSheet: { permissionAtom: allowed },
    },
  };
});

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));

it("enables the chosen sheet and lists the built-in only as Default teamwork", async () => {
  mocks.setThreadTeamSheet.mockReset();
  mocks.setThreadTeamSheet.mockResolvedValue(AsyncResult.success({}));
  await using screen = await render(
    <TeamworkToggle threadRef={threadRef} capabilityMode="code" />,
    { router: false }, // no routes involved
  );
  await userEvent.click(screen.getByRole("button", { name: "Teamwork" }));
  await expect
    .element(page.getByRole("menuitemradio", { name: "Off" }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(page.getByRole("menuitemradio", { name: "Default teamwork" })).toBeVisible();
  await userEvent.click(page.getByRole("menuitemradio", { name: "Release crew" }));
  expect(mocks.setThreadTeamSheet).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId, sheetId: TeamSheetId.make("saved") },
  });
});

it("is hidden in chat mode", async () => {
  await using screen = await render(
    <TeamworkToggle threadRef={threadRef} capabilityMode="chat" />,
    { router: false }, // no routes involved
  );
  await expect.element(screen.getByRole("button", { name: "Teamwork" })).not.toBeInTheDocument();
});
