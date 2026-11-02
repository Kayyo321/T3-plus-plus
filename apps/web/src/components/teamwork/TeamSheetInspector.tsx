import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  TeamEdgeKind,
  TeamGrowth,
  TeamLeadNode,
  TeamModelChoice,
  TeamSheet,
  TeamSheetChange,
  TeamSheetNode,
  TeamWorkKind,
  TeamWorkNode,
} from "@t3tools/contracts";
import type { RefObject } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance, type AppModelOption } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { TeamChoiceRow } from "./TeamChoiceRow";

const WORK_KINDS: ReadonlyArray<{ readonly value: TeamWorkKind; readonly label: string }> = [
  { value: "build", label: "Build" },
  { value: "review", label: "Review" },
  { value: "validate", label: "Validate" },
];
const MODEL_CHOICES: ReadonlyArray<{
  readonly value: TeamModelChoice["type"];
  readonly label: string;
}> = [
  { value: "lead", label: "Lead decides" },
  { value: "provider", label: "One provider" },
  { value: "pinned", label: "Pinned" },
];
const GROWTH_MODES: ReadonlyArray<{
  readonly value: TeamGrowth["mode"];
  readonly label: string;
}> = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
  { value: "ask", label: "Ask" },
];
const GROWTH_SCOPES: ReadonlyArray<{
  readonly value: TeamGrowth["scope"];
  readonly label: string;
}> = [
  { value: "session", label: "Per session" },
  { value: "sheet", label: "Save to sheet" },
];
const EDGE_KINDS: ReadonlyArray<{ readonly value: TeamEdgeKind; readonly label: string }> = [
  { value: "handoff", label: "Handoff" },
  { value: "return", label: "Return" },
];

