import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  REMOTE_CONTROL_INACTIVITY_TTL_MS,
  REMOTE_CONTROL_LEVEL_INFO,
  REMOTE_CONTROL_SESSION_TTL_MS,
  REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP,
  type RemoteControlAccessLevel,
  type RemoteControlDevice,
  type RemoteControlLink,
  type RemoteControlLinkRoute,
  type RemoteControlPairingMode,
  type RemoteControlRouteKind,
  type RemoteControlSwitch,
  remoteControlLevelAllows,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon, CopyIcon, RadioTowerIcon } from "lucide-react";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useStableCallback } from "~/hooks/useStableCallback";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { formatPairingCode, formatRemaining } from "../remote/remoteStream.logic";

const sheetThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("remote-control:sheet-thread"),
);

export function openRemoteControlSheet(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(sheetThreadAtom, threadRef);
}

const ROUTE_LABELS: Record<RemoteControlRouteKind, string> = {
  lan: "This network",
  tailnet: "Tailscale",
  connect: "T3 Connect",
};

const PAIRING_LABELS: Record<RemoteControlPairingMode, string> = {
  approve: "Approve on this device",
  code: "One-time code",
};

const LEVELS = Object.keys(REMOTE_CONTROL_LEVEL_INFO) as ReadonlyArray<RemoteControlAccessLevel>;

const SESSION_LIMITS = `Sessions end after ${REMOTE_CONTROL_INACTIVITY_TTL_MS / 3_600_000} hours without activity, or ${REMOTE_CONTROL_SESSION_TTL_MS / 3_600_000} hours after pairing.`;

const raiseMessage = (level: RemoteControlAccessLevel, devices: number) => {
  const { label, description } = REMOTE_CONTROL_LEVEL_INFO[level];
  const who =
    devices === 0
      ? "Devices that join"
      : devices === 1
        ? "The connected device"
        : `The ${devices} connected devices`;
  return `Raise access to ${label}?\n${who} can do this at once: ${description}`;
};

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Remote control did not respond.";
};

function useRemoteControlSwitches(environmentId: EnvironmentId) {
  // An older server has no such subscription to open.
  const supported =
    useAtomValue(environmentPresentations.serverConfigsAtom).get(environmentId)?.environment
      .capabilities.remoteControl === true;
  return useEnvironmentQuery(
    supported ? serverEnvironment.remoteControlLive({ environmentId, input: {} }) : null,
  ).data?.switches;
}

function useRemoteControlSwitch(threadRef: ScopedThreadRef): RemoteControlSwitch | null {
  const switches = useRemoteControlSwitches(threadRef.environmentId);
  return switches?.find((candidate) => candidate.threadId === threadRef.threadId) ?? null;
}

