import {
  CONVERSATION_DOCUMENT_MAX_CHARS,
  ConversationDocumentError,
  ConversationDocumentId,
  ThreadId,
  type ConversationDocumentSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  documentConflictVersion,
  documentEditIsDirty,
  documentEditProblem,
  documentUpdateFields,
  partitionDocuments,
  type DocumentEdit,
} from "./threadDocumentsPresentation";

function summary(id: string, input: Partial<ConversationDocumentSummary>) {
  return {
    id: ConversationDocumentId.make(id),
    threadId: ThreadId.make("thread-1"),
    title: id,
    version: 1,
    charCount: 0,
    updatedBy: "user",
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    deletedAt: null,
    movedTo: null,
    ...input,
  } satisfies ConversationDocumentSummary;
}

const edit: DocumentEdit = {
  baseVersion: 3,
  baseTitle: "Plan",
  baseContent: "Body",
  title: "Plan",
  content: "Body",
};

describe("partitionDocuments", () => {
  it("lists newest first and keeps deleted documents apart so they can come back", () => {
    const older = summary("older", { updatedAt: "2026-11-01T09:00:00.000Z" });
    const newer = summary("newer", { updatedAt: "2026-11-01T11:00:00.000Z" });
    const deleted = summary("deleted", { deletedAt: "2026-11-01T12:00:00.000Z" });
    const { active, deleted: removed } = partitionDocuments([older, deleted, newer]);
    expect(active.map((document) => document.id)).toEqual(["newer", "older"]);
    expect(removed.map((document) => document.id)).toEqual(["deleted"]);
  });
});

describe("document edits", () => {
  it("sends only the fields that changed", () => {
    expect(documentUpdateFields(edit)).toEqual({});
    expect(documentUpdateFields({ ...edit, title: "  New plan " })).toEqual({ title: "New plan" });
    expect(documentUpdateFields({ ...edit, content: "Body 2" })).toEqual({ content: "Body 2" });
  });

  it("tracks unsaved text", () => {
    expect(documentEditIsDirty(null)).toBe(false);
    expect(documentEditIsDirty(edit)).toBe(false);
    expect(documentEditIsDirty({ ...edit, content: "Body 2" })).toBe(true);
  });

  it("stops a save the server would refuse", () => {
    expect(documentEditProblem(edit)).toBeNull();
    expect(documentEditProblem({ ...edit, title: " " })).toBe("Add a title.");
    expect(
      documentEditProblem({ ...edit, content: "x".repeat(CONVERSATION_DOCUMENT_MAX_CHARS + 1) }),
    ).toContain("character limit");
  });

  it("reads the newest version only from a version conflict", () => {
    const failure = (code: "version_conflict" | "not_found") =>
      new ConversationDocumentError({ code, message: "No", currentVersion: 7 });
    expect(documentConflictVersion(failure("version_conflict"))).toBe(7);
    expect(documentConflictVersion(failure("not_found"))).toBeNull();
    expect(documentConflictVersion("offline")).toBeNull();
  });
});
