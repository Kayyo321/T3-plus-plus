import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  REMOTE_CONTROL_MESSAGES_ROUTE,
  REMOTE_CONTROL_SESSION_ROUTE,
  RemoteControlAccessError,
  RemoteControlSwitchId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layer as layerRemoteRoutes, pairingResponse } from "./http.ts";
import * as RemoteControl from "./RemoteControlService.ts";
import type { RemoteTransport } from "./remoteRoutes.ts";

const switchId = RemoteControlSwitchId.make("switch-1");
const outcome = {
  progress: {
    switchId,
    mode: "approve" as const,
    confirmationWord: "maple",
    status: "paired" as const,
    expiresAt: "2026-11-01T00:00:00.000Z",
  },
  sessionToken: "session-token",
};

const setCookies = (transport: RemoteTransport) =>
  pairingResponse(outcome, transport, null).pipe(
    Effect.map((response) => HttpServerResponse.toWeb(response).headers.getSetCookie().join("\n")),
  );

it.effect("marks the session cookie Secure only where the browser can keep it", () =>
  Effect.gen(function* () {
    const https = yield* setCookies({ peer: "127.0.0.1", https: true, encrypted: true });
    assert.include(https, "t3_remote_switch-1=session-token");
    assert.match(https, /; Secure/);
    assert.match(https, /; HttpOnly/);
    assert.match(https, /; SameSite=Strict/);
    assert.match(https, /; Path=\/api\/remote/);

    const lan = yield* setCookies({ peer: "192.168.1.20", https: false, encrypted: false });
    assert.include(lan, "t3_remote_switch-1=session-token");
    assert.notMatch(lan, /; Secure/);
    assert.match(lan, /; HttpOnly/);
    assert.match(lan, /; SameSite=Strict/);
  }),
);

const layerPlatform = HttpPlatform.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Etag.layerWeak),
);

/** Sends one request through the real routes, with the service the test supplies. */
const send = (service: Partial<RemoteControl.RemoteControlService["Service"]>, request: Request) =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<
      FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path
    >();
    const context = Context.add(
      platform,
      RemoteControl.RemoteControlService,
      RemoteControl.RemoteControlService.of(
        service as RemoteControl.RemoteControlService["Service"],
      ),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRemoteRoutes, { disableLogger: true })),
      ({ handler }) => Effect.promise(() => handler(request, context)),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  }).pipe(Effect.provide(layerPlatform));

it.effect("reads the session only from the cookie of the switch the request names", () =>
  Effect.gen(function* () {
    const seen: Array<RemoteControl.RemoteDeviceCredential> = [];
    yield* send(
      {
        sessionLifetimeMs: (credential) =>
          Effect.sync(() => {
            seen.push(credential);
            return 60_000;
          }),
      },
      new Request(`http://host${REMOTE_CONTROL_SESSION_ROUTE}?switch=a`, {
        headers: { cookie: "t3_remote_a=token-a; t3_remote_b=token-b; t3_session=environment" },
      }),
    );
    assert.equal(seen[0]?.switchId, "a");
    assert.equal(seen[0]?.token, "token-a");
  }),
);

it.effect("never parses a message body for a device that may not send", () =>
  Effect.gen(function* () {
    let submitted = false;
    const form = new FormData();
    form.append("shareId", "a");
    form.append("text", "hello");
    const response = yield* send(
      {
        session: (_credential, required) =>
          required === "chat"
            ? Effect.fail(new RemoteControlAccessError({ reason: "forbidden" }))
            : Effect.void,
        submit: () =>
          Effect.sync(() => {
            submitted = true;
          }),
      },
      new Request(`http://host${REMOTE_CONTROL_MESSAGES_ROUTE}?switch=a`, {
        method: "POST",
        body: form,
      }),
    );
    assert.equal(response.status, 403);
    assert.isFalse(submitted);
  }),
);

const layerSessions = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-control-http-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("a device session is not an environment session", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    // The shape RemoteControlService issues: 32 random bytes, base64url, no signed claims.
    const error = yield* sessions.verify("q".repeat(43)).pipe(Effect.flip);
    assert.equal(error._tag, "MalformedSessionTokenError");
    assert.notEqual(sessions.cookieName.startsWith("t3_remote_"), true);
  }).pipe(Effect.provide(layerSessions)),
);
