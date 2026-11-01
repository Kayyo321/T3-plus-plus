import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MonitorIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { ComposerBanner } from "../chat/ComposerBanner";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { ComputerUseApprovalModel } from "./computerUse.logic";
import {
  answerComputerUseApproval,
  handBackComputerUse,
  revealComputerUseBrowser,
  showComputerUseSteps,
  stopComputerUse,
  takeOverComputerUse,
} from "./computerUseActions";
import { useComputerUseBanner } from "./useComputerUse";

function ComputerUseApprovalRow({
  threadRef,
  approval,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly approval: ComputerUseApprovalModel;
}) {
  const [answering, setAnswering] = useState(false);
  const answer = async (approved: boolean) => {
    setAnswering(true);
    await answerComputerUseApproval(threadRef, approval.id, approved);
    setAnswering(false);
  };
  return (
    <ComposerBanner.Row layout="approval" role="alert">
      <ComposerBanner.Icon>
        <TriangleAlertIcon />
      </ComposerBanner.Icon>
      <ComposerBanner.Content className="flex-col items-start">
        <span className="font-medium">{approval.heading}</span>
        <span className="min-w-0 wrap-anywhere text-muted-foreground">{approval.intent}</span>
      </ComposerBanner.Content>
      {approval.canAnswer ? (
        <ComposerBanner.Actions>
          <Button size="xs" variant="outline" disabled={answering} onClick={() => answer(false)}>
            Deny
          </Button>
          <Button size="xs" disabled={answering} onClick={() => answer(true)}>
            Approve
          </Button>
        </ComposerBanner.Actions>
      ) : (
        <ComposerBanner.Actions className="text-muted-foreground">
          Waiting for approval
        </ComposerBanner.Actions>
      )}
    </ComposerBanner.Row>
  );
}

/** The state of a running session and every way to act on it. Renders nothing while off. */
export function ComputerUseStatus({
  threadRef,
  placement,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly placement: "chat" | "panel";
}) {
  const model = useComputerUseBanner(threadRef);
  if (model === null) return null;
  return (
    <ComposerBanner.Root
      detached
      density="comfortable"
      width={placement === "chat" ? "content" : "fill"}
      variant={model.takenOver && model.approval === null ? "default" : "warning"}
    >
      <ComposerBanner.Row layout="wrap-actions" role="status">
        <ComposerBanner.Icon>
          <MonitorIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content>
          <span className="shrink-0 font-medium">{model.title}</span>
          <ComposerBanner.Separator />
          <span className="min-w-0 truncate text-muted-foreground">{model.detail}</span>
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          {placement === "chat" ? (
            <Button size="xs" variant="ghost" onClick={() => showComputerUseSteps(threadRef)}>
              Steps
            </Button>
          ) : null}
          {model.revealsBrowser ? (
            <Button size="xs" variant="ghost" onClick={() => revealComputerUseBrowser(threadRef)}>
              Live view
            </Button>
          ) : null}
          {model.control === "take-over" ? (
            <Button size="xs" variant="outline" onClick={() => takeOverComputerUse(threadRef)}>
              Take over
            </Button>
          ) : null}
          {model.control === "hand-back" ? (
            <Button size="xs" variant="outline" onClick={() => handBackComputerUse(threadRef)}>
              Hand back
            </Button>
          ) : null}
          {model.canStop ? (
            <Button
              size="xs"
              variant="destructive"
              aria-label="Stop computer use"
              onClick={() => stopComputerUse(threadRef)}
            >
              Stop
            </Button>
          ) : null}
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      {model.approval === null ? null : (
        <ComputerUseApprovalRow
          key={model.approval.id}
          threadRef={threadRef}
          approval={model.approval}
        />
      )}
    </ComposerBanner.Root>
  );
}

/** Takes plain values so a ChatView render leaves it cached; see ChatBannerLane. */
export function ComputerUseBanner({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3 empty:hidden">
      <ComputerUseStatus threadRef={scopeThreadRef(environmentId, threadId)} placement="chat" />
    </div>
  );
}

/** A maximized panel hides the chat column and its banner, so the title bar stands in for it. */
export function ComputerUseTitlebarIndicator({
  threadRef,
}: {
  readonly threadRef: ScopedThreadRef;
}) {
  const model = useComputerUseBanner(threadRef);
  if (model === null) return null;
  return (
    <span className="me-1 flex shrink-0 items-center gap-1">
      {model.approval === null ? (
        <Badge variant="warning" size="sm">
          {model.title}
        </Badge>
      ) : (
        <Button
          size="xs"
          variant="warning-outline"
          onClick={() => useRightPanelStore.getState().setMaximized(threadRef, false)}
        >
          A step needs approval
        </Button>
      )}
      {model.canStop ? (
        <Button
          size="xs"
          variant="destructive"
          aria-label="Stop computer use"
          onClick={() => stopComputerUse(threadRef)}
        >
          Stop
        </Button>
      ) : null}
    </span>
  );
}
