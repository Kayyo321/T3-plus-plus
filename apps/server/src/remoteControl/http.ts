import {
  ComputerUseSnapshot,
  REMOTE_CONTROL_COMPUTER_STREAM_ROUTE,
  REMOTE_CONTROL_COMPUTER_SCREENSHOT_ROUTE,
  REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE,
  REMOTE_CONTROL_COMPUTER_STOP_ROUTE,
  RemoteControlComputerApprovalRequest,
  OrchestrationV2CommandOutputFrame,
  REMOTE_CONTROL_ATTACHMENT_ROUTE,
  REMOTE_CONTROL_COMMAND_OUTPUT_ROUTE,
  REMOTE_CONTROL_HISTORY_ROUTE,
  REMOTE_CONTROL_ITEM_ROUTE,
  REMOTE_CONTROL_MEDIA_ROUTE,
  REMOTE_CONTROL_MESSAGES_ROUTE,
  REMOTE_CONTROL_MODE_ROUTE,
  REMOTE_CONTROL_MODEL_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_REACT_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_SEND_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_STOP_ROUTE,
  REMOTE_CONTROL_ORCHESTRATOR_STREAM_ROUTE,
  REMOTE_CONTROL_PAIR_CODE_ROUTE,
  REMOTE_CONTROL_PAIR_START_ROUTE,
  REMOTE_CONTROL_PAIR_STATUS_ROUTE,
  REMOTE_CONTROL_PAIRING_TTL_MS,
  REMOTE_CONTROL_PROVIDERS_ROUTE,
  REMOTE_CONTROL_RENAME_ROUTE,
  REMOTE_CONTROL_RENDER_ROUTE,
  REMOTE_CONTROL_RESPOND_ROUTE,
  REMOTE_CONTROL_ROUTE_PREFIX,
  REMOTE_CONTROL_SESSION_ROUTE,
  REMOTE_CONTROL_SESSION_TTL_MS,
  REMOTE_CONTROL_SIGN_OUT_ROUTE,
  REMOTE_CONTROL_STOP_ROUTE,
  REMOTE_CONTROL_STREAM_ROUTE,
  REMOTE_CONTROL_SWITCH_PARAM,
  RemoteControlAccessError,
  RemoteControlModelRequest,
  RemoteControlModeRequest,
  RemoteControlOrchestratorEvent,
  RemoteControlOrchestratorReactRequest,
  RemoteControlOrchestratorSendRequest,
  RemoteControlPairCodeRequest,
  RemoteControlPairingProgress,
  RemoteControlPairStartRequest,
  RemoteControlProviders,
  RemoteControlRenameRequest,
  RemoteControlRespondRequest,
  RemoteControlStreamEvent,
  remoteControlPairingCookieName,
  remoteControlSessionCookieName,
} from "@t3tools/contracts";
import { htmlRenderFileName } from "@t3tools/shared/htmlRender";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeOS from "node:os";

import { requestLocalAddress, requestPeerAddress } from "../auth/utils.ts";
import { tailscaleInterfaceAddresses } from "../environment/DirectEndpoints.ts";
import {
  attachmentFileResponse,
  encodeHistoryPage,
  encodeItem,
  eventStreamResponse,
  FILE_HEADERS,
  NO_STORE,
  readJson,
  readSubmission,
} from "../guest/http.ts";
import { assetFileResponse } from "../http.ts";
import * as RemoteControl from "./RemoteControlService.ts";
import { classifyRemoteTransport, type RemoteTransport } from "./remoteRoutes.ts";

