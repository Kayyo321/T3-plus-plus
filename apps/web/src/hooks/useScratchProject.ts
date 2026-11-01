import { RegistryContext } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { deriveLogicalProjectKeyFromSettings, selectProjectGroupingSettings } from "@t3tools/client-runtime/state/project-grouping";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadCapabilityMode } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { readProject } from "~/state/entities";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { projectEnvironment } from "~/state/projects";
import { type NewThreadHandler, useNewThreadHandler } from "./useHandleNewThread";
import { getClientSettings } from "./useSettings";

function reportScratchFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

type ScratchEnvironment = Pick<EnvironmentPresentation, "connection" | "serverConfig"> & {
  readonly environmentId: EnvironmentId;
};

export function createScratchProjectActions(input: {
  readonly environments: () => Iterable<ScratchEnvironment>;
  readonly primaryEnvironmentId: () => EnvironmentId | null;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly handleNewThread: NewThreadHandler;
}) {
  const scratchWorkspaceRootFor = (environmentId: EnvironmentId | null): string | null => {
    let environment: ScratchEnvironment | undefined;
    for (const entry of input.environments()) {
      if (entry.environmentId === environmentId) environment = entry;
    }
    return availableScratchWorkspaceRoot(environment?.connection.phase, environment?.serverConfig);
  };

  // The primary (local) environment wins; `fallback` only applies when it offers no scratch root.
  const scratchEnvironmentId = (fallback: EnvironmentId | null): EnvironmentId | null => {
    const primary = input.primaryEnvironmentId();
    if (primary !== null && scratchWorkspaceRootFor(primary) !== null) return primary;
    if (fallback !== null && scratchWorkspaceRootFor(fallback) !== null) return fallback;
    const offering = [...input.environments()].filter(
      (entry) => scratchWorkspaceRootFor(entry.environmentId) !== null,
    );
    return offering.length === 1 ? (offering[0]?.environmentId ?? null) : null;
  };

  const openScratchProject = async (
    environmentId: EnvironmentId,
    failureTitle = "Could not start without a project",
  ): Promise<EnvironmentProject | null> => {
    const command = projectEnvironment.openScratch;
    const result = await runAtomCommand(
      input.registry,
      command,
      { environmentId, input: {} },
      { label: command.label, reportFailure: false, reportDefect: true },
    );
    if (result._tag === "Success") return result.value;
    if (!isAtomCommandInterrupted(result)) {
      reportScratchFailure(failureTitle, squashAtomCommandFailure(result));
    }
    return null;
  };

  // A reused empty draft keeps its last mode, so every start says which one it wants.
  const openScratchDraft = async (project: EnvironmentProject, mode: ThreadCapabilityMode) => {
    const opened = await input
      .handleNewThread(scopeProjectRef(project.environmentId, project.id))
      .catch((error: unknown) => {
        reportScratchFailure("Could not start without a project", error);
        return null;
      });
    if (opened) {
      useComposerDraftStore
        .getState()
        .setDraftThreadContext(opened.draftId, { capabilityMode: mode });
    }
  };

  const startScratchThread = async (
    environmentId: EnvironmentId,
    mode: ThreadCapabilityMode = "code",
  ) => {
    const project = await openScratchProject(environmentId);
    if (project) await openScratchDraft(project, mode);
  };

  /**
   * Chat needs no project, so a draft that picks it leaves the one it is in for Scratch, on the
   * machine it is already on. With no Scratch to go to it stays put: Chat never requires a project.
   */
  const setDraftCapabilityMode = async (draftId: DraftId, mode: ThreadCapabilityMode) => {
    const drafts = useComposerDraftStore.getState();
    const session = drafts.getDraftSession(draftId);
    if (!session) return;
    const setInPlace = () =>
      useComposerDraftStore.getState().setDraftThreadContext(draftId, { capabilityMode: mode });
    const scratchHere = scratchWorkspaceRootFor(session.environmentId) !== null;
    const environmentId = scratchHere
      ? session.environmentId
      : scratchEnvironmentId(session.environmentId);
    const current = readProject(scopeProjectRef(session.environmentId, session.projectId));
    if (
      mode === "code" ||
      environmentId === null ||
      (current !== null &&
        isScratchProject(current, scratchWorkspaceRootFor(current.environmentId)))
    ) {
      setInPlace();
      return;
    }
    const project = await openScratchProject(environmentId, "Could not start a Chat conversation");
    const latest = useComposerDraftStore.getState().getDraftSession(draftId);
    if (!project || latest?.projectId !== session.projectId) {
      setInPlace();
      return;
    }
    if (!composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(draftId))) {
      await openScratchDraft(project, mode);
      return;
    }
    useComposerDraftStore.getState().setLogicalProjectDraftThreadId(
      deriveLogicalProjectKeyFromSettings(
        project,
        selectProjectGroupingSettings(getClientSettings()),
      ),
      scopeProjectRef(project.environmentId, project.id),
      draftId,
      { capabilityMode: mode, envMode: "local", branch: null, worktreePath: null },
    );
  };

  return {
    scratchWorkspaceRootFor,
    scratchEnvironmentId,
    openScratchProject,
    startScratchThread,
    setDraftCapabilityMode,
  };
}

export function useScratchProject() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const registry = useContext(RegistryContext);
  const handleNewThread = useNewThreadHandler();
  return createScratchProjectActions({
    environments: () => environments,
    primaryEnvironmentId: () => primaryEnvironmentId,
    registry,
    handleNewThread,
  });
}
