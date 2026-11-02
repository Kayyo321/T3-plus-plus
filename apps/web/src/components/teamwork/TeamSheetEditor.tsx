import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  TeamNodeId,
  TeamworkError,
  type ScopedThreadRef,
  type TeamNodePosition,
  type TeamSheet,
  type TeamSheetChange,
  type TeamSheetEdge,
  type TeamSheetId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { randomUUID } from "~/lib/utils";

import { readLocalApi } from "../../localApi";
import { useRightPanelStore } from "../../rightPanelStore";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { openTeamSheetEditor } from "./openTeamSheetEditor";
import { TeamSheetCanvas, type TeamMenuPoint } from "./TeamSheetCanvas";
import { TeamSheetInspector } from "./TeamSheetInspector";
import { teamNodeMenu } from "./teamSheetMenu";
import {
  addTeamSheetChange,
  newestTeamSheet,
  NO_TEAM_SHEET_EDITS,
  settleTeamSheetConflict,
  settleTeamSheetFailure,
  settleTeamSheetSave,
  teamSheetChangesToSend,
  teamSheetDraft,
  teamSheetEditProblem,
} from "./teamSheetEdits";

const CARD_ROW = 120;
const isTeamworkError = Schema.is(TeamworkError);

const newTeamName = (sheet: TeamSheet) => {
  const taken = new Set(sheet.nodes.map((node) => node.name.toLocaleLowerCase()));
  let index = sheet.nodes.length;
  while (taken.has(`team ${index}`)) index += 1;
  return `Team ${index}`;
};