const decodePairStart = Schema.decodeUnknownEffect(RemoteControlPairStartRequest);
const decodePairCode = Schema.decodeUnknownEffect(RemoteControlPairCodeRequest);
const decodeRespond = Schema.decodeUnknownEffect(RemoteControlRespondRequest);
const decodeMode = Schema.decodeUnknownEffect(RemoteControlModeRequest);
const decodeModel = Schema.decodeUnknownEffect(RemoteControlModelRequest);
const decodeRename = Schema.decodeUnknownEffect(RemoteControlRenameRequest);
const decodeOrchestratorSend = Schema.decodeUnknownEffect(RemoteControlOrchestratorSendRequest);
const decodeOrchestratorReact = Schema.decodeUnknownEffect(RemoteControlOrchestratorReactRequest);
const encodeProviders = Schema.encodeEffect(Schema.toCodecJson(RemoteControlProviders));
const encodeOrchestratorEvent = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(RemoteControlOrchestratorEvent)),
);
const encodeProgress = Schema.encodeEffect(Schema.toCodecJson(RemoteControlPairingProgress));
const encodeStreamEvent = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(RemoteControlStreamEvent)),
);
const encodeOutputFrame = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CommandOutputFrame),
);

const STATUS_BY_REASON: Partial<Record<RemoteControlAccessError["reason"], number>> = {
  ended: 401,
  session_expired: 401,
  invalid: 403,
  used: 403,
  link_expired: 403,
  locked: 403,
  denied: 403,
  pairing_expired: 403,
  forbidden: 403,
  unencrypted: 403,
  unavailable: 404,
  rate_limited: 429,
  upload_budget: 429,
  wrong_code: 400,
  empty: 400,
  too_many_files: 400,
  too_large: 400,
  unsupported_file: 400,
};

const errorResponse = (error: RemoteControlAccessError) =>
  HttpServerResponse.json(
    {
      reason: error.reason,
      message: error.message,
      ...(error.attemptsLeft === undefined ? {} : { attemptsLeft: error.attemptsLeft }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    },
    {
      status: STATUS_BY_REASON[error.reason] ?? 409,
      headers: {
        ...NO_STORE,
        ...(error.retryAfterMs === undefined
          ? {}
          : { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) }),
      },
    },
  );

const badRequest = HttpServerResponse.json(
  { reason: "rejected", message: "The request was not valid." },
  { status: 400, headers: NO_STORE },
);
const noContent = HttpServerResponse.empty({ status: 204, headers: NO_STORE });

const queryOf = (request: HttpServerRequest.HttpServerRequest) =>
  new URLSearchParams(request.url.split("?", 2)[1] ?? "");

const transportOf = (request: HttpServerRequest.HttpServerRequest): RemoteTransport =>
  classifyRemoteTransport({
    peer: requestPeerAddress(request),
    forwardedProto: request.headers["x-forwarded-proto"],
    arrivedOnTailnet: () => {
      const local = requestLocalAddress(request);
      return (
        local !== undefined && tailscaleInterfaceAddresses(NodeOS.networkInterfaces()).has(local)
      );
    },
  });

/** The session this browser holds for the switch the request names in `?switch=`. */
const deviceCredential = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request): RemoteControl.RemoteDeviceCredential => {
    const switchId = queryOf(request).get(REMOTE_CONTROL_SWITCH_PARAM) ?? "";
    return {
      switchId,
      token: request.cookies[remoteControlSessionCookieName(switchId)] ?? "",
      transport: transportOf(request),
    };
  },
);

const pairingCredential = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request): RemoteControl.RemotePairingCredential => {
    const switchId = queryOf(request).get(REMOTE_CONTROL_SWITCH_PARAM) ?? "";
    return {
      switchId,
      secret: request.cookies[remoteControlPairingCookieName(switchId)] ?? "",
      transport: transportOf(request),
    };
  },
);

/**
 * `Secure` only when the browser sees HTTPS. A browser drops a Secure cookie set over plain HTTP,
 * which would strand every LAN device. Such a session is instead tied to its address and capped
 * at Chat, because the cookie crosses the network in the clear.
 */
const cookieOptions = (transport: RemoteTransport, path: string, lifetimeMs: number) => ({
  httpOnly: true,
  secure: transport.https,
  sameSite: "strict" as const,
  path,
  maxAge: Duration.millis(lifetimeMs),
});

const PAIRING_COOKIE_PATH = `${REMOTE_CONTROL_ROUTE_PREFIX}/pair`;

