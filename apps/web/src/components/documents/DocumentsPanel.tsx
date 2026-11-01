import type {
  ConversationDocumentId,
  ConversationDocumentSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ArrowLeftIcon, DownloadIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatShortTimestamp } from "../../timestampFormat";
import { useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  type DocumentEditDraft,
  defaultDocumentPath,
  documentPathError,
  documentSaveFailure,
  documentSaveInput,
  isFileExistsError,
  partitionDocuments,
  resolveDocumentConflict,
  type DocumentSaveFailure,
} from "./conversationDocuments.logic";

function downloadMarkdown(fileName: string, markdown: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function DocumentVersions(props: {
  readonly threadRef: ScopedThreadRef;
  readonly documentId: ConversationDocumentId;
  readonly canEdit: boolean;
  readonly onRestored: () => void;
}) {
  const { environmentId } = props.threadRef;
  const { timestampFormat } = useClientSettings();
  const versions = useEnvironmentQuery(
    serverEnvironment.conversationDocumentVersions({
      environmentId,
      input: { id: props.documentId },
    }),
  );
  const restore = useAtomCommand(serverEnvironment.restoreConversationDocumentVersion);
  if (versions.data === null) {
    return <p className="text-xs text-muted-foreground">{versions.error ?? "Loading versions"}</p>;
  }
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {versions.data.versions.map((version) => (
        <li key={version.version} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            Version {version.version} · {version.createdBy === "agent" ? "Agent" : "You"} ·{" "}
            {formatShortTimestamp(version.createdAt, timestampFormat)}
          </span>
          {props.canEdit ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={async () => {
                const result = await restore({
                  environmentId,
                  input: { id: props.documentId, version: version.version },
                });
                if (result._tag === "Success") props.onRestored();
              }}
            >
              Restore
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function MoveToProject(props: {
  readonly threadRef: ScopedThreadRef;
  readonly documentId: ConversationDocumentId;
  readonly title: string;
  readonly cwd: string;
  readonly onClose: () => void;
}) {
  const move = useAtomCommand(serverEnvironment.moveConversationDocumentToProject, {
    reportFailure: false,
  });
  const [path, setPath] = useState(() => defaultDocumentPath(props.title));
  const [needsOverwrite, setNeedsOverwrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathError = documentPathError(path);
  const submit = async () => {
    const result = await move({
      environmentId: props.threadRef.environmentId,
      input: {
        id: props.documentId,
        cwd: props.cwd,
        relativePath: path.trim(),
        ...(needsOverwrite ? { overwrite: true } : {}),
      },
    });
    if (result._tag === "Success") return props.onClose();
    const failure = squashAtomCommandFailure(result);
    if (isFileExistsError(failure)) {
      setNeedsOverwrite(true);
      setError("A file already exists there.");
      return;
    }
    setError(documentSaveFailure(failure).kind === "error" ? String(failure) : null);
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2">
      <Input
        aria-label="Path inside the project"
        value={path}
        onChange={(event) => {
          setPath(event.target.value);
          setNeedsOverwrite(false);
        }}
      />
      {(pathError ?? error) ? (
        <p className="text-xs text-muted-foreground">{pathError ?? error}</p>
      ) : null}
      <div className="flex justify-end gap-1">
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          Cancel
        </Button>
        <Button size="xs" disabled={pathError !== null} onClick={submit}>
          {needsOverwrite ? "Overwrite" : "Copy to project"}
        </Button>
      </div>
    </div>
  );
}

function DocumentEditor(props: {
  readonly threadRef: ScopedThreadRef;
  readonly documentId: ConversationDocumentId;
  readonly projectCwd: string | null;
  readonly liveVersion: number | null;
  readonly onBack: () => void;
}) {
  const { environmentId } = props.threadRef;
  const { documentId } = props;
  const loaded = useEnvironmentQuery(
    serverEnvironment.conversationDocument({ environmentId, input: { id: documentId } }),
  );
  const canEdit = useAtomValue(
    serverEnvironment.updateConversationDocument.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateConversationDocument, {
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteConversationDocument);
  const exportDocument = useAtomCommand(serverEnvironment.exportConversationDocument);
  const [draft, setDraft] = useState<DocumentEditDraft | null>(null);
  const [failure, setFailure] = useState<DocumentSaveFailure | null>(null);
  const [panel, setPanel] = useState<"versions" | "move" | null>(null);
  const { refresh } = loaded;
  const { liveVersion } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the list stream reports agent saves; the body must be read again from the server.
  useEffect(() => {
    if (liveVersion !== null) refresh();
  }, [liveVersion, refresh]);
  const saved = loaded.data;
  if (saved === null) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{loaded.error ?? "Loading document"}</p>
    );
  }
  const current: DocumentEditDraft = draft ?? {
    baseVersion: saved.version,
    title: saved.title,
    content: saved.content,
  };
  const save = async (next: DocumentEditDraft) => {
    const input = documentSaveInput(next, saved);
    if (input === null) return setDraft(null);
    const result = await update({ environmentId, input: { id: documentId, ...input } });
    if (result._tag === "Success") {
      setDraft(null);
      setFailure(null);
      refresh();
      return;
    }
    setFailure(documentSaveFailure(squashAtomCommandFailure(result)));
  };
  const resolve = (choice: "reload" | "overwrite") => {
    const next = resolveDocumentConflict({
      draft: current,
      choice,
      conflictVersion: failure?.kind === "conflict" ? failure.currentVersion : null,
      latestVersion: saved.version,
    });
    setFailure(null);
    setDraft(next);
    if (next === null) refresh();
    else void save(next);
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-1">
        <Button size="icon-xs" variant="ghost" aria-label="All documents" onClick={props.onBack}>
          <ArrowLeftIcon />
        </Button>
        <Input
          aria-label="Title"
          value={current.title}
          disabled={!canEdit}
          onChange={(event) => setDraft({ ...current, title: event.target.value })}
        />
      </div>
      <Textarea
        aria-label="Document"
        className="min-h-0 flex-1"
        value={current.content}
        disabled={!canEdit}
        onChange={(event) => setDraft({ ...current, content: event.target.value })}
      />
      {failure?.kind === "conflict" ? (
        <div className="flex items-center gap-1 text-xs">
          <span className="min-w-0 flex-1">The agent saved a newer version.</span>
          <Button size="xs" variant="ghost" onClick={() => resolve("reload")}>
            Use theirs
          </Button>
          <Button size="xs" onClick={() => resolve("overwrite")}>
            Keep mine
          </Button>
        </div>
      ) : failure?.kind === "error" ? (
        <p className="text-xs text-muted-foreground">{failure.message}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        {canEdit ? (
          <Button
            size="xs"
            disabled={draft === null || current.title.trim().length === 0}
            onClick={() => save(current)}
          >
            Save
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          onClick={() => setPanel(panel === "versions" ? null : "versions")}
        >
          Versions
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            const result = await exportDocument({ environmentId, input: { id: documentId } });
            if (result._tag === "Success") {
              downloadMarkdown(result.value.fileName, result.value.markdown);
            }
          }}
        >
          <DownloadIcon />
          Export
        </Button>
        {canEdit && props.projectCwd !== null ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPanel(panel === "move" ? null : "move")}
          >
            Copy to project
          </Button>
        ) : null}
        {canEdit ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={async () => {
              const result = await remove({ environmentId, input: { id: documentId } });
              if (result._tag === "Success") props.onBack();
            }}
          >
            Delete
          </Button>
        ) : null}
      </div>
      {panel === "versions" ? (
        <DocumentVersions
          key={saved.version}
          threadRef={props.threadRef}
          documentId={documentId}
          canEdit={canEdit}
          onRestored={() => {
            setDraft(null);
            refresh();
          }}
        />
      ) : null}
      {panel === "move" && props.projectCwd !== null ? (
        <MoveToProject
          threadRef={props.threadRef}
          documentId={documentId}
          title={saved.title}
          cwd={props.projectCwd}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </div>
  );
}

function DocumentRow(props: {
  readonly document: ConversationDocumentSummary;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
      onClick={props.onOpen}
    >
      <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{props.document.title}</span>
      <span className="shrink-0 text-muted-foreground">v{props.document.version}</span>
    </button>
  );
}

export function DocumentsPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly initialDocumentId: ConversationDocumentId | null;
  readonly projectCwd: string | null;
}) {
  const { environmentId, threadId } = props.threadRef;
  const live = useEnvironmentQuery(
    serverEnvironment.conversationDocumentsLive({ environmentId, input: { threadId } }),
  );
  const canEdit = useAtomValue(
    serverEnvironment.createConversationDocument.permissionAtom(environmentId),
  );
  const create = useAtomCommand(serverEnvironment.createConversationDocument);
  const restore = useAtomCommand(serverEnvironment.restoreConversationDocument);
  const [openId, setOpenId] = useState(props.initialDocumentId);
  if (openId !== null) {
    return (
      <DocumentEditor
        key={openId}
        threadRef={props.threadRef}
        documentId={openId}
        projectCwd={props.projectCwd}
        liveVersion={
          live.data?.documents.find((document) => document.id === openId)?.version ?? null
        }
        onBack={() => setOpenId(null)}
      />
    );
  }
  const { active, deleted } = partitionDocuments(live.data?.documents ?? []);
  return (
    <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto p-2">
      {canEdit ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          onClick={async () => {
            const result = await create({
              environmentId,
              input: { threadId, title: "Untitled", content: "" },
            });
            if (result._tag === "Success") setOpenId(result.value.id);
          }}
        >
          <PlusIcon />
          New document
        </Button>
      ) : null}
      {live.data === null ? (
        <p className="p-2 text-xs text-muted-foreground">{live.error ?? "Loading documents"}</p>
      ) : active.length === 0 && deleted.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">No documents in this conversation yet.</p>
      ) : null}
      {active.map((document) => (
        <DocumentRow key={document.id} document={document} onOpen={() => setOpenId(document.id)} />
      ))}
      {deleted.length > 0 ? (
        <p className="px-2 pt-2 text-xs text-muted-foreground">Deleted</p>
      ) : null}
      {deleted.map((document) => (
        <div key={document.id} className="flex items-center gap-2 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{document.title}</span>
          {canEdit ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => restore({ environmentId, input: { id: document.id } })}
            >
              Restore
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
