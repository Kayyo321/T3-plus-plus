import { isListedThreadLineage, type ThreadCapabilityMode } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { useComposerDraftStore } from "../composerDraftStore";
import { readThreadShells, useQuietThreadShell } from "../state/entities";
import {
  registerChatThreadStarter,
  startThreadInWorkspaceMode,
  useWorkspaceMode,
} from "../state/workspaceMode";
import { useHandleNewThread } from "./useHandleNewThread";
import { useScratchProject } from "./useScratchProject";
import { useStableCallback } from "./useStableCallback";
import { useThreadRouteTarget } from "./useThreadRouteTarget";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

function useRouteCapabilityMode(): ThreadCapabilityMode | null {
  const target = useThreadRouteTarget();
  const shell = useQuietThreadShell(target?.kind === "server" ? target.threadRef : null);
  const draftMode = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? (store.getDraftSession(target.draftId)?.capabilityMode ?? "code")
      : null,
  );
  if (target?.kind === "server") return shell === null ? null : (shell.capabilityMode ?? "code");
  return draftMode;
}

/**
 * The switch remounts the screen, so a view transition carries it across: the composer and headline
 * glide to where they land and the rest cross-fades over a field that looks the same on both sides.
 */
async function morphWorkspaceMode(open: () => Promise<void>) {
  const root = document.documentElement;
  if (
    typeof document.startViewTransition !== "function" ||
    document.visibilityState !== "visible" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    await open();
    return;
  }
  root.dataset.modeMorph = "true";
  const transition = document.startViewTransition(async () => {
    await open();
    // React commits the route after the navigation settles; capture what it commits.
    await new Promise((resolve) => setTimeout(resolve));
  });
  void transition.ready.catch(() => undefined);
  void transition.finished
    .catch(() => undefined)
    .finally(() => {
      delete root.dataset.modeMorph;
    });
  await transition.updateCallbackDone;
}

/** Keeps the sidebar on the half that holds the open conversation, and lends the Chat starter. */
export function useWorkspaceModeRouting(): void {
  const routeMode = useRouteCapabilityMode();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();

  const startChatThread = useStableCallback(async () => {
    const environmentId = scratchEnvironmentId(null);
    if (environmentId === null) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Chat is not available here",
          description: "Connect to a machine that offers Scratch to start a conversation.",
        }),
      );
      return false;
    }
    await startScratchThread(environmentId, "chat");
    return true;
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the route is the source of truth and the store is read outside React by shortcuts
  useEffect(() => {
    if (routeMode !== null) useWorkspaceMode.getState().setMode(routeMode);
  }, [routeMode]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- shortcuts outside React need the live scratch actions
  useEffect(() => registerChatThreadStarter(startChatThread), [startChatThread]);
}

/** Opens a half of the app: its latest conversation, or a fresh one when it has none. */
export function useOpenWorkspaceMode() {
  const navigate = useNavigate();
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();

  const openMode = async (mode: ThreadCapabilityMode) => {
    useWorkspaceMode.getState().setMode(mode);
    const latest = readThreadShells()
      .filter(
        (thread) =>
          thread.archivedAt === null &&
          (thread.capabilityMode ?? "code") === mode &&
          isListedThreadLineage(thread.lineage),
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (latest !== undefined) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: latest.environmentId, threadId: latest.id },
      });
      return;
    }
    const startedChat = startThreadInWorkspaceMode();
    if (startedChat !== null) {
      await startedChat;
      return;
    }
    if (defaultProjectRef === null) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    const opened = await handleNewThread(defaultProjectRef);
    // An empty draft is reused with the mode it was started in, so the tab sets the mode it opens.
    if (opened) {
      useComposerDraftStore
        .getState()
        .setDraftThreadContext(opened.draftId, { capabilityMode: mode });
    }
  };

  return useStableCallback(async (mode: ThreadCapabilityMode) => {
    if (mode === useWorkspaceMode.getState().mode) return;
    await morphWorkspaceMode(() => openMode(mode));
  });
}
