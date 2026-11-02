import { useAtomValue } from "@effect/atom-react";
import {
  buildConversationFolderRows,
  type ConversationFolderRow,
  emptyConversationFolderState,
} from "@t3tools/client-runtime/state/conversationFolders";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ConversationFolder,
  type ConversationFolderId,
  type ConversationSmartFilter,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { LegendList } from "@legendapp/list/react";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  InboxIcon,
  MoreHorizontalIcon,
  SparklesIcon,
} from "lucide-react";
import {
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useState,
} from "react";

import {
  conversationFolderCollapseKey,
  useConversationFolderViewStore,
} from "../../conversationFolderViewStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

const FOLDER_ROW_HEIGHT = 30;
const THREADS_DRAG_TYPE = "application/x-t3pp-thread-ids";
const FOLDER_DRAG_TYPE = "application/x-t3pp-folder-id";

const SMART_FOLDER_PRESETS: ReadonlyArray<{
  readonly name: string;
  readonly filter: ConversationSmartFilter;
}> = [
  { name: "Running", filter: { statuses: ["running"] } },
  { name: "Needs input", filter: { statuses: ["needs-input"] } },
  { name: "This week", filter: { updatedWithinDays: 7 } },
];

type FolderDialog =
  | { readonly kind: "create"; readonly parentId: ConversationFolderId | null }
  | { readonly kind: "rename"; readonly folder: ConversationFolder };

const isThreadRunning = (thread: EnvironmentThreadShell) =>
  thread.runtime?.activeRunId != null ||
  thread.runtime?.status === "running" ||
  thread.runtime?.status === "starting";

const readDroppedThreadIds = (event: ReactDragEvent) => {
  const raw = event.dataTransfer.getData(THREADS_DRAG_TYPE);
  return raw === "" ? [] : raw.split("\n").map((threadId) => ThreadId.make(threadId));
};

/**
 * A thread's row in the tree. `children` replaces the default body, so a caller that nests child
 * sessions under a row (or shows a richer row) keeps the indent, drag and selection behaviour.
 */
function ConversationFolderThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly depth: number;
  readonly active: boolean;
  readonly selected: boolean;
  readonly onOpen: (event: ReactMouseEvent) => void;
  readonly onDragStart: (event: ReactDragEvent) => void;
  readonly children?: ReactNode;
}) {
  const { thread } = props;
  const needsInput = thread.hasPendingApprovals || thread.hasPendingUserInput;
  return (
    <button
      type="button"
      draggable
      onDragStart={props.onDragStart}
      onClick={props.onOpen}
      aria-current={props.active ? "page" : undefined}
      style={{ paddingLeft: 10 + props.depth * 12 }}
      className={cn(
        "flex h-[30px] w-full min-w-0 cursor-pointer items-center gap-2 rounded-md pr-2 text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        props.active || props.selected
          ? "bg-sidebar-row-active text-sidebar-foreground"
          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      {props.children ?? (
        <>
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {needsInput ? (
            <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-label="Needs input" />
          ) : isThreadRunning(thread) ? (
            <span className="size-1.5 shrink-0 rounded-full bg-success" aria-label="Running" />
          ) : null}
        </>
      )}
    </button>
  );
}

function FolderHeaderRow(props: {
  readonly label: string;
  readonly count: number;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly smart: boolean;
  readonly unfiled: boolean;
  readonly onToggle: () => void;
  readonly onDropThreads: ((event: ReactDragEvent) => void) | null;
  readonly onDragStart: ((event: ReactDragEvent) => void) | null;
  readonly actions: ReactNode;
}) {
  const [dropTarget, setDropTarget] = useState(false);
  const { onDropThreads } = props;
  return (
    <div
      role="presentation"
      className={cn(
        "group/folder relative flex h-[30px] min-w-0 items-center rounded-md hover:bg-sidebar-row-hover",
        dropTarget && "ring-1 ring-inset ring-primary/70",
      )}
      style={{ paddingLeft: props.depth * 12 }}
      onDragOver={
        onDropThreads === null
          ? undefined
          : (event) => {
              event.preventDefault();
              setDropTarget(true);
            }
      }
      onDragLeave={() => setDropTarget(false)}
      onDrop={
        onDropThreads === null
          ? undefined
          : (event) => {
              event.preventDefault();
              setDropTarget(false);
              onDropThreads(event);
            }
      }
    >
      <button
        type="button"
        draggable={props.onDragStart !== null}
        onDragStart={props.onDragStart ?? undefined}
        onClick={props.onToggle}
        aria-expanded={!props.collapsed}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left text-sm text-sidebar-foreground outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-sidebar-muted-foreground",
            !props.collapsed && "rotate-90",
          )}
        />
        {props.smart ? (
          <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        ) : props.unfiled ? (
          <InboxIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        ) : (
          <FolderIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span
          className={cn(
            "shrink-0 pr-2 text-xs text-sidebar-muted-foreground/70 tabular-nums",
            props.actions !== null &&
              "group-focus-within/folder:invisible group-hover/folder:invisible",
          )}
        >
          {props.count}
        </span>
      </button>
      {props.actions === null ? null : (
        <span className="absolute inset-y-0 right-0.5 flex items-center">{props.actions}</span>
      )}
    </div>
  );
}

function FolderNameDialog(props: {
  readonly dialog: FolderDialog | null;
  readonly onClose: () => void;
  readonly onSubmit: (dialog: FolderDialog, name: string) => void;
}) {
  const { dialog } = props;
  const initial = dialog?.kind === "rename" ? dialog.folder.name : "";
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
            if (dialog !== null && name.length > 0) props.onSubmit(dialog, name);
          }}
        >
          <DialogHeader>
            <DialogTitle>{dialog?.kind === "rename" ? "Rename folder" : "New folder"}</DialogTitle>
            <DialogDescription>Folders hold conversations from any project.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              key={initial}
              name="name"
              defaultValue={initial}
              maxLength={80}
              autoFocus
              aria-label="Folder name"
            />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit">{dialog?.kind === "rename" ? "Rename" : "Create"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * The folder tree, virtualized: thousands of rows mount a screenful of DOM. `renderThreadRow`
 * replaces a row's body for callers that want to compose one; it receives the same flat row.
 */
/** The sidebar header's way to add folders, beside search so the tree keeps its full height. */
export function SidebarFolderActions(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const canOrganize = useAtomValue(
    serverEnvironment.mutateConversationFolders.permissionAtom(environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateConversationFolders, {
    label: "conversation folder change",
  });
  const [dialog, setDialog] = useState<FolderDialog | null>(null);
  if (!canOrganize) return null;
  return (
    <>
      <SidebarHeaderIconButton
        label="New folder"
        onClick={() => setDialog({ kind: "create", parentId: null })}
      >
        <FolderPlusIcon />
      </SidebarHeaderIconButton>
      <Menu>
        <MenuTrigger render={<SidebarHeaderIconButton label="Smart folder" />}>
          <SparklesIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {SMART_FOLDER_PRESETS.map((preset) => (
            <MenuItem
              key={preset.name}
              onClick={() =>
                void mutate({
                  environmentId,
                  input: {
                    type: "create",
                    name: preset.name as never,
                    parentId: null,
                    smartFilter: preset.filter,
                  },
                })
              }
            >
              {preset.name}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <FolderNameDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onSubmit={async (_current, name) => {
          const result = await mutate({
            environmentId,
            input: { type: "create", name: name as never, parentId: null },
          });
          if (result._tag === "Success") setDialog(null);
        }}
      />
    </>
  );
}

export function SidebarConversationFolders(props: {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly activeThreadKey: string | null;
  readonly onOpenThread: (thread: EnvironmentThreadShell) => void;
  readonly renderThreadRow?: (
    row: Extract<ConversationFolderRow<EnvironmentThreadShell>, { kind: "thread" }>,
  ) => ReactNode;
}) {
  const { environmentId } = props;
  const folderState = useEnvironmentQuery(
    serverEnvironment.conversationFoldersLive({ environmentId, input: {} }),
  ).data;
  const collapsedKeys = useConversationFolderViewStore((state) => state.collapsedKeys);
  const toggleCollapsed = useConversationFolderViewStore((state) => state.toggleCollapsed);
  const selectedThreadKeys = useThreadSelectionStore((state) => state.selectedThreadKeys);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const canOrganize = useAtomValue(
    serverEnvironment.mutateConversationFolders.permissionAtom(environmentId),
  );
  const mutate = useAtomCommand(serverEnvironment.mutateConversationFolders, {
    label: "conversation folder change",
  });
  const [dialog, setDialog] = useState<FolderDialog | null>(null);
  // Smart folders follow the clock, but a minute is close enough for "this week".
  const nowMinute = useNowMinute();

  const rows = buildConversationFolderRows({
    state: folderState ?? emptyConversationFolderState,
    threads: props.threads.map((thread) => ({ ...thread, running: isThreadRunning(thread) })),
    isCollapsed: (key) => collapsedKeys[key] === true,
    nowMs: Date.parse(nowMinute),
  });

  const run = (input: Parameters<typeof mutate>[0]["input"]) => mutate({ environmentId, input });

  const moveThreads = (
    threadIds: ReadonlyArray<EnvironmentThreadShell["id"]>,
    folderId: ConversationFolderId | null,
  ) => {
    if (threadIds.length > 0) void run({ type: "move-threads", threadIds, folderId });
  };

  const dropOnto = (folderId: ConversationFolderId | null) => (event: ReactDragEvent) => {
    const movedFolder = event.dataTransfer.getData(FOLDER_DRAG_TYPE);
    if (movedFolder !== "") {
      if (movedFolder !== folderId) {
        void run({ type: "move", id: movedFolder as ConversationFolderId, parentId: folderId });
      }
      return;
    }
    moveThreads(readDroppedThreadIds(event), folderId);
  };

  const startThreadDrag = (thread: EnvironmentThreadShell) => (event: ReactDragEvent) => {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    // Dragging one selected row carries the whole selection: this is the bulk move.
    const ids = selectedThreadKeys.has(key)
      ? props.threads
          .filter((candidate) =>
            selectedThreadKeys.has(
              scopedThreadKey(scopeThreadRef(candidate.environmentId, candidate.id)),
            ),
          )
          .map((candidate) => candidate.id)
      : [thread.id];
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(THREADS_DRAG_TYPE, ids.join("\n"));
  };

  const removeFolder = async (folder: ConversationFolder) => {
    const result = await run({ type: "delete", id: folder.id });
    if (result._tag !== "Success") return;
    const id = toastManager.add({
      title: `Deleted ${folder.name}`,
      description: "Its conversations are unfiled, not deleted.",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void run({ type: "restore", id: folder.id });
        },
      },
    });
  };

  const submitDialog = async (current: FolderDialog, name: string) => {
    const result = await run(
      current.kind === "create"
        ? { type: "create", name: name as never, parentId: current.parentId }
        : { type: "rename", id: current.folder.id, name: name as never },
    );
    if (result._tag === "Success") setDialog(null);
  };

  const folderMenu = (folder: ConversationFolder) =>
    canOrganize ? (
      <span className="opacity-0 group-hover/folder:opacity-100 focus-within:opacity-100">
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label={`${folder.name} actions`} />}
          >
            <MoreHorizontalIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {folder.smartFilter === undefined ? (
              <MenuItem onClick={() => setDialog({ kind: "create", parentId: folder.id })}>
                New subfolder
              </MenuItem>
            ) : null}
            <MenuItem onClick={() => setDialog({ kind: "rename", folder })}>Rename</MenuItem>
            <MenuItem onClick={() => void removeFolder(folder)}>Delete folder</MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LegendList<ConversationFolderRow<EnvironmentThreadShell>>
        className="min-h-0 flex-1"
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        estimatedItemSize={FOLDER_ROW_HEIGHT}
        extraData={[props.activeThreadKey, selectedThreadKeys]}
        recycleItems
        renderItem={({ item: row }) => {
          if (row.kind === "unfiled") {
            return (
              <FolderHeaderRow
                label="Unfiled"
                count={row.count}
                depth={0}
                collapsed={collapsedKeys[row.key] === true}
                smart={false}
                unfiled
                onToggle={() => toggleCollapsed(conversationFolderCollapseKey(null))}
                onDropThreads={canOrganize ? dropOnto(null) : null}
                onDragStart={null}
                actions={null}
              />
            );
          }
          if (row.kind === "folder") {
            const { folder } = row;
            const smart = folder.smartFilter !== undefined;
            return (
              <FolderHeaderRow
                label={folder.name}
                count={row.count}
                depth={row.depth}
                collapsed={row.collapsed}
                smart={smart}
                unfiled={false}
                onToggle={() => toggleCollapsed(conversationFolderCollapseKey(folder.id))}
                onDropThreads={canOrganize && !smart ? dropOnto(folder.id) : null}
                onDragStart={
                  canOrganize
                    ? (event) => event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id)
                    : null
                }
                actions={folderMenu(folder)}
              />
            );
          }
          const { thread } = row;
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <ConversationFolderThreadRow
              thread={thread}
              depth={row.depth}
              active={threadKey === props.activeThreadKey}
              selected={selectedThreadKeys.has(threadKey)}
              onDragStart={startThreadDrag(thread)}
              onOpen={(event) => {
                if (event.metaKey || event.ctrlKey) toggleThreadSelection(threadKey);
                else props.onOpenThread(thread);
              }}
            >
              {props.renderThreadRow?.(row)}
            </ConversationFolderThreadRow>
          );
        }}
      />
      <FolderNameDialog
        dialog={dialog}
        onClose={() => setDialog(null)}
        onSubmit={(current, name) => void submitDialog(current, name)}
      />
    </div>
  );
}
