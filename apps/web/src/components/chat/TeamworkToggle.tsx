import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_TEAM_SHEET_ID,
  type ScopedThreadRef,
  type TeamSheetId,
  type ThreadCapabilityMode,
} from "@t3tools/contracts";
import { PencilIcon, PlusIcon } from "lucide-react";
import { useEffect } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { useOrchestratorDock } from "~/state/orchestratorAgent";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { TeamworkIcon } from "../Icons";
import { openTeamSheetEditor } from "../teamwork/openTeamSheetEditor";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

const OFF_VALUE = "off";

function reportTeamworkFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useTeamSheetActions() {
  const setThreadTeamSheet = useAtomCommand(serverEnvironment.setThreadTeamSheet, {
    label: "set thread team sheet",
    reportFailure: false,
  });
  const createTeamSheet = useAtomCommand(serverEnvironment.createTeamSheet, {
    label: "create team sheet",
    reportFailure: false,
  });

  const enableSheet = async (threadRef: ScopedThreadRef, sheetId: TeamSheetId | null) => {
    const { environmentId, threadId } = threadRef;
    const result = await setThreadTeamSheet({ environmentId, input: { threadId, sheetId } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportTeamworkFailure("Could not change teamwork", squashAtomCommandFailure(result));
    }
  };

  const createSheet = async (threadRef: ScopedThreadRef) => {
    const result = await createTeamSheet({
      environmentId: threadRef.environmentId,
      input: { name: "New sheet" },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportTeamworkFailure("Could not create the sheet", squashAtomCommandFailure(result));
      }
      return;
    }
    openTeamSheetEditor(threadRef, result.value.id);
    useOrchestratorDock.getState().setOpen(true);
    await enableSheet(threadRef, result.value.id);
  };

  return { enableSheet, createSheet };
}

function TeamworkToggleControl({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = threadRef;
  const composerMenuProps = useComposerMenuProps();
  const threadSheet = useEnvironmentQuery(
    serverEnvironment.threadTeamSheet({ environmentId, input: { threadId } }),
  );
  const sheets = useEnvironmentQuery(serverEnvironment.teamSheets({ environmentId, input: {} }));
  const changes = useEnvironmentQuery(
    serverEnvironment.teamworkChanges({ environmentId, input: {} }),
  );
  const canSet = useAtomValue(serverEnvironment.setThreadTeamSheet.permissionAtom(environmentId));
  const canCreate = useAtomValue(serverEnvironment.createTeamSheet.permissionAtom(environmentId));
  const { enableSheet, createSheet } = useTeamSheetActions();

  const change = changes.data;
  const refreshThreadSheet = threadSheet.refresh;
  const refreshSheets = sheets.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server stream is the outside system; a change re-reads only what it touched.
  useEffect(() => {
    if (change === null) return;
    if (change.type === "sheet") {
      refreshThreadSheet();
      refreshSheets();
    } else if (change.type === "thread" && change.threadId === threadId) {
      refreshThreadSheet();
    }
  }, [change, threadId, refreshThreadSheet, refreshSheets]);

  const sheetId = threadSheet.data?.sheetId ?? null;
  const sheetName = threadSheet.data?.sheetName ?? null;
  const label = sheetName ?? "Teamwork";
  const savedSheets = (sheets.data?.sheets ?? []).filter((sheet) => !sheet.builtIn);

  const sheetRow = (id: TeamSheetId, name: string) => (
    <div key={id} className="flex items-center gap-0.5">
      <MenuRadioItem value={id} disabled={!canSet} closeOnClick className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
      </MenuRadioItem>
      <MenuItem aria-label={`Edit ${name}`} onClick={() => openTeamSheetEditor(threadRef, id)}>
        <PencilIcon className="size-3" aria-hidden="true" />
      </MenuItem>
    </div>
  );

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<ComposerControl size="xs" className="shrink-0" />}
              aria-label={label}
              aria-pressed={sheetId !== null}
              data-composer-context-control
            />
          }
        >
          <TeamworkIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="top" className="w-56" {...composerMenuProps}>
        <MenuGroup>
          <MenuRadioGroup
            value={sheetId ?? OFF_VALUE}
            onValueChange={(value: string) => {
              void enableSheet(threadRef, value === OFF_VALUE ? null : (value as TeamSheetId)).then(
                refreshThreadSheet,
              );
            }}
          >
            <MenuRadioItem value={OFF_VALUE} disabled={!canSet} closeOnClick>
              Off
            </MenuRadioItem>
            {sheetRow(DEFAULT_TEAM_SHEET_ID, "Default teamwork")}
            {savedSheets.map((sheet) => sheetRow(sheet.id, sheet.name))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          disabled={!canSet || !canCreate}
          onClick={() => void createSheet(threadRef).then(refreshThreadSheet)}
        >
          <PlusIcon className="size-3" aria-hidden="true" />
          Create new sheet
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Code mode only. A draft's choice waits on the server under the id its thread will take. */
export function TeamworkToggle(props: {
  readonly threadRef: ScopedThreadRef;
  readonly capabilityMode: ThreadCapabilityMode;
}) {
  if (props.capabilityMode === "chat") return null;
  return <TeamworkToggleControl threadRef={props.threadRef} />;
}
