import {
  ConversationDocumentId,
  type ConversationDocumentSummary,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  defaultDocumentPath,
  documentPathError,
  documentSaveFailure,
  documentSaveInput,
  newAgentDocuments,
  partitionDocuments,
  resolveDocumentConflict,
} from "./conversationDocuments.logic";

const summary = (
  id: string,
  overrides: Partial<ConversationDocumentSummary> = {},
): ConversationDocumentSummary => ({
  id: ConversationDocumentId.make(id),
  threadId: ThreadId.make("thread"),
  title: id,
  version: 1,
  charCount: 0,
  updatedBy: "agent",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
  movedTo: null,
  ...overrides,
});

describe("documentSaveInput", () => {
  const saved = { title: "Plan", content: "Body" };

  it("sends only what changed, against the version the edit started from", () => {
    expect(documentSaveInput({ baseVersion: 3, ...saved }, saved)).toBeNull();
    expect(
      documentSaveInput({ baseVersion: 3, title: "  Plan  ", content: "Body" }, saved),
    ).toBeNull();
    expect(documentSaveInput({ baseVersion: 3, title: "Plan", content: "New" }, saved)).toEqual({
      expectedVersion: 3,
      content: "New",
    });
    expect(
      documentSaveInput({ baseVersion: 3, title: "Renamed ", content: "Body" }, saved),
    ).toEqual({ expectedVersion: 3, title: "Renamed" });
  });
});

describe("documentSaveFailure", () => {
  it("separates a conflict from anything else", () => {
    expect(documentSaveFailure({ code: "version_conflict", currentVersion: 7 })).toEqual({
      kind: "conflict",
      currentVersion: 7,
    });
    expect(documentSaveFailure({ code: "version_conflict" })).toEqual({
      kind: "conflict",
      currentVersion: null,
    });
    expect(documentSaveFailure({ code: "storage", message: "Disk full" })).toEqual({
      kind: "error",
      message: "Disk full",
    });
    expect(documentSaveFailure(null)).toEqual({
      kind: "error",
      message: "Could not save the document.",
    });
  });
});

describe("resolveDocumentConflict", () => {
  const draft = { baseVersion: 3, title: "Plan", content: "My words" };

  it("drops the edit only when the person chose reload", () => {
    expect(
      resolveDocumentConflict({ draft, choice: "reload", conflictVersion: 5, latestVersion: 5 }),
    ).toBeNull();
  });

  it("keeps the text on overwrite and aims at the newest version seen", () => {
    expect(
      resolveDocumentConflict({ draft, choice: "overwrite", conflictVersion: 5, latestVersion: 4 }),
    ).toEqual({ ...draft, baseVersion: 5 });
    expect(
      resolveDocumentConflict({ draft, choice: "overwrite", conflictVersion: 5, latestVersion: 6 }),
    ).toEqual({ ...draft, baseVersion: 6 });
    expect(
      resolveDocumentConflict({
        draft,
        choice: "overwrite",
        conflictVersion: null,
        latestVersion: 4,
      }),
    ).toEqual({ ...draft, baseVersion: 4 });
  });
});

describe("partitionDocuments", () => {
  it("lists the newest edit first and keeps deleted documents reachable", () => {
    const old = summary("old", { updatedAt: "2026-11-01T00:00:00.000Z" });
    const recent = summary("recent", { updatedAt: "2026-11-02T00:00:00.000Z" });
    const gone = summary("gone", { deletedAt: "2026-11-03T00:00:00.000Z" });
    expect(partitionDocuments([old, gone, recent])).toEqual({
      active: [recent, old],
      deleted: [gone],
    });
  });
});

describe("newAgentDocuments", () => {
  it("is quiet for the first list, a person's document, an edit, and a deleted document", () => {
    const fresh = summary("fresh");
    expect(newAgentDocuments(null, [fresh])).toEqual([]);
    expect(newAgentDocuments(new Set(["fresh"]), [fresh])).toEqual([]);
    expect(newAgentDocuments(new Set(), [summary("mine", { updatedBy: "user" })])).toEqual([]);
    expect(
      newAgentDocuments(new Set(), [summary("gone", { deletedAt: "2026-11-03T00:00:00.000Z" })]),
    ).toEqual([]);
    expect(newAgentDocuments(new Set(["old"]), [summary("old"), fresh])).toEqual([fresh]);
  });
});

describe("defaultDocumentPath", () => {
  it.each([
    ["Launch plan: Q3", "launch-plan-q3.md"],
    ["  Résumé notes ", "résumé-notes.md"],
    ["???", "document.md"],
  ])("turns %j into %j", (title, expected) => {
    expect(defaultDocumentPath(title)).toBe(expected);
  });
});

describe("documentPathError", () => {
  it.each(["notes.md", "docs/plan.md", "docs/..hidden/plan.md"])("accepts %j", (path) => {
    expect(documentPathError(path)).toBeNull();
  });

  it.each([
    "",
    "  ",
    "/etc/passwd",
    "\\share\\x.md",
    "C:/x.md",
    "../x.md",
    "a/../../x.md",
    "docs/",
  ])("refuses %j", (path) => {
    expect(documentPathError(path)).not.toBeNull();
  });
});
