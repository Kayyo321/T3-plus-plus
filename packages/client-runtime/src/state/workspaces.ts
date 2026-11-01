import type { ProjectId, ThreadId, Workspace, WorkspaceCatalog } from "@t3tools/contracts";

const MAX_LINEAGE_DEPTH = 16;

export interface ThreadWorkspaceSource {
  /** The thread itself, parents with a workspace of their own, or the project. */
  readonly attachedTo: "thread" | "parent" | "project";
  readonly workspace: Workspace;
}

/**
 * Mirrors the server's resolution so a header can say which credentials are live without asking:
 * a thread's own attachment, then its nearest parent's, then its project's.
 */
export const resolveThreadWorkspace = (input: {
  readonly catalog: WorkspaceCatalog;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentOf: (threadId: ThreadId) => ThreadId | null;
}): ThreadWorkspaceSource | null => {
  const { catalog, threadId, projectId, parentOf } = input;
  const live = (id: string) =>
    catalog.workspaces.find((workspace) => workspace.id === id && workspace.deletedAt === null);
  let current: ThreadId | null = threadId;
  for (let depth = 0; depth < MAX_LINEAGE_DEPTH && current !== null; depth += 1) {
    const target = current;
    const attachment = catalog.attachments.find(
      ({ target: candidate }) => candidate.kind === "thread" && candidate.threadId === target,
    );
    if (attachment !== undefined) {
      const workspace = live(attachment.workspaceId);
      return workspace === undefined
        ? null
        : { attachedTo: depth === 0 ? "thread" : "parent", workspace };
    }
    current = parentOf(current);
  }
  const attachment = catalog.attachments.find(
    ({ target }) => target.kind === "project" && target.projectId === projectId,
  );
  const workspace = attachment === undefined ? undefined : live(attachment.workspaceId);
  return workspace === undefined ? null : { attachedTo: "project", workspace };
};
