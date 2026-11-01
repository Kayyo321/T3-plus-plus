import { LegendList } from "@legendapp/list/react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseStep, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  computerUseActionLabel,
  computerUseOffReason,
  computerUseSensitivityLabel,
  computerUseStepStatus,
  mergeComputerUseSteps,
  olderComputerUseStepsCursor,
} from "./computerUse.logic";
import { startComputerUse } from "./computerUseActions";
import { ComputerUseStatus } from "./ComputerUseBanner";
import { useComputerUseControls, useComputerUseSnapshot } from "./useComputerUse";

const NO_STEPS: ReadonlyArray<ComputerUseStep> = [];

const stepKey = (step: ComputerUseStep) => step.id;

function ComputerUseStepScreenshot({
  threadRef,
  step,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly step: ComputerUseStep;
}) {
  const screenshot = useEnvironmentQuery(
    serverEnvironment.computerUseScreenshot({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, stepId: step.id },
    }),
  );
  if (screenshot.data !== null) {
    return (
      <img
        src={`data:${screenshot.data.mimeType};base64,${screenshot.data.data}`}
        alt={step.intent}
        className="mt-1.5 w-full rounded-md border border-border/60"
      />
    );
  }
  return (
    <p className="mt-1.5 text-muted-foreground">
      {screenshot.error === null ? "Loading screenshot" : screenshot.error}
    </p>
  );
}

function ComputerUseStepRow({
  threadRef,
  step,
  expanded,
  onToggleScreenshot,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly step: ComputerUseStep;
  readonly expanded: boolean;
  readonly onToggleScreenshot: (stepId: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const status = computerUseStepStatus(step.status);
  return (
    <div className="border-border/60 border-b px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-medium">{computerUseActionLabel(step.action)}</span>
        <Badge variant={status.tone} size="sm">
          {status.label}
        </Badge>
        {step.sensitivity === null ? null : (
          <span className="min-w-0 truncate text-muted-foreground">
            {computerUseSensitivityLabel(step.sensitivity)}
          </span>
        )}
        <time dateTime={step.at} className="ms-auto shrink-0 text-muted-foreground tabular-nums">
          {formatShortTimestamp(step.at, timestampFormat)}
        </time>
      </div>
      <p className="mt-1 wrap-anywhere">{step.intent}</p>
      {step.result === null ? null : (
        <p className="mt-0.5 line-clamp-4 wrap-anywhere text-muted-foreground">{step.result}</p>
      )}
      {step.hasScreenshot ? (
        <div className="mt-1 -ms-1.5">
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => onToggleScreenshot(step.id)}
          >
            {expanded ? "Hide screenshot" : "Show screenshot"}
          </Button>
        </div>
      ) : null}
      {expanded ? <ComputerUseStepScreenshot threadRef={threadRef} step={step} /> : null}
    </div>
  );
}

function ComputerUseOffState({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const controls = useComputerUseControls(threadRef);
  if (controls.status !== "off") return null;
  if (controls.start === null) {
    return <p className="p-3 text-muted-foreground text-xs">{computerUseOffReason(controls)}</p>;
  }
  return (
    <div className="flex flex-col gap-2 p-3 text-xs">
      <p>Turn on computer use for this conversation.</p>
      {controls.start.targets.map((option) => (
        <div key={option.target} className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={option.disabledReason !== null}
            onClick={() => startComputerUse(threadRef, option.target)}
          >
            {option.label}
          </Button>
          <span className="min-w-0 text-muted-foreground">{option.disabledReason}</span>
        </div>
      ))}
      {controls.start.providerSupported ? (
        <p className="text-muted-foreground">{controls.start.providerNote}</p>
      ) : null}
    </div>
  );
}

/** The step log. Live steps come from the subscription; older ones load a page at a time. */
export function ComputerUsePanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const snapshot = useComputerUseSnapshot(threadRef);
  const [knownSteps, setKnownSteps] = useState(NO_STEPS);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const fetchSteps = useAtomQueryRunner(serverEnvironment.computerUseSteps, {
    reportFailure: false,
  });
  // Kept here because the live window drops steps as new ones arrive.
  const steps = mergeComputerUseSteps(knownSteps, snapshot?.recentSteps ?? NO_STEPS);
  if (steps !== knownSteps) setKnownSteps(steps);
  const olderCursor = olderComputerUseStepsCursor(steps);

  const loadOlder = async () => {
    if (olderCursor === null) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    const result = await fetchSteps({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, beforeSequence: olderCursor },
    });
    setLoadingOlder(false);
    if (result._tag === "Success") {
      setKnownSteps((current) => mergeComputerUseSteps(current, result.value.steps));
    } else if (!isAtomCommandInterrupted(result)) {
      setOlderFailed(true);
    }
  };
  const toggleScreenshot = (stepId: string) =>
    setExpandedStepId((current) => (current === stepId ? null : stepId));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="p-2 empty:hidden">
        <ComputerUseStatus threadRef={threadRef} placement="panel" />
      </div>
      <ComputerUseOffState threadRef={threadRef} />
      {steps.length === 0 ? (
        <p className="p-3 text-muted-foreground text-xs">
          {snapshot === null ? "Loading steps" : "No steps yet."}
        </p>
      ) : (
        // A long session logs thousands of steps; only the rows in view are mounted.
        <LegendList<ComputerUseStep>
          data={steps}
          keyExtractor={stepKey}
          extraData={expandedStepId}
          renderItem={({ item }) => (
            <ComputerUseStepRow
              threadRef={threadRef}
              step={item}
              expanded={item.id === expandedStepId}
              onToggleScreenshot={toggleScreenshot}
            />
          )}
          estimatedItemSize={76}
          drawDistance={440}
          className="min-h-0 flex-1 overscroll-contain"
        />
      )}
      {olderCursor === null ? null : (
        <footer className="flex items-center justify-between gap-2 border-border/60 border-t px-2 py-1.5 text-2xs text-muted-foreground">
          <span>{olderFailed ? "Could not load older steps." : `${steps.length} steps shown`}</span>
          <Button size="xs" variant="ghost" disabled={loadingOlder} onClick={loadOlder}>
            Load older
          </Button>
        </footer>
      )}
    </div>
  );
}
