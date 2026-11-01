import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type OrchestratorDomain,
  type OrchestratorGrantLevel,
  type OrchestratorGrants,
  type OrchestratorSupervisionAction,
} from "@t3tools/contracts";

import { orchestratorEnvironment } from "../../state/orchestratorAgent";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const LEVELS: ReadonlyArray<{ readonly value: OrchestratorGrantLevel; readonly label: string }> = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
];

const DOMAIN_LABELS: Record<OrchestratorDomain, string> = {
  conversations: "Conversations",
  sessions: "Sessions",
  projects: "Projects",
  "workspace-ui": "Panels and layouts",
  git: "Git",
  tasks: "Tasks",
  supervision: "Supervision",
  settings: "Settings",
  "remote-control": "Remote control",
  "computer-use": "Computer use",
};

const ACTION_LABELS: Record<OrchestratorSupervisionAction, string> = {
  message: "Message an agent",
  answer: "Answer for it",
  interrupt: "Interrupt",
  restart: "Restart",
  stop: "Stop",
  rewind: "Rewind",
};

function GrantRow(props: {
  readonly label: string;
  readonly value: OrchestratorGrantLevel;
  readonly disabled: boolean;
  readonly onChange: (value: OrchestratorGrantLevel) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-xs">
      <span>{props.label}</span>
      <ToggleGroup
        variant="segmented"
        aria-label={props.label}
        value={[props.value]}
        disabled={props.disabled}
        onValueChange={(values) => {
          const [next] = values as ReadonlyArray<OrchestratorGrantLevel>;
          if (next !== undefined) props.onChange(next);
        }}
      >
        {LEVELS.map((level) => (
          <Toggle key={level.value} value={level.value}>
            {level.label}
          </Toggle>
        ))}
      </ToggleGroup>
    </div>
  );
}

export default function OrchestratorGrantsEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly grants: OrchestratorGrants;
}) {
  const { environmentId, grants } = props;
  const canEdit = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const setGrants = useAtomCommand(orchestratorEnvironment.setGrants);
  const save = (next: OrchestratorGrants) =>
    void setGrants({ environmentId, input: { grants: next } });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      <p className="text-xs text-muted-foreground">
        Off refuses everything. Ask runs reads and asks before each change. Allow runs both. Secret
        values and security settings stay out of its reach whatever you set here.
      </p>
      <section>
        <h3 className="font-mono text-2xs tracking-wide text-muted-foreground uppercase">Areas</h3>
        {(Object.keys(DOMAIN_LABELS) as ReadonlyArray<OrchestratorDomain>).map((domain) => (
          <GrantRow
            key={domain}
            label={DOMAIN_LABELS[domain]}
            value={grants.domains[domain]}
            disabled={!canEdit}
            onChange={(value) =>
              save({ ...grants, domains: { ...grants.domains, [domain]: value } })
            }
          />
        ))}
      </section>
      <section className="flex flex-col gap-2 text-xs">
        <h3 className="font-mono text-2xs tracking-wide text-muted-foreground uppercase">
          Always ask
        </h3>
        <label className="flex items-center justify-between gap-2">
          Anything that leaves this machine
          <Switch
            checked={grants.askBeforeExternal}
            disabled={!canEdit}
            onCheckedChange={(checked) => save({ ...grants, askBeforeExternal: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2">
          Anything that destroys data
          <Switch
            checked={grants.askBeforeDestructive}
            disabled={!canEdit}
            onCheckedChange={(checked) => save({ ...grants, askBeforeDestructive: checked })}
          />
        </label>
      </section>
      <section>
        <h3 className="font-mono text-2xs tracking-wide text-muted-foreground uppercase">
          Supervision steps
        </h3>
        {(Object.keys(ACTION_LABELS) as ReadonlyArray<OrchestratorSupervisionAction>).map(
          (action) => (
            <GrantRow
              key={action}
              label={ACTION_LABELS[action]}
              value={grants.supervisionActions[action]}
              disabled={!canEdit}
              onChange={(value) =>
                save({
                  ...grants,
                  supervisionActions: { ...grants.supervisionActions, [action]: value },
                })
              }
            />
          ),
        )}
      </section>
    </div>
  );
}
