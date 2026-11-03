import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  type ComputerUseActInput,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as AuditTrail from "../audit/AuditTrail.ts";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { classifyStep } from "./classifyStep.ts";
import * as ComputerUseService from "./ComputerUseService.ts";
import * as VirtualDisplay from "./VirtualDisplay.ts";

const SCREEN = new Uint8Array([137, 80, 78, 71]);

const acted: ComputerUseActInput[] = [];
const browser: ComputerUseService.BrowserDriver = {
  act: (input) =>
    Effect.sync(() => {
      acted.push(input);
      return "Done.";
    }),
  screenshot: Effect.succeed(SCREEN),
};

const opened: string[] = [];
const closed: string[] = [];

const makeLayer = (computerUseEnabled: boolean) =>
  ComputerUseService.layer.pipe(
    Layer.provideMerge(AuditTrail.layer),
    Layer.provideMerge(
      Layer.mock(VirtualDisplay.VirtualDisplay)({
        availability: Effect.succeed({ available: true, missing: [] }),
        open: (threadId) =>
          Effect.sync(() => {
            opened.push(threadId);
            return ":110";
          }),
        close: (threadId) => Effect.sync(() => void closed.push(threadId)),
        screenshot: () => Effect.succeed(SCREEN),
        act: () => Effect.succeed("Done."),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, computerUseEnabled }),
      }),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-computer-use-" })),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
  );

const click = (intent: string): ComputerUseActInput => ({ action: "click", intent, x: 10, y: 20 });

const thread = (name: string) => ThreadId.make(`thread-${name}`);

const service = ComputerUseService.ComputerUseService;

it.layer(makeLayer(true))("ComputerUseService", (it) => {
  it.effect("is off until a person turns it on", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("default-off");
      expect((yield* computer.getState(threadId)).status).toBe("off");
      const before = acted.length;
      const error = yield* computer.act(threadId, click("Open menu"), browser).pipe(Effect.flip);
      expect(error.code).toBe("off");
      expect(acted.length).toBe(before);
      const screenshot = yield* computer.screenshot(threadId, browser).pipe(Effect.flip);
      expect(screenshot.code).toBe("off");
    }),
  );

  it.effect("logs each step with its screenshot", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("steps");
      yield* computer.start({ threadId, target: "browser" });
      const { stepId } = yield* computer.act(threadId, click("Open the menu"), browser);
      const { steps } = yield* computer.listSteps({ threadId });
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({ id: stepId, status: "ok", hasScreenshot: true });
      const stored = yield* computer.getScreenshot({ threadId, stepId });
      expect(stored.data).toBe(Buffer.from(SCREEN).toString("base64"));
    }),
  );

  it.effect("stop takes effect at once, and starts nothing afterwards", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("stop");
      yield* computer.start({ threadId, target: "virtual-display" });
      expect((yield* computer.getState(threadId)).display).toBe(":110");
      const stopped = yield* computer.stop(threadId);
      expect(stopped.status).toBe("off");
      expect(closed).toContain(threadId);
      const error = yield* computer.act(threadId, click("Open"), browser).pipe(Effect.flip);
      expect(error.code).toBe("off");
    }),
  );

  it.effect("stopping when already off still succeeds", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      expect((yield* computer.stop(thread("never-started"))).status).toBe("off");
    }),
  );

  it.effect("stop ends a step waiting for approval, and the step does not run", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("stop-approval");
      yield* computer.start({ threadId, target: "browser" });
      const before = acted.length;
      const waiting = yield* computer
        .act(threadId, click("Delete the repository"), browser)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      const pending = yield* computer.getState(threadId);
      expect(pending.pendingApproval?.sensitivity).toBe("delete");

      yield* computer.stop(threadId);
      const error = yield* Fiber.join(waiting);
      expect(error.code).toBe("denied");
      expect(acted.length).toBe(before);
    }),
  );

  it.effect("runs a sensitive step only once a person approves it", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("approve");
      yield* computer.start({ threadId, target: "browser" });
      const before = acted.length;
      const waiting = yield* computer
        .act(threadId, click("Place your order"), browser)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(acted.length).toBe(before);
      const { pendingApproval } = yield* computer.getState(threadId);
      assert.isNotNull(pendingApproval);
      yield* computer.answerApproval({
        threadId,
        approvalId: pendingApproval?.id ?? "",
        approved: true,
      });
      yield* Fiber.join(waiting);
      expect(acted.length).toBe(before + 1);
      expect((yield* computer.getState(threadId)).pendingApproval).toBeNull();
    }),
  );

  it.effect("treats no answer as a refusal", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("approval-timeout");
      yield* computer.start({ threadId, target: "browser" });
      const waiting = yield* computer
        .act(threadId, click("Send the message"), browser)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("6 minutes");
      expect((yield* Fiber.join(waiting)).code).toBe("denied");
      const { steps } = yield* computer.listSteps({ threadId });
      expect(steps[0]).toMatchObject({ status: "denied", sensitivity: "message" });
    }),
  );

  it.effect("refuses to type a credential even if told to", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("credentials");
      yield* computer.start({ threadId, target: "browser" });
      const error = yield* computer
        .act(
          threadId,
          { action: "type", intent: "Enter the password", text: "hunter2", locator: "#password" },
          browser,
        )
        .pipe(Effect.flip);
      expect(error.code).toBe("refused");
      expect((yield* computer.listSteps({ threadId })).steps[0]?.status).toBe("refused");
    }),
  );

  it.effect("taking over stops the agent until it is handed back", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("take-over");
      yield* computer.start({ threadId, target: "browser" });
      yield* computer.takeOver(threadId);
      const error = yield* computer.act(threadId, click("Open"), browser).pipe(Effect.flip);
      expect(error.code).toBe("taken_over");
      yield* computer.resume(threadId);
      yield* computer.act(threadId, click("Open"), browser);
    }),
  );

  it.effect("deleting a conversation stops it and clears its log", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const threadId = thread("deleted");
      yield* computer.start({ threadId, target: "browser" });
      yield* computer.act(threadId, click("Open"), browser);
      yield* computer.deleteForThread(threadId);
      expect((yield* computer.getState(threadId)).status).toBe("off");
      expect((yield* computer.listSteps({ threadId })).steps).toEqual([]);
    }),
  );
});

