import {
  ConversationDocument,
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

export const DocumentsToolkit = Toolkit.make(
  DocumentListTool,
  DocumentReadTool,
  DocumentCreateTool,
  DocumentUpdateTool,
);