/** The header's switch: opens the sheet, and shows at a glance whether anyone is connected. */
export function RemoteControlButton({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const remote = useRemoteControlSwitch(threadRef);
  const connected = remote?.devices.filter((device) => device.connected) ?? [];
  const label =
    remote === null
      ? "Remote control"
      : connected.length > 0
        ? `Remote control: ${connected.map((device) => device.label).join(", ")} connected`
        : "Remote control is on";
  return (
    <Button
      size={connected.length > 0 ? "xs" : "icon-xs"}
      variant={remote === null ? "ghost-muted" : "outline"}
      aria-label={label}
      title={label}
      onClick={() => openRemoteControlSheet(threadRef)}
    >
      <RadioTowerIcon />
      {connected.length > 0 ? <span>{connected.length}</span> : null}
    </Button>
  );
}

/** Dialogs that can open over any thread: the sheet, and devices asking to join. */
export function RemoteControlHost() {
  const threadRef = useAtomValue(sheetThreadAtom);
  const configs = useAtomValue(environmentPresentations.serverConfigsAtom);
  return (
    <>
      {threadRef === null ? null : (
        <RemoteControlSheet
          key={`${threadRef.environmentId}:${threadRef.threadId}`}
          threadRef={threadRef}
          onClose={() => appAtomRegistry.set(sheetThreadAtom, null)}
        />
      )}
      {[...configs.keys()].map((environmentId) => (
        <PairingPrompts key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}

function PairingPrompts({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canAnswer = useAtomValue(
    serverEnvironment.resolveRemoteControlPairing.permissionAtom(environmentId),
  );
  const switches = useRemoteControlSwitches(environmentId);
  const resolve = useAtomCommand(serverEnvironment.resolveRemoteControlPairing, {
    label: "answer pairing request",
  });
  const [busy, setBusy] = useState(false);
  const next = canAnswer
    ? switches?.flatMap((remote) =>
        remote.pendingPairings
          .filter((pairing) => pairing.confirmationWord !== null)
          .map((pairing) => ({ remote, pairing })),
      )[0]
    : undefined;
  if (next === undefined) return null;
  const { remote, pairing } = next;
  const answer = async (decision: "approve" | "deny") => {
    setBusy(true);
    await resolve({
      environmentId,
      input: { threadId: remote.threadId, pairingId: pairing.id, decision },
    });
    setBusy(false);
  };
  return (
    <Dialog open>
      <DialogPopup className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{pairing.deviceLabel} wants to join</DialogTitle>
          <DialogDescription>
            It would reach &ldquo;{remote.threadTitle}&rdquo; with{" "}
            {REMOTE_CONTROL_LEVEL_INFO[remote.accessLevel].label} access.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-center text-muted-foreground text-xs">
            Allow it only if the device shows this word
          </p>
          <p className="text-center font-semibold text-2xl tracking-wide">
            {pairing.confirmationWord}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void answer("deny")}>
            Refuse
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void answer("approve")}>
            Allow
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function RemoteControlSheet({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const remote = useRemoteControlSwitch(threadRef);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Remote control</DialogTitle>
          <DialogDescription>
            Reach this one conversation from a phone or another computer. Turn it off and every
            device is out at once.
          </DialogDescription>
        </DialogHeader>
        {remote === null ? (
          <RemoteControlOff threadRef={threadRef} onClose={onClose} />
        ) : (
          <RemoteControlOn threadRef={threadRef} remote={remote} onClose={onClose} />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function RemoteControlOff({
  threadRef,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const canEnable = useAtomValue(
    serverEnvironment.enableRemoteControl.permissionAtom(environmentId),
  );
  const reachability = useEnvironmentQuery(
    serverEnvironment.remoteControlReachability({ environmentId, input: {} }),
  ).data;
  const enable = useAtomCommand(serverEnvironment.enableRemoteControl, { reportFailure: false });
  const [accessLevel, setAccessLevel] = useState<RemoteControlAccessLevel>("chat");
  const [pairingMode, setPairingMode] = useState<RemoteControlPairingMode>("approve");
  const [ownerReview, setOwnerReview] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noRoute = reachability != null && reachability.routes.length === 0;

  const turnOn = async () => {
    const raising = accessLevel !== "view" && accessLevel !== "chat";
    if (raising && !(await requestConfirmDialog(raiseMessage(accessLevel, 0)))) return;
    setTurningOn(true);
    setError(null);
    const result = await enable({
      environmentId,
      input: { threadId, accessLevel, pairingMode, ownerReview, confirmRaise: raising },
    });
    setTurningOn(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result));
    }
  };

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {reachability != null && noRoute ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="font-medium">No other device can reach this machine yet</p>
              <p className="text-muted-foreground">Set up one of these, then come back:</p>
              <ul className="flex flex-col gap-1.5">
                {reachability.unavailable.map((option) => (
                  <li key={option.kind}>
                    <span className="font-medium">{ROUTE_LABELS[option.kind]}:</span>{" "}
                    <span className="text-muted-foreground">{option.hint}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <SwitchSettings
              accessLevel={accessLevel}
              pairingMode={pairingMode}
              ownerReview={ownerReview}
              onAccessLevel={setAccessLevel}
              onPairingMode={setPairingMode}
              onOwnerReview={setOwnerReview}
            />
          )}
          {error !== null ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        {noRoute ? null : (
          <Button
            size="sm"
            disabled={!canEnable || turningOn || reachability == null}
            onClick={() => void turnOn()}
          >
            {turningOn ? "Turning on..." : "Turn on"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function SwitchSettings({
  accessLevel,
  pairingMode,
  ownerReview,
  onAccessLevel,
  onPairingMode,
  onOwnerReview,
}: {
  readonly accessLevel: RemoteControlAccessLevel;
  readonly pairingMode: RemoteControlPairingMode;
  readonly ownerReview: boolean;
  readonly onAccessLevel: (level: RemoteControlAccessLevel) => void;
  readonly onPairingMode: (mode: RemoteControlPairingMode) => void;
  readonly onOwnerReview: (review: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">Access</p>
          <p className="text-muted-foreground text-xs">
            {REMOTE_CONTROL_LEVEL_INFO[accessLevel].description}
          </p>
        </div>
        <Select
          value={accessLevel}
          onValueChange={(value) => {
            if (value !== null) onAccessLevel(value);
          }}
          items={LEVELS.map((level) => ({
            value: level,
            label: REMOTE_CONTROL_LEVEL_INFO[level].label,
          }))}
        >
          <SelectTrigger size="sm" className="w-28" aria-label="Access level">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                {REMOTE_CONTROL_LEVEL_INFO[level].label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">Pairing</p>
        <Select
          value={pairingMode}
          onValueChange={(value) => {
            if (value !== null) onPairingMode(value);
          }}
          items={(["approve", "code"] as const).map((mode) => ({
            value: mode,
            label: PAIRING_LABELS[mode],
          }))}
        >
          <SelectTrigger size="sm" className="w-52" aria-label="Pairing">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="approve">{PAIRING_LABELS.approve}</SelectItem>
            <SelectItem value="code">{PAIRING_LABELS.code}</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block font-medium">Review messages</span>
          <span className="block text-muted-foreground text-xs">
            Hold each message until you send or dismiss it.
          </span>
        </span>
        <Switch
          aria-label="Review messages"
          checked={ownerReview}
          onCheckedChange={onOwnerReview}
        />
      </label>
      <p className="text-muted-foreground text-xs">{SESSION_LIMITS}</p>
    </div>
  );
}

function RemoteControlOn({
  threadRef,
  remote,
  onClose,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly remote: RemoteControlSwitch;
  readonly onClose: () => void;
}) {
  const { environmentId, threadId } = threadRef;
  const canManage = useAtomValue(
    serverEnvironment.updateRemoteControl.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateRemoteControl, { reportFailure: false });
  const disable = useAtomCommand(serverEnvironment.disableRemoteControl, {
    label: "turn off remote control",
  });
  const reveal = useAtomCommand(serverEnvironment.revealRemoteControlLink, {
    reportFailure: false,
  });
  const rotate = useAtomCommand(serverEnvironment.rotateRemoteControlLink, {
    reportFailure: false,
  });
  // A link shown is only good for the link generation it came from.
  const [revealed, setRevealed] = useState<{
    readonly expiresAt: string;
    readonly link: RemoteControlLink;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [turningOff, setTurningOff] = useState(false);
  const linkIsLive = remote.linkStatus === "ready";
  const { linkExpiresAt } = remote;
  const link = linkIsLive && revealed?.expiresAt === linkExpiresAt ? revealed.link : null;
  const revealLink = useStableCallback(() => reveal({ environmentId, input: { threadId } }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the live link from the server when the sheet opens on a switch that already has one
  useEffect(() => {
    if (!canManage || !linkIsLive) return;
    let live = true;
    void revealLink().then((result) => {
      if (live && result._tag === "Success" && result.value?.expiresAt === linkExpiresAt) {
        setRevealed({ expiresAt: linkExpiresAt, link: result.value });
      }
    });
    return () => {
      live = false;
    };
  }, [canManage, linkIsLive, linkExpiresAt, revealLink]);

  const save = async (input: {
    readonly accessLevel?: RemoteControlAccessLevel;
    readonly pairingMode?: RemoteControlPairingMode;
    readonly ownerReview?: boolean;
  }) => {
    const raising =
      input.accessLevel !== undefined &&
      input.accessLevel !== remote.accessLevel &&
      remoteControlLevelAllows(input.accessLevel, remote.accessLevel);
    if (raising) {
      const connected = remote.devices.length;
      if (!(await requestConfirmDialog(raiseMessage(input.accessLevel!, connected)))) return;
    }
    const result = await update({
      environmentId,
      input: { threadId, ...input, confirmRaise: raising },
    });
    setError(result._tag === "Success" ? null : failureMessage(result));
  };

  const newLink = async () => {
    const result = await rotate({ environmentId, input: { threadId } });
    if (result._tag === "Success") {
      setRevealed({ expiresAt: result.value.expiresAt, link: result.value });
      setError(null);
    } else {
      setError(failureMessage(result));
    }
  };

  const turnOff = async () => {
    setTurningOff(true);
    await disable({ environmentId, input: { threadId } });
    setTurningOff(false);
  };

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {linkIsLive && link !== null ? (
            <LinkPanel link={link} expiresAt={remote.linkExpiresAt} />
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm">
              <p className="text-muted-foreground">
                {remote.linkStatus === "spent"
                  ? "The link was used. Each link works once."
                  : remote.linkStatus === "locked"
                    ? "The link was locked after failed attempts."
                    : remote.linkStatus === "expired"
                      ? "The link expired."
                      : "Your connection cannot show the link."}
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={!canManage}
                onClick={() => void newLink()}
              >
                New link
              </Button>
            </div>
          )}
          {linkIsLive && link !== null ? (
            <div>
              <Button size="xs" variant="ghost-muted" onClick={() => void newLink()}>
                Replace link
              </Button>
            </div>
          ) : null}
          <DeviceList threadRef={threadRef} devices={remote.devices} />
          <SwitchSettings
            accessLevel={remote.accessLevel}
            pairingMode={remote.pairingMode}
            ownerReview={remote.ownerReview}
            onAccessLevel={(accessLevel) => void save({ accessLevel })}
            onPairingMode={(pairingMode) => void save({ pairingMode })}
            onOwnerReview={(ownerReview) => void save({ ownerReview })}
          />
          {error !== null ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="destructive-outline"
          size="sm"
          disabled={turningOff}
          onClick={() => void turnOff()}
        >
          Turn off
        </Button>
      </DialogFooter>
    </>
  );
}

function LinkPanel({
  link,
  expiresAt,
}: {
  readonly link: RemoteControlLink;
  readonly expiresAt: string;
}) {
  const [chosenKind, setChosenKind] = useState<string | null>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "remote control link" });
  const nowMinute = useNowMinute();
  const route: RemoteControlLinkRoute =
    link.routes.find((candidate) => candidate.url === chosenKind) ?? link.routes[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-4">
        <div className="shrink-0 rounded-lg bg-white p-2">
          <QRCodeSvg value={route.url} size={120} title="Remote control link" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {link.routes.length > 1 ? (
            <div className="flex flex-wrap gap-1" role="group" aria-label="How the device connects">
              {link.routes.map((candidate) => (
                <Button
                  key={candidate.url}
                  size="xs"
                  variant={candidate.url === route.url ? "secondary" : "ghost-muted"}
                  aria-pressed={candidate.url === route.url}
                  onClick={() => setChosenKind(candidate.url)}
                >
                  {ROUTE_LABELS[candidate.kind]}
                </Button>
              ))}
            </div>
          ) : (
            <Badge variant="outline" size="sm">
              {ROUTE_LABELS[route.kind]}
            </Badge>
          )}
          <div className="flex items-center gap-2">
            <Input
              readOnly
              aria-label="Remote control link"
              value={route.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Copy link"
              onClick={() => copyToClipboard(route.url)}
            >
              {isCopied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Works once, for {formatRemaining(expiresAt, Date.parse(`${nowMinute}Z`))}.
          </p>
        </div>
      </div>
      {link.code === null ? null : (
        <p className="text-sm">
          Code to type on the device:{" "}
          <span className="font-semibold tabular-nums tracking-wide">
            {formatPairingCode(link.code)}
          </span>
        </p>
      )}
      {route.encrypted ? null : (
        <p className="text-warning-foreground text-xs">
          This link is not encrypted, so anyone on this network could read the conversation. Devices
          on it stop at {REMOTE_CONTROL_LEVEL_INFO[REMOTE_CONTROL_UNENCRYPTED_LEVEL_CAP].label}.
          Tailscale and T3 Connect are encrypted.
        </p>
      )}
    </div>
  );
}

function DeviceList({
  threadRef,
  devices,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly devices: ReadonlyArray<RemoteControlDevice>;
}) {
  const revoke = useAtomCommand(serverEnvironment.revokeRemoteControlDevice, {
    label: "disconnect device",
  });
  const nowMinute = useNowMinute();
  if (devices.length === 0) {
    return <p className="text-muted-foreground text-sm">No devices have joined yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Connected devices">
      {devices.map((device) => (
        <li key={device.id} className="flex items-center gap-3 text-sm">
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">
              {device.label}
              <span className="ml-2 font-normal text-muted-foreground text-xs">
                {device.connected ? "Connected" : "Away"}
              </span>
            </p>
            <p className="truncate text-muted-foreground text-xs">
              {device.lastAction ?? "Joined"}. Ends in{" "}
              {formatRemaining(device.idleExpiresAt, Date.parse(`${nowMinute}Z`))} if idle.
            </p>
          </div>
          <Button
            size="xs"
            variant="ghost-destructive"
            onClick={() =>
              void revoke({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, deviceId: device.id },
              })
            }
          >
            Disconnect
          </Button>
        </li>
      ))}
    </ul>
  );
}