function TeamSheetBody(props: {
  readonly threadRef: ScopedThreadRef;
  readonly server: TeamSheet;
  readonly onSaved: (sheet: TeamSheet) => void;
  readonly onStale: () => void;
}) {
  const { threadRef, server } = props;
  const { environmentId } = threadRef;
  const save = useAtomCommand(serverEnvironment.updateTeamSheet, { reportFailure: false });
  const duplicate = useAtomCommand(serverEnvironment.duplicateTeamSheet);
  const remove = useAtomCommand(serverEnvironment.deleteTeamSheet);
  const canEdit = useAtomValue(serverEnvironment.updateTeamSheet.permissionAtom(environmentId));
  const canDuplicate = useAtomValue(
    serverEnvironment.duplicateTeamSheet.permissionAtom(environmentId),
  );
  const closeSurface = useRightPanelStore((state) => state.closeSurface);
  const [edits, setEdits] = useState(NO_TEAM_SHEET_EDITS);
  const [selectedIds, setSelectedIds] = useState<ReadonlyArray<TeamNodeId>>([]);
  const nameInput = useRef<HTMLInputElement>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const saving = useRef(false);

  const readOnly = server.builtIn || !canEdit;
  const draft = teamSheetDraft(server, edits);
  const problem = teamSheetEditProblem(server, edits);
  const toSend = teamSheetChangesToSend(server, edits);
  const liveSelection = draft.nodes.filter((node) => selectedIds.includes(node.id));
  const selected = liveSelection.length > 1 ? null : (liveSelection[0] ?? draft.nodes[0] ?? null);

  const { onSaved, onStale } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- saving talks to the server, and a re-read as well as an edit can make pending changes sendable.
  useEffect(() => {
    if (toSend === null || saving.current) return;
    saving.current = true;
    void save({
      environmentId,
      input: { sheetId: server.id, baseRevision: server.revision, changes: toSend },
    }).then((result) => {
      saving.current = false;
      if (result._tag === "Success") {
        onSaved(result.value);
        setEdits((current) => settleTeamSheetSave(current, toSend));
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (isTeamworkError(failure) && failure.reason === "revision_conflict") {
        setEdits((current) => settleTeamSheetConflict(current, server.revision));
        onStale();
        return;
      }
      const message = failure instanceof Error ? failure.message : "The sheet could not be saved.";
      setEdits((current) => settleTeamSheetFailure(current, message));
    });
  }, [environmentId, onSaved, onStale, save, server.id, server.revision, toSend]);

  const change = (next: TeamSheetChange) =>
    setEdits((current) => addTeamSheetChange(current, next));

  const move = (moved: ReadonlyMap<TeamNodeId, TeamNodePosition>) => {
    for (const [nodeId, position] of moved) change({ type: "update_node", nodeId, position });
  };

  const addTeam = (position?: TeamNodePosition) => {
    const id = TeamNodeId.make(randomUUID());
    const lowest = Math.max(...draft.nodes.map((node) => node.position.y));
    change({
      type: "add_node",
      node: {
        id,
        kind: "build",
        name: newTeamName(draft),
        instructions: "",
        position: position ?? { x: 40, y: lowest + CARD_ROW },
        modelChoice: { type: "lead" },
      },
    });
    setSelectedIds([id]);
  };

  const openNodeMenu = async (nodeId: TeamNodeId, point: TeamMenuPoint) => {
    const { items, actions } = teamNodeMenu(draft, nodeId);
    const picked = await readLocalApi()?.contextMenu.show(items, point);
    const action = picked ? actions.get(picked) : undefined;
    if (action === undefined) return;
    if (action.type !== "rename") {
      change(action);
      return;
    }
    flushSync(() => setSelectedIds([nodeId]));
    nameInput.current?.select();
  };

  const openCanvasMenu = async (position: TeamNodePosition, point: TeamMenuPoint) => {
    const picked = await readLocalApi()?.contextMenu.show(
      [{ id: "create", label: "Create team" }],
      point,
    );
    if (picked === "create") addTeam(position);
  };

  const openEdgeMenu = async (edge: TeamSheetEdge, point: TeamMenuPoint) => {
    const picked = await readLocalApi()?.contextMenu.show(
      [{ id: "delete", label: "Delete connection", destructive: true }],
      point,
    );
    if (picked === "delete") change({ type: "disconnect", edge });
  };

  const duplicateSheet = async () => {
    const result = await duplicate({ environmentId, input: { sheetId: server.id } });
    if (result._tag === "Success") openTeamSheetEditor(threadRef, result.value.id);
  };

  const deleteSheet = async () => {
    const result = await remove({
      environmentId,
      input: { sheetId: server.id, baseRevision: server.revision },
    });
    if (result._tag === "Success") closeSurface(threadRef, `team-sheet:${server.id}`);
  };

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        {readOnly ? (
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{draft.name}</h2>
        ) : (
          <div className="min-w-40 flex-1">
            <Input
              key={draft.name}
              size="sm"
              aria-label="Sheet name"
              defaultValue={draft.name}
              maxLength={80}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name !== "" && name !== draft.name) change({ type: "rename", name });
                else event.target.value = draft.name;
              }}
            />
          </div>
        )}
        {readOnly ? null : (
          <>
            <label className="flex items-center gap-1.5 text-xs">
              <Switch
                size="sm"
                checked={draft.nestedSessions}
                onCheckedChange={(enabled) => change({ type: "set_nested_sessions", enabled })}
              />
              Run agents as nested sessions
            </label>
            <Button size="xs" variant="outline" onClick={() => addTeam()}>
              Add team
            </Button>
          </>
        )}
        {canDuplicate ? (
          <Button size="xs" variant="outline" onClick={() => void duplicateSheet()}>
            Duplicate
          </Button>
        ) : null}
        {readOnly ? null : (
          <>
            <Button size="xs" variant="ghost-destructive" onClick={() => setConfirmingDelete(true)}>
              Delete
            </Button>
            <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {draft.name}?</AlertDialogTitle>
                  <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
                  <AlertDialogClose
                    render={<Button variant="destructive" />}
                    onClick={() => void deleteSheet()}
                  >
                    Delete
                  </AlertDialogClose>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>
          </>
        )}
      </div>
      {problem !== null && !readOnly ? (
        <div
          className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs"
          role="alert"
        >
          <p className="min-w-0 flex-1">{problem} Not saved yet.</p>
          <Button size="xs" variant="ghost" onClick={() => setEdits(NO_TEAM_SHEET_EDITS)}>
            Discard
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col @2xl:flex-row">
        <TeamSheetCanvas
          key={readOnly ? "read-only" : "editable"}
          sheet={draft}
          selectedNodeIds={selected === null ? liveSelection.map((node) => node.id) : [selected.id]}
          readOnly={readOnly}
          onSelect={(nodeId) => setSelectedIds([nodeId])}
          onSelectMany={setSelectedIds}
          onMove={move}
          onNodeMenu={(nodeId, point) => void openNodeMenu(nodeId, point)}
          onCanvasMenu={(position, point) => void openCanvasMenu(position, point)}
          onEdgeMenu={(edge, point) => void openEdgeMenu(edge, point)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border @2xl:w-80 @2xl:flex-none @2xl:border-t-0 @2xl:border-s">
          {selected === null ? null : readOnly ? (
            <div className="flex flex-col gap-1 p-3 text-xs">
              <h3 className="font-medium">{selected.name}</h3>
              <p className="whitespace-pre-wrap text-muted-foreground">{selected.instructions}</p>
            </div>
          ) : (
            <TeamSheetInspector
              environmentId={environmentId}
              sheet={draft}
              node={selected}
              nameInputRef={nameInput}
              onChange={change}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function TeamSheetEditor(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sheetId: TeamSheetId;
}) {
  const { environmentId } = props.threadRef;
  const sheet = useEnvironmentQuery(
    serverEnvironment.teamSheet({ environmentId, input: { sheetId: props.sheetId } }),
  );
  const changed = useEnvironmentQuery(
    serverEnvironment.teamworkChanges({ environmentId, input: {} }),
  );
  const [saved, setSaved] = useState<TeamSheet | null>(null);
  const { refresh } = sheet;
  const latest = changed.data;
  // A deleted sheet has no revision, and re-reading it is how the editor learns it is gone.
  const changedRevision =
    latest?.type === "sheet" && latest.sheetId === props.sheetId ? (latest.revision ?? -1) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server stream is the outside system; orchestrator edits re-read the sheet.
  useEffect(() => {
    if (changedRevision !== null) refresh();
  }, [changedRevision, refresh]);

  if (sheet.data === null) {
    return <p className="p-3 text-xs text-muted-foreground">{sheet.error ?? "Loading sheet"}</p>;
  }
  return (
    <TeamSheetBody
      threadRef={props.threadRef}
      server={newestTeamSheet(sheet.data, saved)}
      onSaved={setSaved}
      onStale={refresh}
    />
  );
}
