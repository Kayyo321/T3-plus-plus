import {
  ConversationDocument,
  ConversationDocumentIdInput,
  ConversationDocumentRestoreVersionInput,
  ConversationDocumentListVersionsResult,
  ConversationDocumentExportResult,
  ConversationDocumentCreateInput,
  ConversationDocumentGetInput,
  ConversationDocumentListResult,
  ConversationDocumentUpdateInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ConversationDocumentService from "../../../documents/ConversationDocumentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const documentTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ConversationDocumentService.ConversationDocumentService,
  ],
};

const enabledWithDocuments = McpInvocationContext.enabledWithCapability("documents");

const DocumentListTool = Tool.make("document_list", {
  ...documentTool,
  description: "List this conversation's documents: id, title, version, and whether deleted.",
  parameters: Tool.EmptyParams,
  success: ConversationDocumentListResult,
})
  .annotate(Tool.Title, "List documents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);

const DocumentReadTool = Tool.make("document_read", {
  ...documentTool,
  description: "Read a document of this conversation. Pass `version` for an older one.",
  parameters: ConversationDocumentGetInput,
  success: ConversationDocument,
})
  .annotate(Tool.Title, "Read a document")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);

const DocumentCreateTool = Tool.make("document_create", {
  ...documentTool,
  description:
    "Save notes, a draft, a plan, or a Mermaid diagram as a Markdown document beside this conversation. Use it for anything the user will keep or edit; answer plain questions in chat.",
  parameters: ConversationDocumentCreateInput.mapFields(
    ({ threadId: _threadId, ...fields }) => fields,
  ),
  success: ConversationDocument,
})
  .annotate(Tool.Title, "Create a document")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);

const DocumentUpdateTool = Tool.make("document_update", {
  ...documentTool,
  description:
    "Save a new version of a document, replacing its `content` or `title`. The user may have edited it: read it first and pass that `version` as `expectedVersion`.",
  parameters: ConversationDocumentUpdateInput,
  success: ConversationDocument,
})
  .annotate(Tool.Title, "Update a document")
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);

const DocumentDeleteTool = Tool.make("document_delete", {
  ...documentTool,
  description: "Hide a document of this conversation. Restore it with document_restore.",
  parameters: ConversationDocumentIdInput,
  success: ConversationDocument,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);
const DocumentRestoreTool = Tool.make("document_restore", {
  ...documentTool,
  description: "Restore a deleted document of this conversation, keeping its history.",
  parameters: ConversationDocumentIdInput,
  success: ConversationDocument,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);
const DocumentVersionsTool = Tool.make("document_versions", {
  ...documentTool,
  description: "List retained versions of a document of this conversation.",
  parameters: ConversationDocumentIdInput,
  success: ConversationDocumentListVersionsResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);
const DocumentRestoreVersionTool = Tool.make("document_restore_version", {
  ...documentTool,
  description: "Copy a retained version into a new current version without deleting history.",
  parameters: ConversationDocumentRestoreVersionInput,
  success: ConversationDocument,
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);
const DocumentExportTool = Tool.make("document_export", {
  ...documentTool,
  description:
    "Export a document of this conversation as Markdown text and a suggested filename; writes no project files.",
  parameters: ConversationDocumentGetInput,
  success: ConversationDocumentExportResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(McpSchema.EnabledWhen, enabledWithDocuments);

export const DocumentsToolkit = Toolkit.make(
  DocumentDeleteTool,
  DocumentRestoreTool,
  DocumentVersionsTool,
  DocumentRestoreVersionTool,
  DocumentExportTool,
  DocumentListTool,
  DocumentReadTool,
  DocumentCreateTool,
  DocumentUpdateTool,
);
