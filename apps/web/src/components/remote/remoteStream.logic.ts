import {
  REMOTE_CONTROL_ATTACHMENT_ROUTE,
  REMOTE_CONTROL_COMMAND_OUTPUT_ROUTE,
  REMOTE_CONTROL_HISTORY_ROUTE,
  REMOTE_CONTROL_ITEM_ROUTE,
  REMOTE_CONTROL_MEDIA_ROUTE,
  REMOTE_CONTROL_RENDER_ROUTE,
  REMOTE_CONTROL_STREAM_ROUTE,
  REMOTE_CONTROL_SWITCH_PARAM,
  type RemoteControlEndReason,
  RemoteControlStreamEvent,
  type RemoteControlView,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  applyGuestStreamEvent,
  type GuestHistoryPageLoaded,
  type GuestStreamState,
  initialSharedStreamState,
  type SharedThreadRoutes,
} from "../guest/guestStream.logic";

export interface RemoteStreamState {
  readonly thread: GuestStreamState<RemoteControlView>;
  readonly endReason: RemoteControlEndReason | null;
}

export const initialRemoteStreamState: RemoteStreamState = {
  thread: initialSharedStreamState<RemoteControlView>(),
  endReason: null,
};

export function applyRemoteStreamEvent(
  state: RemoteStreamState,
  event: RemoteControlStreamEvent | GuestHistoryPageLoaded,
): RemoteStreamState {
  if (event.type === "ended") {
    return {
      thread: applyGuestStreamEvent<RemoteControlView>(state.thread, { type: "ended" }),
      endReason: event.reason,
    };
  }
  return { ...state, thread: applyGuestStreamEvent<RemoteControlView>(state.thread, event) };
}

const decodeStreamEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(RemoteControlStreamEvent)),
);

/** Returns null for anything the server would never send, so a bad frame is skipped, not fatal. */
export const parseRemoteStreamEvent = (data: string): RemoteControlStreamEvent | null =>
  Option.getOrNull(decodeStreamEvent(data));

/** The sequence an event carries, for resuming after the connection drops. */
export function streamEventSequence(event: RemoteControlStreamEvent): number | null {
  if (event.type !== "thread") return null;
  const { item } = event;
  if (item.kind === "snapshot") return item.snapshotSequence;
  return item.kind === "event" || item.kind === "unknown-event" ? item.sequence : null;
}

export const remoteStreamUrl = (switchId: string, afterSequence: number) => {
  const param = `${REMOTE_CONTROL_SWITCH_PARAM}=${encodeURIComponent(switchId)}`;
  return afterSequence > 0
    ? `${REMOTE_CONTROL_STREAM_ROUTE}?${param}&after=${afterSequence}`
    : `${REMOTE_CONTROL_STREAM_ROUTE}?${param}`;
};

export const remoteThreadRoutes = (switchId: string): SharedThreadRoutes => {
  const param = `${REMOTE_CONTROL_SWITCH_PARAM}=${encodeURIComponent(switchId)}`;
  return {
    attachment: (id) => `${REMOTE_CONTROL_ATTACHMENT_ROUTE}?${param}&id=${encodeURIComponent(id)}`,
    media: (path) => `${REMOTE_CONTROL_MEDIA_ROUTE}?${param}&path=${encodeURIComponent(path)}`,
    render: (itemId) =>
      `${REMOTE_CONTROL_RENDER_ROUTE}?${param}&item=${encodeURIComponent(itemId)}`,
    item: (itemId) => `${REMOTE_CONTROL_ITEM_ROUTE}?${param}&item=${encodeURIComponent(itemId)}`,
    commandOutput: (itemId) =>
      `${REMOTE_CONTROL_COMMAND_OUTPUT_ROUTE}?${param}&item=${encodeURIComponent(itemId)}`,
    history: (cursor) =>
      `${REMOTE_CONTROL_HISTORY_ROUTE}?${param}&cursor=${encodeURIComponent(cursor)}`,
  };
};

/** The switch a link (`<switchId>.<generation>.<signature>`) opens. The server checks the rest. */
export function linkSwitchId(credential: string): string | null {
  const [switchId, generation, signature] = credential.split(".");
  return switchId && generation && signature ? switchId : null;
}

/** A name to offer for this device, which the person joining can change. */
export function suggestedDeviceLabel(userAgent: string): string {
  const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/.exec(userAgent)?.[1]?.trim();
  if (android && android !== "K" && android !== "wv") return android.slice(0, 40);
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  if (/Android/.test(userAgent)) return "Android phone";
  if (/Macintosh/.test(userAgent)) return "Mac";
  if (/Windows/.test(userAgent)) return "Windows PC";
  if (/Linux/.test(userAgent)) return "Linux PC";
  return "My device";
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** Failed reconnects before the page stops calling it a blip. */
export const OWNER_OFFLINE_AFTER_ATTEMPTS = 3;

export const reconnectDelayMs = (attempt: number) =>
  RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length) - 1] ?? RECONNECT_DELAYS_MS[0]!;

export const END_REASON_MESSAGES: Record<RemoteControlEndReason, string> = {
  revoked: "The owner disconnected this device.",
  switched_off: "The owner turned off remote control.",
  archived: "This conversation was archived.",
  expired: "This session reached its time limit.",
  signed_out: "You left this conversation on this device.",
};

/** "11h 20m" or "5m", rounded down, for how long a session has left. */
export function formatRemaining(untilIso: string, nowMs: number): string {
  const minutes = Math.floor((Date.parse(untilIso) - nowMs) / 60_000);
  if (minutes <= 0) return "under a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Groups a pairing code the way the owner's screen shows it. */
export const formatPairingCode = (code: string) =>
  code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
