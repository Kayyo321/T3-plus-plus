import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ComputerUseTarget,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AuditTrail from "../../../audit/AuditTrail.ts";
import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as VirtualDisplay from "../../../computerUse/VirtualDisplay.ts";
import * as ServerConfig from "../../../config.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as Handlers from "./handlers.ts";
import { ComputerUseStandardToolkit } from "./tools.ts";

it.effect.each([
  { target: "browser", tabOpen: false, expectedOpens: 1 },
  { target: "browser", tabOpen: true, expectedOpens: 0 },
  { target: "virtual-display", tabOpen: false, expectedOpens: 0 },
] satisfies ReadonlyArray<{ target: ComputerUseTarget; tabOpen: boolean; expectedOpens: number }>)(
  "operates $target with an existing browser tab=$tabOpen",
  ({ target, tabOpen: initialTabOpen, expectedOpens }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = ThreadId.make("computer-use-new-thread");
        const requests: PreviewAutomationOperation[] = [];
        let tabOpen = initialTabOpen;
        const screen = new Uint8Array([137, 80, 78, 71]);
        const dependencies = ComputerUseService.layer.pipe(
          Layer.provideMerge(AuditTrail.layer),
          Layer.provideMerge(
            Layer.mock(VirtualDisplay.VirtualDisplay)({
              availability: Effect.succeed({ available: true, missing: [] }),
              open: () => Effect.succeed(":110"),
              close: () => Effect.void,
              act: () => Effect.succeed("Done."),
              screenshot: () => Effect.succeed(screen),
            }),
          ),
          Layer.provideMerge(
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, computerUseEnabled: true }),
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "computer-use-tools-" }),
          ),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(NodeCrypto.layer),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
          Layer.provideMerge(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("computer-use-environment"),
              requestNamespace: "computer-use-session",
              thread: {
                threadId,
                providerSessionId: "computer-use-session",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["computer-use"] as const),
              issuedAt: 0,
            }),
          ),
          Layer.provideMerge(
            Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
              invoke: <A>({ operation }: PreviewAutomationBroker.PreviewAutomationInvokeInput) =>
                Effect.sync(() => {
                  requests.push(operation);
                  if (operation === "status")
                    return { tabId: tabOpen ? "tab:computer-use" : null } as A;
                  if (operation === "open") {
                    tabOpen = true;
                    return {} as A;
                  }
                  expect(tabOpen).toBe(true);
                  return { screenshot: { data: Buffer.from(screen).toString("base64") } } as A;
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const computer = yield* ComputerUseService.ComputerUseService;
          yield* computer.start({ threadId, target });
          const toolkit = yield* ComputerUseStandardToolkit;
          const result = yield* toolkit
            .handle("computer_act", { action: "click", intent: "Open the menu", x: 10, y: 20 })
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(result.at(-1)?.result).toMatchObject({ result: "Done." });
          expect(requests.filter((operation) => operation === "open")).toHaveLength(expectedOpens);
          if (target === "virtual-display") expect(requests).toEqual([]);
          expect((yield* computer.listSteps({ threadId })).steps[0]).toMatchObject({
            target,
            status: "ok",
            hasScreenshot: true,
          });
          yield* computer.stop(threadId);
          const requestCount = requests.length;
          const stopped = yield* toolkit
            .handle("computer_act", { action: "click", intent: "Open the menu", x: 10, y: 20 })
            .pipe(Stream.unwrap, Stream.runCollect);
          expect(stopped.at(-1)?.result).toMatchObject({ code: "capability_denied" });
          expect(requests).toHaveLength(requestCount);
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(Handlers.layerStandard).pipe(
              Layer.provideMerge(dependencies),
            ),
          ),
        );
      }),
    ),
);
