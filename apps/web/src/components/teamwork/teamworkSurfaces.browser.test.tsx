import {
  EnvironmentId,
  TeamGrowthRequestId,
  TeamRunId,
  TeamSheetId,
  TeamworkError,
  ThreadId,
  type ScopedThreadRef,
  type TeamRun,
  type TeamSheet,
} from "@t3tools/contracts";
import { DEFAULT_TEAM_SHEET } from "@t3tools/shared/teamSheets";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TeamSheetEditor } from "./TeamSheetEditor";
import { TeamworkPanel } from "./TeamworkPanel";

const mocks = vi.hoisted(() => ({
  sheet: null as unknown,
  runs: [] as ReadonlyArray<unknown>,
  commands: new Map<string, (value: unknown) => Promise<unknown>>(),
  refresh: (() => undefined) as () => void,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: ((atom: unknown) => (atom === "providers" ? [] : true)) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => ({})) as never,
}));
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: new Proxy(
    {},
    {
      get: (_, name: string) =>
        Object.assign((input: unknown) => ({ name, input }), {
          label: name,
          permissionAtom: () => name,
        }),
    },
  ) as never,
  providersIgnoringCheckedAtAtom: (() => "providers") as never,
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((atom: { name: string }) => ({
    data:
      atom.name === "teamSheet"
        ? mocks.sheet
        : atom.name === "teamworkList"
          ? { runs: mocks.runs }
          : atom.name === "teamRoster"
            ? { slots: [] }
            : null,
    error: null,
    refresh: mocks.refresh,
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label: string }) => (value: unknown) =>
    mocks.commands.get(command.label)?.(value) ?? Promise.resolve({ _tag: "Success" })) as never,
}));

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const editable: TeamSheet = {
  ...DEFAULT_TEAM_SHEET,
  id: TeamSheetId.make("mine"),
  builtIn: false,
  revision: 3,
};

function setup(sheet: TeamSheet, runs: ReadonlyArray<TeamRun> = []) {
  mocks.sheet = sheet;
  mocks.runs = runs;
  mocks.commands.clear();
  mocks.refresh = () => undefined;
}

const editor = (sheet: TeamSheet) => <TeamSheetEditor threadRef={threadRef} sheetId={sheet.id} />;

describe("team sheet editor", () => {
  it("opens the built-in default read-only with only Duplicate", async () => {
    setup(DEFAULT_TEAM_SHEET);
    await using screen = await render(editor(DEFAULT_TEAM_SHEET));
    await expect.element(screen.getByRole("button", { name: "Duplicate" })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Add team" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox")).not.toBeInTheDocument();
  });

  it("holds an unreachable team, then resends after a conflict on the newer revision", async () => {
    setup(editable);
    const sent: Array<{ baseRevision: number; changes: ReadonlyArray<{ type: string }> }> = [];
    let conflict = true;
    mocks.commands.set("updateTeamSheet", async (value) => {
      const { input } = value as { input: (typeof sent)[number] };
      sent.push(input);
      if (conflict) {
        conflict = false;
        return {
          _tag: "Failure",
          cause: Cause.fail(new TeamworkError({ reason: "revision_conflict", detail: "Stale." })),
        };
      }
      return { _tag: "Success", value: { ...editable, revision: 5 } };
    });
    await using screen = await render(editor(editable));

    await userEvent.click(screen.getByRole("button", { name: "Add team" }));
    await expect
      .element(screen.getByText("The Project Lead cannot reach Team 4. Not saved yet."))
      .toBeVisible();
    expect(sent).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Handoff to Project Lead" }));
    // Browser tests load no app CSS, so the unstyled inspector covers the absolute cards.
    (screen.getByRole("button", { name: /^Project Lead/ }).element() as HTMLElement).click();
    await userEvent.click(screen.getByRole("button", { name: "Handoff to Team 4" }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    mocks.sheet = { ...editable, revision: 4 };
    await screen.rerender(editor(editable));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]?.baseRevision).toBe(4);
    expect(sent[1]?.changes).toEqual(sent[0]?.changes);
  });
});

describe("run board", () => {
  it("answers a pending growth request from the owner", async () => {
    const run = {
      id: TeamRunId.make("run"),
      parentThreadId: threadRef.threadId,
      sheetId: editable.id,
      flow: { sheetName: "Mine", nodes: editable.nodes, edges: editable.edges },
      request: "Ship it",
      budget: { maxCorrectionCycles: 3 },
      status: "awaiting_owner",
      activeNodeId: null,
      waitingFor: null,
      correctionCycles: 0,
      members: [],
      tasks: [],
      notes: [],
      evidence: [],
      verdicts: [],
      report: null,
      startedAt: "2026-11-02T00:00:00.000Z",
      growth: [
        {
          id: TeamGrowthRequestId.make("growth"),
          capacity: "One more reviewer",
          why: "Too much to read",
          status: "awaiting_owner",
          decidedBy: null,
          reason: null,
        },
      ],
    } as unknown as TeamRun;
    setup(editable, [run]);
    const act = vi.fn(async () => ({ _tag: "Success" }));
    mocks.commands.set("actTeamwork", act);
    await using screen = await render(<TeamworkPanel threadRef={threadRef} />);

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(act).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        runId: run.id,
        action: { type: "owner_growth_answer", requestId: "growth", allow: false },
      },
    });
  });
});
