import {
  IsoDateTime,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  RemoteControlAccessLevel,
  RemoteControlDeviceId,
  RemoteControlLinkRoute,
  RemoteControlSwitch,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as RemoteControlService from "../../../remoteControl/RemoteControlService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    RemoteControlService.RemoteControlService,
  ],
};

const ThreadTarget = {
  environmentId: OrchestratorMcpEnvironmentTarget,
  threadId: Schema.optional(ThreadId),
};

const RemoteControlLinkResult = Schema.Struct({
  routes: Schema.Array(RemoteControlLinkRoute),
  expiresAt: IsoDateTime,
});

const RemoteControlOnTool = Tool.make("t3_remote_control_on", {
  ...shared,
  description:
    "Turn on remote control for a thread, so a paired device can reach it, and get a one-time link. Omit `threadId` for this thread. The owner still approves each device. Only `view` or `chat`; the owner raises access.",
  parameters: Schema.Struct({
    ...ThreadTarget,
    accessLevel: Schema.optional(Schema.Literals(["view", "chat"])),
    ownerReview: Schema.optional(Schema.Boolean),
  }),
  success: RemoteControlLinkResult,
}).annotate(Tool.Destructive, false);

const RemoteControlOffTool = Tool.make("t3_remote_control_off", {
  ...shared,
  description:
    "Turn off remote control for a thread. Ends its link and every device at once. Omit `threadId` for this thread.",
  parameters: Schema.Struct(ThreadTarget),
  success: Schema.Struct({ enabled: Schema.Literal(false) }),
}).annotate(Tool.Destructive, true);

const RemoteControlRotateLinkTool = Tool.make("t3_remote_control_rotate_link", {
  ...shared,
  description:
    "Replace a thread's remote control link. The old link and pending pairings stop working; paired devices stay. Omit `threadId` for this thread.",
  parameters: Schema.Struct(ThreadTarget),
  success: RemoteControlLinkResult,
}).annotate(Tool.Destructive, true);

const RemoteControlRevokeGuestTool = Tool.make("t3_remote_control_revoke_guest", {
  ...shared,
  description:
    "Disconnect one device from a thread's remote control at once. Find `deviceId` with `t3_remote_control_status`. Omit `threadId` for this thread.",
  parameters: Schema.Struct({ ...ThreadTarget, deviceId: RemoteControlDeviceId }),
  success: Schema.Struct({ revoked: Schema.Literal(true) }),
}).annotate(Tool.Destructive, true);

const RemoteControlStatusTool = Tool.make("t3_remote_control_status", {
  ...shared,
  description:
    "Whether remote control is on for a thread, with its access level and devices. Omit `threadId` for this thread.",
  parameters: Schema.Struct(ThreadTarget),
  success: Schema.Struct({
    enabled: Schema.Boolean,
    accessLevel: Schema.NullOr(RemoteControlAccessLevel),
    devices: RemoteControlSwitch.fields.devices,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const RemoteControlToolkit = Toolkit.make(
  RemoteControlOnTool,
  RemoteControlOffTool,
  RemoteControlRotateLinkTool,
  RemoteControlRevokeGuestTool,
  RemoteControlStatusTool,
);