export const pairingResponse = Effect.fn("RemoteControlHttp.pairingResponse")(function* (
  outcome: RemoteControl.RemotePairingOutcome,
  transport: RemoteTransport,
  pairingSecret: string | null,
) {
  const { switchId } = outcome.progress;
  const body = yield* encodeProgress(outcome.progress).pipe(
    Effect.mapError(() => new RemoteControlAccessError({ reason: "rejected" })),
  );
  let response = HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE });
  if (pairingSecret !== null) {
    response = yield* HttpServerResponse.setCookie(
      response,
      remoteControlPairingCookieName(switchId),
      pairingSecret,
      cookieOptions(transport, PAIRING_COOKIE_PATH, REMOTE_CONTROL_PAIRING_TTL_MS),
    );
  }
  if (outcome.sessionToken !== null) {
    response = yield* HttpServerResponse.setCookie(
      response,
      remoteControlSessionCookieName(switchId),
      outcome.sessionToken,
      cookieOptions(transport, REMOTE_CONTROL_ROUTE_PREFIX, REMOTE_CONTROL_SESSION_TTL_MS),
    );
    response = yield* HttpServerResponse.expireCookie(
      response,
      remoteControlPairingCookieName(switchId),
      { path: PAIRING_COOKIE_PATH },
    );
  }
  return response;
});

const pairStartRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_PAIR_START_ROUTE,
  Effect.gen(function* () {
    const body = yield* readJson.pipe(Effect.flatMap(decodePairStart), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const transport = transportOf(request);
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.startPairing(body.value, transport).pipe(
      Effect.flatMap((outcome) => pairingResponse(outcome, transport, outcome.pairingSecret)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const pairStatusRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_PAIR_STATUS_ROUTE,
  Effect.gen(function* () {
    const credential = yield* pairingCredential;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.pairingStatus(credential).pipe(
      Effect.flatMap((outcome) => pairingResponse(outcome, credential.transport, null)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const pairCodeRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_PAIR_CODE_ROUTE,
  Effect.gen(function* () {
    const body = yield* readJson.pipe(Effect.flatMap(decodePairCode), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const credential = yield* pairingCredential;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.submitCode(credential, body.value).pipe(
      Effect.flatMap((outcome) => pairingResponse(outcome, credential.transport, null)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const sessionRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_SESSION_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    const credential = yield* deviceCredential;
    // The owner can extend a device after it paired, so the cookie follows the current limit.
    return yield* remote.sessionLifetimeMs(credential).pipe(
      Effect.flatMap((lifetimeMs) =>
        HttpServerResponse.setCookie(
          noContent,
          remoteControlSessionCookieName(credential.switchId),
          credential.token,
          cookieOptions(credential.transport, REMOTE_CONTROL_ROUTE_PREFIX, lifetimeMs),
        ),
      ),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const signOutRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_SIGN_OUT_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    const credential = yield* deviceCredential;
    return yield* remote.signOut(credential).pipe(
      Effect.flatMap(() =>
        HttpServerResponse.expireCookie(
          noContent,
          remoteControlSessionCookieName(credential.switchId),
          { path: REMOTE_CONTROL_ROUTE_PREFIX },
        ),
      ),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const streamRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_STREAM_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const after = Number(queryOf(request).get("after") ?? Number.NaN);
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote
      .stream(
        yield* deviceCredential,
        Number.isSafeInteger(after) && after >= 0 ? after : undefined,
      )
      .pipe(
        Effect.map((events) => eventStreamResponse(events, encodeStreamEvent)),
        Effect.catchTags({ RemoteControlAccessError: errorResponse }),
      );
  }),
);

const itemRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_ITEM_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const itemId = queryOf(request).get("item");
    if (!itemId) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.item(yield* deviceCredential, itemId).pipe(
      Effect.flatMap((result) =>
        encodeItem(result).pipe(
          Effect.mapError(() => new RemoteControlAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const historyRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_HISTORY_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const cursor = queryOf(request).get("cursor");
    if (!cursor) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.history(yield* deviceCredential, cursor).pipe(
      Effect.flatMap((page) =>
        encodeHistoryPage(page).pipe(
          Effect.mapError(() => new RemoteControlAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const commandOutputRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_COMMAND_OUTPUT_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const itemId = queryOf(request).get("item");
    if (!itemId) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.commandOutput(yield* deviceCredential, itemId).pipe(
      Effect.map((frames) => eventStreamResponse(frames, encodeOutputFrame)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const attachmentRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_ATTACHMENT_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const attachmentId = queryOf(request).get("id");
    if (!attachmentId) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.attachment(yield* deviceCredential, attachmentId).pipe(
      Effect.flatMap(attachmentFileResponse),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
    );
  }),
);

const mediaRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_MEDIA_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const path = queryOf(request).get("path");
    if (!path) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.media(yield* deviceCredential, path).pipe(
      Effect.flatMap((file) =>
        HttpServerResponse.file(file.path, {
          headers: { ...FILE_HEADERS, "content-type": file.mimeType },
        }),
      ),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
      Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500, headers: NO_STORE })),
    );
  }),
);

// As on guest routes, the asset route's sandbox CSP gives the page an opaque origin, so its
// scripts can neither send the session cookie nor call these routes.
const renderRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_RENDER_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const itemId = queryOf(request).get("item");
    if (!itemId) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.render(yield* deviceCredential, itemId).pipe(
      Effect.flatMap(({ path, title }) =>
        assetFileResponse({ path, mimeType: "text/html", fileName: htmlRenderFileName(title) }),
      ),
      Effect.map((response) => HttpServerResponse.setHeaders(response, NO_STORE)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const messagesRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_MESSAGES_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    const credential = yield* deviceCredential;
    // Checked before the body is read, so only a device that may send can make the server parse
    // and store up to 10 MB.
    yield* remote.session(credential, "chat");
    const submission = yield* readSubmission.pipe(
      Effect.mapError(
        (error) =>
          new RemoteControlAccessError({
            reason:
              error.reason === "too_many_files" || error.reason === "too_large"
                ? error.reason
                : "rejected",
          }),
      ),
    );
    if (submission === null) return yield* badRequest;
    yield* remote.submit(credential, submission.fields, submission.uploads);
    return noContent;
  }).pipe(
    Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    // The parser's temporary files are removed once the response is ready.
    Effect.scoped,
  ),
);

const respondRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_RESPOND_ROUTE,
  Effect.gen(function* () {
    const body = yield* readJson.pipe(Effect.flatMap(decodeRespond), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote
      .respond(yield* deviceCredential, body.value)
      .pipe(Effect.as(noContent), Effect.catchTags({ RemoteControlAccessError: errorResponse }));
  }),
);

const stopRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_STOP_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote
      .stop(yield* deviceCredential)
      .pipe(Effect.as(noContent), Effect.catchTags({ RemoteControlAccessError: errorResponse }));
  }),
);

const modeRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_MODE_ROUTE,
  Effect.gen(function* () {
    const body = yield* readJson.pipe(Effect.flatMap(decodeMode), Effect.option);
    if (body._tag === "None") return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote
      .setMode(yield* deviceCredential, body.value)
      .pipe(Effect.as(noContent), Effect.catchTags({ RemoteControlAccessError: errorResponse }));
  }),
);

/** A POST that decodes a JSON body and answers with no content. */
const jsonAction = <A, E>(
  route: `/${string}`,
  decode: (body: unknown) => Effect.Effect<A, E>,
  run: (
    remote: RemoteControl.RemoteControlService["Service"],
    credential: RemoteControl.RemoteDeviceCredential,
    body: A,
  ) => Effect.Effect<void, RemoteControlAccessError>,
) =>
  HttpRouter.add(
    "POST",
    route,
    Effect.gen(function* () {
      const body = yield* readJson.pipe(Effect.flatMap(decode), Effect.option);
      if (body._tag === "None") return yield* badRequest;
      const remote = yield* RemoteControl.RemoteControlService;
      return yield* run(remote, yield* deviceCredential, body.value).pipe(
        Effect.as(noContent),
        Effect.catchTags({ RemoteControlAccessError: errorResponse }),
      );
    }),
  );

const modelRoute = jsonAction(REMOTE_CONTROL_MODEL_ROUTE, decodeModel, (remote, credential, body) =>
  remote.setModel(credential, body),
);
const renameRoute = jsonAction(
  REMOTE_CONTROL_RENAME_ROUTE,
  decodeRename,
  (remote, credential, body) => remote.rename(credential, body),
);
const orchestratorSendRoute = jsonAction(
  REMOTE_CONTROL_ORCHESTRATOR_SEND_ROUTE,
  decodeOrchestratorSend,
  (remote, credential, body) => remote.orchestratorSend(credential, body),
);
const orchestratorReactRoute = jsonAction(
  REMOTE_CONTROL_ORCHESTRATOR_REACT_ROUTE,
  decodeOrchestratorReact,
  (remote, credential, body) => remote.orchestratorReact(credential, body),
);

const orchestratorStreamRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_ORCHESTRATOR_STREAM_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.orchestratorStream(yield* deviceCredential).pipe(
      Effect.map((events) => eventStreamResponse(events, encodeOrchestratorEvent)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const orchestratorStopRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_ORCHESTRATOR_STOP_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote
      .orchestratorStop(yield* deviceCredential)
      .pipe(Effect.as(noContent), Effect.catchTags({ RemoteControlAccessError: errorResponse }));
  }),
);

const providersRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_PROVIDERS_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.providers(yield* deviceCredential).pipe(
      Effect.flatMap((result) =>
        encodeProviders(result).pipe(
          Effect.mapError(() => new RemoteControlAccessError({ reason: "unavailable" })),
        ),
      ),
      Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { headers: NO_STORE })),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

const encodeComputerSnapshot = Schema.encodeEffect(Schema.fromJsonString(ComputerUseSnapshot));
const computerStreamRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_COMPUTER_STREAM_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.computerStream(yield* deviceCredential).pipe(
      Effect.map((events) => eventStreamResponse(events, encodeComputerSnapshot)),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);
const computerScreenshotRoute = HttpRouter.add(
  "GET",
  REMOTE_CONTROL_COMPUTER_SCREENSHOT_ROUTE,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const stepId = queryOf(request).get("stepId");
    if (stepId === null || stepId.length === 0) return yield* badRequest;
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.computerScreenshot(yield* deviceCredential, stepId).pipe(
      Effect.flatMap((snapshot) => HttpServerResponse.json(snapshot, { headers: NO_STORE })),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);
const computerApprovalRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_COMPUTER_APPROVAL_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    const credential = yield* deviceCredential;
    yield* remote.session(credential, "approve");
    const body = yield* readJson.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RemoteControlComputerApprovalRequest)),
      Effect.option,
    );
    if (body._tag === "None") return yield* badRequest;
    return yield* remote
      .answerComputerApproval(credential, body.value)
      .pipe(Effect.flatMap((state) => HttpServerResponse.json(state, { headers: NO_STORE })));
  }).pipe(Effect.catchTags({ RemoteControlAccessError: errorResponse })),
);
const computerStopRoute = HttpRouter.add(
  "POST",
  REMOTE_CONTROL_COMPUTER_STOP_ROUTE,
  Effect.gen(function* () {
    const remote = yield* RemoteControl.RemoteControlService;
    return yield* remote.stopComputer(yield* deviceCredential).pipe(
      Effect.flatMap((state) => HttpServerResponse.json(state, { headers: NO_STORE })),
      Effect.catchTags({ RemoteControlAccessError: errorResponse }),
    );
  }),
);

export const layer = Layer.mergeAll(
  modelRoute,
  renameRoute,
  providersRoute,
  orchestratorStreamRoute,
  orchestratorSendRoute,
  orchestratorReactRoute,
  orchestratorStopRoute,
  computerStreamRoute,
  computerScreenshotRoute,
  computerApprovalRoute,
  computerStopRoute,
  pairStartRoute,
  pairStatusRoute,
  pairCodeRoute,
  sessionRoute,
  signOutRoute,
  streamRoute,
  itemRoute,
  historyRoute,
  commandOutputRoute,
  attachmentRoute,
  mediaRoute,
  renderRoute,
  messagesRoute,
  respondRoute,
  stopRoute,
  modeRoute,
);
