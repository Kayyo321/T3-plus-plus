import type { ConversationDocumentError, ConversationDocumentSummary } from "@t3tools/contracts";

/** What a person is typing, and the version it was started from. */
export interface DocumentEditDraft {
  readonly baseVersion: number;
  readonly title: string;
  readonly content: string;
}

export interface DocumentSaveInput {
  readonly expectedVersion: number;
  readonly title?: string;
  readonly content?: string;
}

/** Only what changed, so a title edit cannot rewrite an agent's newer content on overwrite. */
export function documentSaveInput(
  draft: DocumentEditDraft,
  saved: { readonly title: string; readonly content: string },
): DocumentSaveInput | null {
  const title = draft.title.trim();
  const titleChanged = title !== saved.title;
  const contentChanged = draft.content !== saved.content;
  if (!titleChanged && !contentChanged) return null;
  return {
    expectedVersion: draft.baseVersion,
    ...(titleChanged ? { title } : {}),
    ...(contentChanged ? { content: draft.content } : {}),
  };
}

export type DocumentSaveFailure =
  | { readonly kind: "conflict"; readonly currentVersion: number | null }
  | { readonly kind: "error"; readonly message: string };

export function documentSaveFailure(
  error: Pick<ConversationDocumentError, "code" | "message" | "currentVersion"> | unknown,
): DocumentSaveFailure {
  const coded = error as Partial<
    Pick<ConversationDocumentError, "code" | "message" | "currentVersion">
  > | null;
  if (coded?.code === "version_conflict") {
    return { kind: "conflict", currentVersion: coded.currentVersion ?? null };
  }
  return {
    kind: "error",
    message: typeof coded?.message === "string" ? coded.message : "Could not save the document.",
  };
}

/**
 * The next edit after a conflict. A person's words only ever go away because they chose reload;
 * overwrite keeps them and aims at the version that beat them.
 */
export function resolveDocumentConflict(input: {
  readonly draft: DocumentEditDraft;
  readonly choice: "reload" | "overwrite";
  readonly conflictVersion: number | null;
  readonly latestVersion: number;
}): DocumentEditDraft | null {
  if (input.choice === "reload") return null;
  return {
    ...input.draft,
    baseVersion: Math.max(input.conflictVersion ?? 0, input.latestVersion),
  };
}

export function isFileExistsError(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === "file_exists";
}

export function partitionDocuments(documents: ReadonlyArray<ConversationDocumentSummary>) {
  const byRecentEdit = [...documents].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
  return {
    active: byRecentEdit.filter((document) => document.deletedAt === null),
    deleted: byRecentEdit.filter((document) => document.deletedAt !== null),
  };
}

/**
 * The agent's documents not in `known`. Pass null for the first list: documents already there when
 * a conversation opens are not news.
 */
export function newAgentDocuments(
  known: ReadonlySet<string> | null,
  documents: ReadonlyArray<ConversationDocumentSummary>,
): ReadonlyArray<ConversationDocumentSummary> {
  if (known === null) return [];
  return documents.filter(
    (document) =>
      !known.has(document.id) && document.updatedBy === "agent" && document.deletedAt === null,
  );
}

/** A project-relative default for the move dialog. */
export function defaultDocumentPath(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "document"}.md`;
}

/** Why the move dialog cannot confirm, or null. */
export function documentPathError(relativePath: string): string | null {
  const path = relativePath.trim();
  if (path.length === 0) return "Enter a path inside the project.";
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return "Use a path relative to the project.";
  }
  if (path.split(/[\\/]/).includes("..")) return "The path must stay inside the project.";
  if (/[\\/]$/.test(path)) return "End the path with a file name.";
  return null;
}
