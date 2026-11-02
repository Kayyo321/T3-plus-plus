// @effect-diagnostics nodeBuiltinImport:off -- KWin only loads scripts from a path on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Message, sessionBus, type MessageBus } from "dbus-next";
import type { DesktopWindowPosition } from "@t3tools/contracts";

const KWIN = "org.kde.KWin";
const SCRIPTING_PATH = "/Scripting";
const SCRIPTING = "org.kde.kwin.Scripting";
const POSITION_PATH = "/dev/t3pp/WindowPosition";
const POSITION = "dev.t3pp.WindowPosition";

let latest: DesktopWindowPosition | null = null;

/** Null until KWin reports, which is always on other desktops. */
export const currentKWinWindowPosition = () => latest;

export const isKWinWaylandSession = (env: NodeJS.ProcessEnv) =>
  env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" &&
  (env.XDG_CURRENT_DESKTOP?.split(":") ?? []).some((name) => name.toUpperCase() === "KDE");

/** Runs inside KWin. Only the active window reports, so a popout never moves the main field. */
export const kwinPositionScript = (input: { readonly pid: number; readonly service: string }) => `
const pid = ${input.pid};
const report = (window) => {
  if (workspace.activeWindow !== window) return;
  const { x, y } = window.frameGeometry;
  callDBus(${JSON.stringify(input.service)}, "${POSITION_PATH}", "${POSITION}", "Moved", x, y);
};
const track = (window) => {
  if (window.pid !== pid) return;
  window.frameGeometryChanged.connect(() => report(window));
  report(window);
};
workspace.windowList().forEach(track);
workspace.windowAdded.connect(track);
workspace.windowActivated.connect((window) => {
  if (window && window.pid === pid) report(window);
});
`;

export const decodeKWinPosition = (message: {
  readonly interface?: string | undefined;
  readonly member?: string | undefined;
  readonly body: ReadonlyArray<unknown>;
}): DesktopWindowPosition | null => {
  if (message.interface !== POSITION || message.member !== "Moved") return null;
  const [x, y] = message.body;
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
};

/**
 * Wayland keeps a window's position from the window itself, but KWin knows it and can be asked to
 * say. Other compositors have no such door, so there the shader simply stays still.
 */
export function watchKWinWindowPosition(
  onMove: (position: DesktopWindowPosition) => void,
  bus: MessageBus = sessionBus(),
) {
  const pid = process.pid;
  const scriptName = `t3pp-window-position-${pid}`;
  const scriptPath = NodePath.join(NodeOS.tmpdir(), `${scriptName}.js`);
  const scripting = (member: string, signature: string, body: ReadonlyArray<unknown>) =>
    bus.call(
      new Message({
        destination: KWIN,
        path: SCRIPTING_PATH,
        interface: SCRIPTING,
        member,
        signature,
        body: [...body],
      }),
    );

  bus.on("error", () => undefined);
  bus.addMethodHandler((message: Message) => {
    if (message.interface !== POSITION) return false;
    const position = decodeKWinPosition(message);
    if (position !== null) {
      latest = position;
      onMove(position);
    }
    bus.send(Message.newMethodReturn(message));
    return true;
  });

  const ready = (async () => {
    await new Promise((resolve) => bus.once("connect", resolve));
    // dbus-next sets this on connect but leaves it out of its types.
    const service = (bus as MessageBus & { readonly name?: string | null }).name;
    if (!service) return;
    await NodeFSP.writeFile(scriptPath, kwinPositionScript({ pid, service }));
    await scripting("loadScript", "ss", [scriptPath, scriptName]);
    await scripting("start", "", []);
  })().catch(() => undefined);

  return async () => {
    await ready;
    await scripting("unloadScript", "s", [scriptName]).catch(() => undefined);
    await NodeFSP.rm(scriptPath, { force: true }).catch(() => undefined);
    bus.disconnect();
  };
}
