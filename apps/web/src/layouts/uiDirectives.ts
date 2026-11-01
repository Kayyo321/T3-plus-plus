import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { dispatchPreviewAction } from "../components/preview/previewActionBus";
import { readThreadShell } from "../state/entities";
import { focusActivePanelTerminal } from "../lib/terminalFocus";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import {
  isSingletonKind,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { CONVERSATION_PANEL } from "./layoutDocument";
import {
  applyLayout,
  closeSplitPane,
  focusSplitPane,
  openThreadInSplit,
  readFocusedThreadRef,
  resetLayout,
} from "./layoutActions";
import { findLayout, useLayoutStore } from "./layoutStore";
import { paneTargetKey } from "./splitView.logic";
import { useSplitViewStore } from "./splitViewStore";

interface ThreadScoped {
  /** The conversation to act on. Defaults to the focused one. */
  readonly threadRef?: ScopedThreadRef;
}

/**
 * Everything that may rearrange a client from outside it: the orchestrator's server-sent
 * directives, and any other caller that has no React context. Panels are named by surface kind.
 */
export type UiDirective =
  | ({ readonly type: "layout.apply"; readonly layout: string } & ThreadScoped)
  | ({ readonly type: "layout.reset" } & ThreadScoped)
  | ({
      readonly type: "panel.open";
      readonly panel: string;
      readonly path?: string;
      readonly line?: number;
    } & ThreadScoped)
  | ({ readonly type: "panel.close"; readonly panel: string } & ThreadScoped)
  | ({ readonly type: "panel.focus"; readonly panel: string } & ThreadScoped)
  | {
      readonly type: "split.open";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly side?: "left" | "right";
    }
  | {
      readonly type: "split.close";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly type: "split.focus";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    };

export type UiDirectiveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const failed = (reason: string): UiDirectiveResult => ({ ok: false, reason });
const done: UiDirectiveResult = { ok: true };

function paneShowing(environmentId: EnvironmentId, threadId: ThreadId): string | null {
  const key = paneTargetKey({
    kind: "server",
    threadRef: scopeThreadRef(environmentId, threadId),
  });
  const pane = useSplitViewStore.getState().panes.find((entry) => {
    return paneTargetKey(entry.target) === key;
  });
  return pane?.id ?? null;
}

function openPanel(threadRef: ScopedThreadRef, panel: string, path?: string, line?: number) {
  const store = useRightPanelStore.getState();
  if (path !== undefined) {
    store.openFile(threadRef, path, line);
    return done;
  }
  if (panel === "preview") {
    dispatchPreviewAction("toggle-panel");
    return done;
  }
  if (panel === "terminal" || panel === "file" || panel === "pull-request") {
    const existing = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.find(
      (surface) => surface.kind === panel,
    );
    if (!existing) return failed(`Opening ${panel} needs more than its name.`);
    store.activateSurface(threadRef, existing.id);
    return done;
  }
  if (!isSingletonKind(panel)) return failed(`Unknown panel: ${panel}`);
  store.open(threadRef, panel);
  return done;
}

function closePanel(threadRef: ScopedThreadRef, panel: string): UiDirectiveResult {
  const store = useRightPanelStore.getState();
  const surfaces = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.filter(
    (surface) => surface.kind === panel,
  );
  if (surfaces.length === 0) return failed(`No ${panel} panel is open.`);
  for (const surface of surfaces) store.closeSurface(threadRef, surface.id);
  return done;
}

function focusPanel(threadRef: ScopedThreadRef, panel: string): UiDirectiveResult {
  if (panel === CONVERSATION_PANEL) {
    requestWorkspaceFocus({ area: "composer" });
    return done;
  }
  const store = useRightPanelStore.getState();
  const surface = selectThreadRightPanelState(store.byThreadKey, threadRef).surfaces.find(
    (entry) => entry.kind === panel,
  );
  if (!surface) return failed(`No ${panel} panel is open.`);
  store.activateSurface(threadRef, surface.id);
  if (panel === "terminal") focusActivePanelTerminal(threadRef);
  else requestWorkspaceFocus({ area: "panel" });
  return done;
}

/** Applies one directive. It reports failure rather than throwing, since the caller is remote. */
export function applyUiDirective(directive: UiDirective): UiDirectiveResult {
  switch (directive.type) {
    case "split.open":
      openThreadInSplit(
        scopeThreadRef(directive.environmentId, directive.threadId),
        directive.side ? { side: directive.side } : {},
      );
      return done;
    case "split.close":
    case "split.focus": {
      const paneId = paneShowing(directive.environmentId, directive.threadId);
      if (paneId === null) return failed("That conversation is not in a pane.");
      if (directive.type === "split.close") closeSplitPane(paneId);
      else focusSplitPane(paneId);
      return done;
    }
    default:
      break;
  }
  const threadRef = directive.threadRef ?? readFocusedThreadRef();
  if (threadRef === null) return failed("No conversation is open.");
  switch (directive.type) {
    case "layout.apply": {
      const layout = findLayout(useLayoutStore.getState(), directive.layout);
      if (layout === null) return failed(`Unknown layout: ${directive.layout}`);
      applyLayout(threadRef, layout);
      return done;
    }
    case "layout.reset":
      resetLayout(threadRef, readThreadShell(threadRef)?.projectId ?? null);
      return done;
    case "panel.open":
      return openPanel(threadRef, directive.panel, directive.path, directive.line);
    case "panel.close":
      return closePanel(threadRef, directive.panel);
    case "panel.focus":
      return focusPanel(threadRef, directive.panel);
  }
}
