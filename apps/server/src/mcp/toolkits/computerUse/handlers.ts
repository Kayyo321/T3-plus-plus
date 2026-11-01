import {
  type ComputerUseActInput,
  ComputerUseError,
  OrchestratorMcpFailure,
  type PreviewAutomationOperation,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerUseService from "../../../computerUse/ComputerUseService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { ComputerScreenshotToolkit, ComputerUseStandardToolkit } from "./tools.ts";

const toFailure = (error: ComputerUseError) =>
  new OrchestratorMcpFailure({
    code: error.code === "failed" ? "orchestration_error" : "capability_denied",
    message: error.message,
  });

const computerCaller = McpInvocationContext.McpInvocationContext.pipe(
  Effect.filterOrFail(
    (scope) => scope.capabilities.has("computer-use"),
    () =>
      new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Computer use is turned off in Settings.",
      }),
  ),
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Computer use")),
);

/** A browser step as the preview broker takes it. Null: the step has no browser form. */
function browserOperation(input: ComputerUseActInput): {
  readonly operation: PreviewAutomationOperation;
  readonly input: Readonly<Record<string, unknown>>;
} | null {
  const target = {
    ...(input.locator === undefined ? {} : { locator: input.locator }),
    ...(input.locator === undefined && input.x !== undefined ? { x: input.x, y: input.y } : {}),
  };
  switch (input.action) {
    case "click":
      return { operation: "click", input: target };
    case "double_click":
      return { operation: "click", input: { ...target, clickCount: 2 } };
    case "type":
      return input.text === undefined
        ? null
        : { operation: "type", input: { ...target, text: input.text } };
    case "key":
      return input.key === undefined ? null : { operation: "press", input: { key: input.key } };
    case "scroll":
      return {
        operation: "scroll",
        input: { ...target, deltaX: input.deltaX ?? 0, deltaY: input.deltaY ?? 0 },
      };
    case "navigate":
      return input.url === undefined ? null : { operation: "navigate", input: { url: input.url } };
  }
}

// A browser failure reaches the agent as text, the same way `preview_act` reports it.
const browserFailure = (cause: { readonly message: string }) =>
  new ComputerUseError({ code: "failed", message: cause.message, cause });

/** Browser steps go through the caller's own preview session, with its tab ownership rules. */
const browserDriver = Effect.fn("ComputerUseToolkit.browserDriver")(function* (
  scope: McpInvocationContext.McpThreadInvocationScope,
) {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  return {
    act: (input: ComputerUseActInput) => {
      const step = browserOperation(input);
      if (step === null) {
        return Effect.fail(
          new ComputerUseError({
            code: "refused",
            message: `A ${input.action} step needs more detail.`,
          }),
        );
      }
      return broker
        .invoke({ scope, operation: step.operation, input: step.input })
        .pipe(Effect.as("Done."), Effect.mapError(browserFailure));
    },
    screenshot: broker
      .invoke<PreviewAutomationSnapshot>({ scope, operation: "snapshot", input: {} })
      .pipe(
        Effect.map((snapshot) => Buffer.from(snapshot.screenshot.data, "base64")),
        Effect.mapError(browserFailure),
      ),
  };
});

export const layerStandard = McpToolAccess.toLayer(ComputerUseStandardToolkit, {
  computer_status: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* computerCaller;
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service.getState(scope.thread.threadId);
    }),
  ),
  computer_act: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* computerCaller;
      const service = yield* ComputerUseService.ComputerUseService;
      return yield* service
        .act(scope.thread.threadId, input, yield* browserDriver(scope))
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* computerCaller;
      const service = yield* ComputerUseService.ComputerUseService;
      const { stepId, mimeType, data } = yield* service
        .screenshot(scope.thread.threadId, yield* browserDriver(scope))
        .pipe(Effect.mapError(toFailure));
      return { stepId, screenshot: { mimeType, data } };
    }),
  ),
});
