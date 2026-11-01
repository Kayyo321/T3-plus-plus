import {
  type ComputerUseSnapshot,
  REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE,
  REMOTE_CONTROL_COMPUTER_SCREENSHOT_ROUTE,
  REMOTE_CONTROL_COMPUTER_STOP_ROUTE,
  REMOTE_CONTROL_COMPUTER_STREAM_ROUTE,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";

/** Watch, approve, and stop a computer session; a guest never drives it directly. */
export function RemoteComputerUse(props: {
  readonly routeFor: (route: string) => string;
  readonly canApprove: boolean;
  readonly canStop: boolean;
  readonly onAct: (url: string, body?: unknown) => void;
}) {
  const { routeFor } = props;
  const [snapshot, setSnapshot] = useState<ComputerUseSnapshot | null>(null);
  const streamUrl = routeFor(REMOTE_CONTROL_COMPUTER_STREAM_ROUTE);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the EventSource; the browser reconnects it, and revocation closes it from the server.
  useEffect(() => {
    const source = new EventSource(streamUrl);
    source.addEventListener("message", (message) => {
      setSnapshot(JSON.parse(message.data) as ComputerUseSnapshot);
    });
    return () => source.close();
  }, [streamUrl]);
  if (snapshot === null || snapshot.state.status === "off") return null;
  const approval = snapshot.state.pendingApproval;
  const latest = snapshot.recentSteps.findLast((step) => step.hasScreenshot);
  return (
    <section className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1">The agent is using a computer</span>
        {props.canStop ? (
          <Button
            size="xs"
            variant="destructive-outline"
            onClick={() => props.onAct(routeFor(REMOTE_CONTROL_COMPUTER_STOP_ROUTE))}
          >
            Stop
          </Button>
        ) : null}
      </div>
      {latest ? (
        <img
          src={`${routeFor(REMOTE_CONTROL_COMPUTER_SCREENSHOT_ROUTE)}&stepId=${encodeURIComponent(latest.id)}`}
          alt={latest.intent}
          className="max-h-48 rounded-md border border-border object-contain"
        />
      ) : null}
      {approval ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1">{approval.intent}</span>
          {props.canApprove ? (
            <>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  props.onAct(routeFor(REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE), {
                    approvalId: approval.id,
                    approved: false,
                  })
                }
              >
                Deny
              </Button>
              <Button
                size="xs"
                onClick={() =>
                  props.onAct(routeFor(REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE), {
                    approvalId: approval.id,
                    approved: true,
                  })
                }
              >
                Approve
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
