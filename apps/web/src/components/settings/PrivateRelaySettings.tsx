import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, RemoteRelayState } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CopyIcon, PlayIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const ONBOARDING_PROMPT_URL =
  "https://raw.githubusercontent.com/Kayyo321/T3-plus-plus/main/infra/remote-relay/ONBOARDING.md";

const onboardingPrompt = (home: string | undefined) =>
  [
    `Read this prompt: ${ONBOARDING_PROMPT_URL} and walk me through setting up my private relay, or creating one if I don't have one already.`,
    ...(home === undefined ? [] : [`My T3 home is ${home}.`]),
  ].join(" ");

const describeRelay = (relay: RemoteRelayState | null) => {
  if (relay === null) return "Loading…";
  switch (relay.status) {
    case "off":
      return "Reach Remote Control from anywhere through your own Cloudflare Worker. Network access can stay off.";
    case "connecting":
      return `Connecting to ${relay.url}…`;
    case "connected":
      return `Connected to ${relay.url}.`;
    case "failing":
      return `Can't reach ${relay.url}, or it refused this machine's secret. Retrying…`;
  }
};

function RelayForm({
  environmentId,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDone: () => void;
}) {
  const configure = useAtomCommand(serverEnvironment.configureRemoteRelay, {
    reportFailure: false,
  });
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const result = await configure({ environmentId, input: { url, secret } });
    setSaving(false);
    if (result._tag === "Success") return onDone();
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The relay could not be saved.");
  };

  return (
    <form className="mt-3 flex flex-col gap-2" onSubmit={(event) => void save(event)}>
      <Input
        aria-label="Relay address"
        placeholder="https://t3pp-remote-relay.your-name.workers.dev"
        autoComplete="off"
        spellCheck={false}
        value={url}
        onChange={(event) => setUrl(event.target.value)}
      />
      <Input
        aria-label="Relay secret"
        placeholder="Relay secret"
        type="password"
        autoComplete="off"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
      />
      {error !== null ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={saving || url.trim() === "" || secret.trim() === ""}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function PrivateRelaySettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const relay =
    useEnvironmentQuery(serverEnvironment.remoteRelayLive({ environmentId, input: {} })).data ??
    null;
  const canConfigure = useAtomValue(
    serverEnvironment.configureRemoteRelay.permissionAtom(environmentId),
  );
  const remove = useAtomCommand(serverEnvironment.removeRemoteRelay, {
    label: "remove private relay",
  });
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "onboarding prompt" });
  const [editing, setEditing] = useState(false);
  const prompt = onboardingPrompt(relay?.home);

  const removeRelay = async () => {
    const confirmed = await requestConfirmDialog(
      "Remove this relay? Links that use it stop working. The Worker stays on your Cloudflare account.",
      { variant: "destructive" },
    );
    if (confirmed) await remove({ environmentId, input: {} });
  };

  const runPrompt = async () => {
    const target = scratchEnvironmentId(environmentId);
    if (target === null) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Could not start the prompt",
          description: "This machine can't start a conversation without a project.",
        }),
      );
      return;
    }
    await startScratchThread(target, "code", prompt);
  };

  return (
    <SettingsSection {...searchableSetting("private-relay")}>
      <SettingsRow
        title="Connection"
        description={describeRelay(relay)}
        control={
          canConfigure && relay !== null && !editing ? (
            <div className="flex gap-2">
              <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
                {relay.url === null ? "Add relay" : "Replace"}
              </Button>
              {relay.url === null ? null : (
                <Button size="xs" variant="outline" onClick={() => void removeRelay()}>
                  Remove
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {editing ? (
          <RelayForm environmentId={environmentId} onDone={() => setEditing(false)} />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Onboard private relay prompt"
        description="Have an agent set up your relay, or create one if you don't have one yet."
        control={
          <div className="flex gap-2">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="Copy onboarding prompt"
                    onClick={() => copyToClipboard(prompt, undefined)}
                  />
                }
              >
                {isCopied ? <CheckIcon /> : <CopyIcon />}
              </TooltipTrigger>
              <TooltipPopup side="top">Copy prompt</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="outline"
                    aria-label="Run onboarding prompt"
                    disabled={relay === null}
                    onClick={() => void runPrompt()}
                  />
                }
              >
                <PlayIcon />
              </TooltipTrigger>
              <TooltipPopup side="top">Start a thread with this prompt</TooltipPopup>
            </Tooltip>
          </div>
        }
      />
    </SettingsSection>
  );
}
