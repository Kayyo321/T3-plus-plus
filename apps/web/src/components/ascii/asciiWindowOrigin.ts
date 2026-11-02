import type { DesktopWindowPosition } from "@t3tools/contracts";

let reported: DesktopWindowPosition | null = null;
let listening = false;

// Lives as long as the page: the window moves for as long as the app is open.
const listen = () => {
  if (listening) return;
  listening = true;
  const bridge = window.desktopBridge;
  if (typeof bridge?.onWindowPositionChange !== "function") return;
  bridge.onWindowPositionChange((position) => {
    reported = position;
  });
  reported = bridge.getWindowPosition();
};

/** The page's top left corner on the desktop, in CSS pixels. Wayland hides it from `screenX`. */
export const readWindowOrigin = (): DesktopWindowPosition => {
  listen();
  return (
    reported ?? {
      x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
      y: window.screenY + window.outerHeight - window.innerHeight,
    }
  );
};