it.layer(makeLayer(false))("with computer use off in Settings", (it) => {
  it.effect("no conversation can turn it on", () =>
    Effect.gen(function* () {
      const computer = yield* service;
      const error = yield* computer
        .start({ threadId: thread("settings-off"), target: "browser" })
        .pipe(Effect.flip);
      expect(error.code).toBe("unavailable");
      expect((yield* computer.support).enabled).toBe(false);
    }),
  );
});

describe("access", () => {
  it("every input method needs the operate scope a view-only guest lacks", () => {
    for (const method of [
      WS_METHODS.computerUseStart,
      WS_METHODS.computerUseStop,
      WS_METHODS.computerUseTakeOver,
      WS_METHODS.computerUseResume,
      WS_METHODS.computerUseAnswerApproval,
    ]) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("orchestration:operate");
    }
  });
});

describe("classifyStep", () => {
  it.each([
    [
      { action: "type", intent: "Fill in the form", text: "ghp_abcdefghijklmnopqrstuvwxyz012345" },
      "credentials",
    ],
    [{ action: "type", intent: "Fill in the form", text: "4242 4242 4242 4242" }, "credentials"],
    [
      { action: "type", intent: "Sign in", locator: "input[name=password]", text: "x" },
      "credentials",
    ],
    [
      { action: "type", intent: "Fill in the form", sensitivity: "credentials", text: "x" },
      "credentials",
    ],
    [{ action: "click", intent: "Click Buy now" }, "purchase"],
    [{ action: "navigate", intent: "Continue", url: "https://shop.test/checkout" }, "purchase"],
    [{ action: "click", intent: "Delete the branch" }, "delete"],
    [{ action: "key", intent: "Press Enter to send", key: "Enter" }, "message"],
    [{ action: "click", intent: "Tap the button", sensitivity: "purchase" }, "purchase"],
    [{ action: "click", intent: "Open the settings page" }, null],
    [{ action: "type", intent: "Search the docs", text: "4242" }, null],
  ] as const)("reads %j as %s", (input, expected) => {
    expect(classifyStep(input)).toBe(expected);
  });
});

describe("xdotoolArguments", () => {
  it("clicks where it is told, and refuses what a display cannot do", () => {
    expect(VirtualDisplay.xdotoolArguments(click("Open"))).toEqual([
      "mousemove",
      "10",
      "20",
      "click",
      "1",
    ]);
    expect(
      VirtualDisplay.xdotoolArguments({ action: "type", intent: "Search", text: "-rf" }),
    ).toEqual(["type", "--delay", "12", "--", "-rf"]);
    expect(
      VirtualDisplay.xdotoolArguments({ action: "navigate", intent: "Go", url: "https://a.test" }),
    ).toBeNull();
  });

  it.each([
    ["Enter", "Return"],
    ["Backspace", "BackSpace"],
    ["ArrowDown", "Down"],
    ["PageDown", "Page_Down"],
    ["Control+Shift+t", "ctrl+Shift+t"],
    ["Tab", "Tab"],
  ])("presses the browser key %s as the X key %s", (key, xKey) => {
    expect(VirtualDisplay.xdotoolArguments({ action: "key", intent: "Press", key })).toEqual([
      "key",
      "--",
      xKey,
    ]);
  });

  it.effect("fails a key xdotool ignores instead of reporting it done", () =>
    Effect.gen(function* () {
      const display = yield* VirtualDisplay.VirtualDisplay;
      const error = yield* display
        .act(":110", { action: "key", intent: "Press", key: "Hyper_Q" })
        .pipe(Effect.flip);
      expect(error.message).toBe(
        'No key is named "Hyper_Q". Try Enter, Tab, Escape, or Control+A.',
      );
    }).pipe(
      Effect.provide(
        VirtualDisplay.layerXvfb.pipe(
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () =>
                Effect.succeed({
                  stdout: "",
                  stderr: "(symbol) No such key name 'Hyper_Q'. Ignoring it.\n",
                  code: ChildProcessSpawner.ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
            }),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );
});
