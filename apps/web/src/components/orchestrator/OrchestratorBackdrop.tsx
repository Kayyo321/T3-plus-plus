import { useEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { THEME_PREVIEW_ID } from "~/themePalette";

import {
  asciiColorProbe,
  asciiShaderForTheme,
  createAsciiShaderEngine,
  type AsciiShaderId,
} from "../ascii/asciiShaderEngine";

const BACKDROP_FRAME_MS = 1000 / 20;

/**
 * The theme's shader behind the conversation: more of the landing's field, at the same moment and
 * scale, as if the landing ran on under this panel. Bubbles blur whatever passes under them, so this
 * runs slower than the landing and only while the window is visible, focused, and motion is allowed.
 */
export function OrchestratorBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives a WebGL canvas, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const engine = createAsciiShaderEngine(canvas, BACKDROP_FRAME_MS);
    if (engine === null) return;
    const root = document.documentElement;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const toRgb = asciiColorProbe();
    let shader: AsciiShaderId = asciiShaderForTheme(root.dataset.themeId);
    let lookKey = "";

    const syncRunning = () => {
      const allowed = !motion.matches && document.visibilityState === "visible";
      engine.setRunning(allowed && (document.hasFocus() || engine.isBusy()));
    };
    const syncLook = () => {
      const themeId = root.dataset.themeId;
      if (themeId !== THEME_PREVIEW_ID) shader = asciiShaderForTheme(themeId);
      const style = getComputedStyle(canvas);
      const ink = toRgb(style.color, [1, 1, 1]);
      const look = { shader, ink, accent: toRgb(style.getPropertyValue("--primary").trim(), ink) };
      const key = JSON.stringify(look);
      if (key === lookKey) return;
      const opening = lookKey === "";
      lookKey = key;
      engine.setLook(look, !opening && !motion.matches);
      syncRunning();
    };
    const syncLayout = () => {
      const fontFamily = getComputedStyle(canvas).getPropertyValue("--font-mono") || "monospace";
      engine.layout({ fontFamily, logo: null, quiet: null, fadeEdges: false });
    };

    syncLayout();
    syncLook();
    void document.fonts?.ready.then(syncLayout);
    const stopResize = observeResize(canvas, syncLayout);
    const theme = new MutationObserver(syncLook);
    theme.observe(root, { attributeFilter: ["class", "data-theme-id", "style"] });
    document.addEventListener("visibilitychange", syncRunning);
    window.addEventListener("focus", syncRunning);
    window.addEventListener("blur", syncRunning);
    motion.addEventListener("change", syncRunning);
    return () => {
      stopResize();
      theme.disconnect();
      document.removeEventListener("visibilitychange", syncRunning);
      window.removeEventListener("focus", syncRunning);
      window.removeEventListener("blur", syncRunning);
      motion.removeEventListener("change", syncRunning);
      engine.dispose();
    };
  }, []);

  return (
    <div
      aria-hidden
      className="orchestrator-backdrop pointer-events-none absolute inset-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full text-foreground opacity-60" />
    </div>
  );
}
