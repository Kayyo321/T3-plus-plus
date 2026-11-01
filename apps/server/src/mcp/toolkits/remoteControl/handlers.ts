import { OrchestratorMcpFailure, type RemoteControlError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as RemoteControl from "../../../remoteControl/RemoteControlService.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, readThread } from "../../threadAccess.ts";
import { RemoteControlToolkit } from "./tools.ts";

const toFailure = (error: RemoteControlError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "thread_unavailable" ? "thread_not_found" : "invalid_request",
    message: error.message,
  });

const agentActor = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const label = scope.client?.label ?? scope.thread?.threadId;
  return { kind: "agent" as const, ...(label === undefined ? {} : { label }) };
});

/** The thread a call means, for a caller that may hand access to it to someone outside. */
const sharingTarget = Effect.fn("mcp.remoteControl.target")(function* (threadId?: ThreadId) {
  const caller = yield* readCaller();
  yield* assertNotLinked(caller, "share a thread outside this environment");
  const { projection } = yield* readThread(threadId);
  return projection.thread.id;
});

export const layer = McpToolAccess.toLayer(RemoteControlToolkit, {
  t3_remote_control_on: McpToolAccess.writesThreads(
    (params) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const threadId = yield* sharingTarget(params.threadId);
        const remote = yield* RemoteControl.RemoteControlService;
        // Pairing stays approve-on-desktop and the code is withheld: an agent can open the door
        // for a device, but only the owner lets one through.
        const { link } = yield* remote
          .enable(
            {
              threadId,
              ...(params.accessLevel === undefined ? {} : { accessLevel: params.accessLevel }),
              ...(params.ownerReview === undefined ? {} : { ownerReview: params.ownerReview }),
            },
            yield* agentActor,
          )
          .pipe(Effect.mapError(toFailure));
        return { routes: link.routes, expiresAt: link.expiresAt };
      }),
  ),
  t3_remote_control_off: McpToolAccess.writesThreads(
    (params) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(params.threadId);
        const remote = yield* RemoteControl.RemoteControlService;
        yield* remote
          .disable({ threadId: projection.thread.id }, yield* agentActor)
          .pipe(Effect.mapError(toFailure));
        return { enabled: false as const };
      }),
  ),
  t3_remote_control_rotate_link: McpToolAccess.writesThreads(
    (params) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const threadId = yield* sharingTarget(params.threadId);
        const remote = yield* RemoteControl.RemoteControlService;
        const link = yield* remote
          .rotateLink({ threadId }, yield* agentActor)
          .pipe(Effect.mapError(toFailure));
        return { routes: link.routes, expiresAt: link.expiresAt };
      }),
  ),
  t3_remote_control_revoke_guest: McpToolAccess.writesThreads(
    (params) => [params.threadId],
    (params) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(params.threadId);
        const remote = yield* RemoteControl.RemoteControlService;
        yield* remote
          .revokeDevice(
            { threadId: projection.thread.id, deviceId: params.deviceId },
            yield* agentActor,
          )
          .pipe(Effect.mapError(toFailure));
        return { revoked: true as const };
      }),
  ),
  t3_remote_control_status: McpToolAccess.reads((params) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(params.threadId);
      const remote = yield* RemoteControl.RemoteControlService;
      const snapshot = yield* Stream.runHead(remote.changes);
      const found = Option.getOrThrow(snapshot).switches.find(
        (candidate) => candidate.threadId === projection.thread.id,
      );
      return found === undefined
        ? { enabled: false, accessLevel: null, devices: [] }
        : { enabled: true, accessLevel: found.accessLevel, devices: found.devices };
    }),
  ),
});
