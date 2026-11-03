import { type ComputerUseActInput, ComputerUseError, type ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";

const REQUIRED_PROGRAMS = ["Xvfb", "xdotool", "import"] as const;
const FIRST_DISPLAY = 110;
const LAST_DISPLAY = 199;
const SCREEN_SIZE = "1280x800x24";
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

const failed = (message: string, cause?: unknown) =>
  new ComputerUseError({ code: "failed", message, ...(cause === undefined ? {} : { cause }) });

/** Where an agent works without touching the person's desktop: a private X server per conversation. */
export class VirtualDisplay extends Context.Service<
  VirtualDisplay,
  {
    readonly availability: Effect.Effect<{
      readonly available: boolean;
      readonly missing: ReadonlyArray<string>;
    }>;
    /** Starts the conversation's display and returns its name, such as `:110`. */
    readonly open: (threadId: ThreadId) => Effect.Effect<string, ComputerUseError>;
    /** Kills the conversation's display, and every window on it. */
    readonly close: (threadId: ThreadId) => Effect.Effect<void>;
    readonly screenshot: (display: string) => Effect.Effect<Uint8Array, ComputerUseError>;
    readonly act: (
      display: string,
      input: ComputerUseActInput,
    ) => Effect.Effect<string, ComputerUseError>;
  }
>()("t3pp/computerUse/VirtualDisplay") {}

/** `computer_act` documents browser key names, such as Enter; X calls some of them otherwise. */
const X_KEY_NAMES: Readonly<Record<string, string>> = {
  enter: "Return",
  backspace: "BackSpace",
  esc: "Escape",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  space: "space",
  control: "ctrl",
  controlormeta: "ctrl",
  meta: "super",
};

const xKey = (key: string) =>
  key
    .split("+")
    .map((part) => X_KEY_NAMES[part.toLowerCase()] ?? part)
    .join("+");

/** The `xdotool` arguments for a step. Null when a display has no such step. */
export function xdotoolArguments(input: ComputerUseActInput): ReadonlyArray<string> | null {
  const moved =
    input.x === undefined || input.y === undefined
      ? []
      : ["mousemove", String(Math.round(input.x)), String(Math.round(input.y))];
  switch (input.action) {
    case "click":
      return [...moved, "click", "1"];
    case "double_click":
      return [...moved, "click", "--repeat", "2", "1"];
    case "type":
      return input.text === undefined ? null : ["type", "--delay", "12", "--", input.text];
    case "key":
      return input.key === undefined ? null : ["key", "--", xKey(input.key)];
    case "scroll": {
      const button = (input.deltaY ?? 0) < 0 ? "4" : "5";
      const notches = Math.max(1, Math.min(20, Math.round(Math.abs(input.deltaY ?? 120) / 120)));
      return [...moved, "click", "--repeat", String(notches), button];
    }
    case "navigate":
      return null;
  }
}

export const layerXvfb = Layer.effect(
  VirtualDisplay,
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const open = yield* Ref.make<
      ReadonlyMap<ThreadId, { readonly display: string; readonly scope: Scope.Closeable }>
    >(new Map());
    const isInstalled = (program: string) =>
      processes.run({ command: "which", args: [program], timeout: "5 seconds" }).pipe(
        Effect.map((output) => output.code === 0),
        Effect.orElseSucceed(() => false),
      );

    const availability: VirtualDisplay["Service"]["availability"] = Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "linux") {
        return { available: false, missing: [...REQUIRED_PROGRAMS] };
      }
      const installed = yield* Effect.forEach(REQUIRED_PROGRAMS, isInstalled);
      const missing = REQUIRED_PROGRAMS.filter((_program, index) => !installed[index]);
      return { available: missing.length === 0, missing };
    });

    const freeDisplay = Effect.gen(function* () {
      const taken = new Set([...(yield* Ref.get(open)).values()].map((entry) => entry.display));
      for (let number = FIRST_DISPLAY; number <= LAST_DISPLAY; number += 1) {
        const lock = yield* fileSystem
          .exists(`/tmp/.X${number}-lock`)
          .pipe(Effect.orElseSucceed(() => true));
        if (!lock && !taken.has(`:${number}`)) return `:${number}`;
      }
      return yield* failed("No free display number.");
    });

    const close: VirtualDisplay["Service"]["close"] = Effect.fn("VirtualDisplay.close")(
      function* (threadId) {
        const entry = (yield* Ref.get(open)).get(threadId);
        if (entry === undefined) return;
        yield* Ref.update(open, (current) => {
          const next = new Map(current);
          next.delete(threadId);
          return next;
        });
        yield* Scope.close(entry.scope, Exit.void);
      },
    );

    const openDisplay: VirtualDisplay["Service"]["open"] = Effect.fn("VirtualDisplay.open")(
      function* (threadId) {
        const existing = (yield* Ref.get(open)).get(threadId);
        if (existing !== undefined) return existing.display;
        const { available, missing } = yield* availability;
        if (!available) {
          return yield* new ComputerUseError({
            code: "unavailable",
            message: `A virtual display needs ${missing.join(", ")} on this machine.`,
          });
        }
        const display = yield* freeDisplay;
        const scope = yield* Scope.make();
        // The process belongs to this scope, so closing it kills exactly this PID.
        yield* spawner
          .spawn(
            ChildProcess.make("Xvfb", [display, "-screen", "0", SCREEN_SIZE, "-nolisten", "tcp"], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Scope.provide(scope),
            Effect.mapError((cause) => failed("Could not start the virtual display.", cause)),
          );
        yield* Ref.update(open, (current) => new Map(current).set(threadId, { display, scope }));
        return display;
      },
    );

    const xdotool = (display: string, args: ReadonlyArray<string>) =>
      processes
        .run({
          command: "xdotool",
          args: [...args],
          timeout: "15 seconds",
          env: { ...process.env, DISPLAY: display },
        })
        .pipe(
          Effect.mapError((cause) => failed("The step could not run.", cause)),
          Effect.flatMap((output) => {
            // xdotool skips a key name it does not know and still exits 0.
            const unknownKey = /No such key name '([^']*)'/.exec(output.stderr)?.[1];
            if (unknownKey !== undefined) {
              return Effect.fail(
                failed(`No key is named "${unknownKey}". Try Enter, Tab, Escape, or Control+A.`),
              );
            }
            return output.code === 0
              ? Effect.succeed("Done.")
              : Effect.fail(failed(output.stderr.trim() || "The step failed."));
          }),
        );

    const screenshot: VirtualDisplay["Service"]["screenshot"] = Effect.fn(
      "VirtualDisplay.screenshot",
    )(function* (display) {
      const chunks: Uint8Array[] = [];
      const output = yield* processes
        .run({
          command: "import",
          args: ["-display", display, "-window", "root", "png:-"],
          timeout: "15 seconds",
          maxOutputBytes: MAX_SCREENSHOT_BYTES,
          outputMode: "truncate",
          onStdoutChunk: (chunk) => {
            chunks.push(chunk);
          },
        })
        .pipe(Effect.mapError((cause) => failed("Could not read the display.", cause)));
      if (output.code !== 0) return yield* failed("Could not read the display.");
      return Buffer.concat(chunks);
    });

    return VirtualDisplay.of({
      availability,
      open: openDisplay,
      close,
      screenshot,
      act: Effect.fn("VirtualDisplay.act")(function* (display, input) {
        const args = xdotoolArguments(input);
        if (args !== null) return yield* xdotool(display, args);
        return yield* new ComputerUseError({
          code: "refused",
          message:
            input.action === "navigate"
              ? "A virtual display has no address bar. Start a browser on it from your shell, using the `display` from `computer_status`."
              : `A ${input.action} step needs more detail.`,
        });
      }),
    });
  }),
);