function TeamModelControl(props: {
  readonly environmentId: EnvironmentId;
  readonly node: TeamWorkNode;
  readonly onChange: (modelChoice: TeamModelChoice) => void;
}) {
  const { modelChoice } = props.node;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const settings = useEnvironmentSettings(props.environmentId);
  const entries = providerInstanceEntriesFor(providers, settings, null);
  const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>(
    entries.map((entry) => [entry.instanceId, getAppModelOptionsForInstance(settings, entry)]),
  );
  const first = entries[0];
  const instanceId = modelChoice.type === "lead" ? first?.instanceId : modelChoice.instanceId;

  const choose = (type: TeamModelChoice["type"]) => {
    if (type === "lead") return props.onChange({ type });
    if (instanceId === undefined) return;
    if (type === "provider") return props.onChange({ type, instanceId });
    const model = modelOptionsByInstance.get(instanceId)?.[0]?.slug;
    if (model !== undefined) props.onChange({ type, instanceId, model });
  };

  return (
    <div className="flex flex-col gap-2">
      <TeamChoiceRow
        label="Model"
        value={modelChoice.type}
        options={MODEL_CHOICES}
        onChange={choose}
      />
      {modelChoice.type === "provider" ? (
        <Select
          value={modelChoice.instanceId}
          items={entries.map((entry) => ({ value: entry.instanceId, label: entry.displayName }))}
          onValueChange={(value) => {
            const entry = entries.find((candidate) => candidate.instanceId === value);
            if (entry) props.onChange({ type: "provider", instanceId: entry.instanceId });
          }}
        >
          <SelectTrigger size="sm" aria-label="Provider">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {entries.map((entry) => (
              <SelectItem key={entry.instanceId} value={entry.instanceId}>
                {entry.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {modelChoice.type === "pinned" ? (
        <ProviderModelPicker
          environmentId={props.environmentId}
          activeInstanceId={modelChoice.instanceId}
          model={modelChoice.model}
          lockedProvider={null}
          instanceEntries={entries}
          modelOptionsByInstance={modelOptionsByInstance}
          triggerAriaLabel="Pinned model"
          onInstanceModelChange={(pinnedInstanceId, model) =>
            props.onChange({ type: "pinned", instanceId: pinnedInstanceId, model })
          }
        />
      ) : null}
    </div>
  );
}

function TeamGrowthControl(props: {
  readonly node: TeamLeadNode;
  readonly onChange: (growth: TeamGrowth) => void;
}) {
  const { growth } = props.node;
  return (
    <>
      <TeamChoiceRow
        label="Growth"
        value={growth.mode}
        options={GROWTH_MODES}
        onChange={(mode) => props.onChange({ ...growth, mode })}
      />
      {growth.mode === "off" ? null : (
        <TeamChoiceRow
          label="Scope"
          value={growth.scope}
          options={GROWTH_SCOPES}
          onChange={(scope) => props.onChange({ ...growth, scope })}
        />
      )}
    </>
  );
}

function TeamConnections(props: {
  readonly sheet: Pick<TeamSheet, "nodes" | "edges">;
  readonly node: TeamSheetNode;
  readonly onChange: (change: TeamSheetChange) => void;
}) {
  const { node, sheet } = props;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">Lines from {node.name}</span>
      <ul className="flex flex-col gap-1">
        {sheet.nodes
          .filter((target) => target.id !== node.id)
          .map((target) => (
            <li key={target.id} className="flex items-center gap-1 text-xs">
              <span className="min-w-0 flex-1 truncate">{target.name}</span>
              {EDGE_KINDS.map(({ value: kind, label }) => {
                const edge = { from: node.id, to: target.id, kind };
                const connected = sheet.edges.some(
                  (entry) =>
                    entry.from === edge.from && entry.to === edge.to && entry.kind === kind,
                );
                return (
                  <Button
                    key={kind}
                    size="xs"
                    variant={connected ? "secondary" : "ghost"}
                    aria-pressed={connected}
                    aria-label={`${label} to ${target.name}`}
                    onClick={() =>
                      props.onChange({ type: connected ? "disconnect" : "connect", edge })
                    }
                  >
                    {label}
                  </Button>
                );
              })}
            </li>
          ))}
      </ul>
    </div>
  );
}

export function TeamSheetInspector({
  nameInputRef,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly sheet: Pick<TeamSheet, "nodes" | "edges">;
  readonly node: TeamSheetNode;
  readonly nameInputRef: RefObject<HTMLInputElement | null>;
  readonly onChange: (change: TeamSheetChange) => void;
}) {
  const { node } = props;
  const update = (
    fields: Omit<Extract<TeamSheetChange, { type: "update_node" }>, "type" | "nodeId">,
  ) => props.onChange({ type: "update_node", nodeId: node.id, ...fields });
  return (
    <div className="flex flex-col gap-3 p-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        Name
        <Input
          key={`${node.id}:${node.name}`}
          ref={nameInputRef}
          size="sm"
          defaultValue={node.name}
          maxLength={80}
          onBlur={(event) => {
            const name = event.target.value.trim();
            if (name !== "" && name !== node.name) update({ name });
            else event.target.value = node.name;
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        Instructions
        <Textarea
          key={`${node.id}:${node.instructions}`}
          defaultValue={node.instructions}
          maxLength={8_000}
          rows={6}
          onBlur={(event) => {
            if (event.target.value !== node.instructions) {
              update({ instructions: event.target.value });
            }
          }}
        />
      </label>
      {node.kind === "lead" ? (
        <>
          <p className="text-xs text-muted-foreground">This thread's model.</p>
          <TeamGrowthControl node={node} onChange={(growth) => update({ growth })} />
        </>
      ) : (
        <>
          <TeamChoiceRow
            label="Work"
            value={node.kind}
            options={WORK_KINDS}
            onChange={(work) => update({ work })}
          />
          <TeamModelControl
            environmentId={props.environmentId}
            node={node}
            onChange={(modelChoice) => update({ modelChoice })}
          />
        </>
      )}
      <TeamConnections sheet={props.sheet} node={node} onChange={props.onChange} />
      {node.kind === "lead" ? null : (
        <Button
          size="xs"
          variant="destructive-outline"
          className="self-start"
          onClick={() => props.onChange({ type: "remove_node", nodeId: node.id })}
        >
          Remove team
        </Button>
      )}
    </div>
  );
}
