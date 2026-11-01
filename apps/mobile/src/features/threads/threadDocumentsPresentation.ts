import {
  CONVERSATION_DOCUMENT_MAX_CHARS,
  type ConversationDocumentSummary,
} from "@t3tools/contracts";

export interface DocumentEdit {
  readonly baseVersion: number;
  readonly baseTitle: string;
  readonly baseContent: string;
  readonly title: string;
  readonly content: string;
}

export function partitionDocuments(documents: ReadonlyArray<ConversationDocumentSummary>): {
  readonly active: ReadonlyArray<ConversationDocumentSummary>;
  readonly deleted: ReadonlyArray<ConversationDocumentSummary>;
} {
  const newestFirst = [...documents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    active: newestFirst.filter((document) => document.deletedAt === null),
    deleted: newestFirst.filter((document) => document.deletedAt !== null),
  };
}

export function documentMeta(document: {
  readonly version: number;
  readonly updatedBy: ConversationDocumentSummary["updatedBy"];
}): string {
  return `Version ${document.version} · Edited by ${document.updatedBy === "agent" ? "the agent" : "you"}`;
}

export function documentEditIsDirty(edit: DocumentEdit | null): boolean {
  return edit !== null && (edit.title !== edit.baseTitle || edit.content !== edit.baseContent);
}

export function documentEditProblem(edit: DocumentEdit): string | null {
  if (edit.title.trim() === "") return "Add a title.";
  return edit.content.length > CONVERSATION_DOCUMENT_MAX_CHARS
    ? `This document is over the ${CONVERSATION_DOCUMENT_MAX_CHARS.toLocaleString()} character limit.`
    : null;
}

export function documentUpdateFields(edit: DocumentEdit): {
  readonly title?: string;
  readonly content?: string;
} {
  const title = edit.title.trim();
  return {
    ...(title === edit.baseTitle ? {} : { title }),
    ...(edit.content === edit.baseContent ? {} : { content: edit.content }),
  };
}

/** The newest version when a save lost to another writer, otherwise null. */
export function documentConflictVersion(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const { code, currentVersion } = error as {
    readonly code?: unknown;
    readonly currentVersion?: unknown;
  };
  return code === "version_conflict" && typeof currentVersion === "number" ? currentVersion : null;
}
