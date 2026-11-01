import type { ModelSelection, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";

/** The model a new thread in this project starts on, from the project's workspace, if it says. */
export const readProjectWorkspaceDefaultModel = (
  projectRef: ScopedProjectRef,
): ModelSelection | null => {
  const catalog = AsyncResult.getOrElse(
    appAtomRegistry.get(
      serverEnvironment.workspacesLive({ environmentId: projectRef.environmentId, input: {} }),
    ),
    () => null,
  );
  const workspaceId = catalog?.attachments.find(
    ({ target }) => target.kind === "project" && target.projectId === projectRef.projectId,
  )?.workspaceId;
  const workspace = catalog?.workspaces.find(
    (candidate) => candidate.id === workspaceId && candidate.deletedAt === null,
  );
  return workspace?.settings.defaultModelSelection ?? null;
};
