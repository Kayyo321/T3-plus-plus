import { useEffect, useEffectEvent, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { THEME_PREVIEW_ID } from "~/themePalette";

import {
  asciiShaderForTheme,
  createAsciiShaderEngine,
  type AsciiLayout,
  type AsciiLook,
  type AsciiRgb,
  type AsciiShaderEngine,
  type AsciiShaderId,
} from "./asciiShaderEngine";
import { asciiLandingCells, asciiSeed } from "./asciiLanding";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const LOGO_HEADLINE_GAP = 20;
/** Everything in the chat canvas that is not bare background. */
const RIPPLE_BLOCKERS =
  '[data-chat-composer-stack], [data-thread-details-card], button, a, input, textarea, select, [role="button"], [role="menu"], [role="dialog"]';

/** The still wallpaper for browsers without WebGL2. */
const paintStill = (canvas: HTMLCanvasElement, seed: number, logo: AsciiLayout["logo"]) => {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  const columns = Math.ceil(width / CELL_WIDTH);
  const rows = Math.ceil(height / CELL_HEIGHT);
  const context = canvas.getContext("2d");
  if (context === null || columns === 0 || rows === 0) return;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  context.scale(ratio, ratio);
  const style = getComputedStyle(canvas);
  context.font = `${CELL_HEIGHT - 3}px ${style.getPropertyValue("--font-mono") || "monospace"}`;
  context.textBaseline = "top";
  context.fillStyle = style.color;
  const cells = asciiLandingCells(
    columns,
    rows,
    seed,
    logo === null
      ? null
      : {
          bottomRow: Math.floor(logo.bottom / CELL_HEIGHT),
          centerColumn: logo.center / CELL_WIDTH,
        },
  );
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined || cell.weight === 0) continue;
    context.globalAlpha = cell.weight * 0.45;
    context.fillText(
      cell.character,
      (index % columns) * CELL_WIDTH,
      Math.floor(index / columns) * CELL_HEIGHT,
    );
  }
};

const colorProbe = () => {
  const probe = document.createElement("canvas");
  probe.width = 1;
  probe.height = 1;
  const context = probe.getContext("2d", { willReadFrequently: true });
  return (color: string, fallback: AsciiRgb): AsciiRgb => {
    if (context === null || color.length === 0) return fallback;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red = 255, green = 255, blue = 255] = context.getImageData(0, 0, 1, 1).data;
    return [red / 255, green / 255, blue / 255];
  };
};

/**
 * The empty conversation's wallpaper: the theme's shader, drawn as text, with the mark living in
 * it. It only runs while this screen is on show, focused, and motion is allowed.
 */
function AsciiCanvas(props: {
  readonly seedText: string;
  readonly dissolving: boolean;
  readonly onDissolved: () => void;
}) {
  const { dissolving } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AsciiShaderEngine | null>(null);
  const frozenRef = useRef(false);
  const seed = asciiSeed(props.seedText);
  const finishDissolve = useEffectEvent(() => props.onDissolved());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives a WebGL canvas, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const root = document.documentElement;
    const headline = canvas.parentElement?.querySelector("[data-draft-hero-headline]") ?? null;
    const composer =
      canvas.parentElement?.querySelector('[data-chat-composer-stack="true"]') ?? null;
    const readLayout = (): Omit<AsciiLayout, "fontFamily"> => {
      if (headline === null) return { logo: null, quiet: null };
      const frame = canvas.getBoundingClientRect();
      const top = headline.getBoundingClientRect();
      const stack = composer?.getBoundingClientRect() ?? top;
      const lastAnchor =
        canvas.parentElement
          ?.querySelector("[data-orchestrator-launcher]")
          ?.getBoundingClientRect() ?? stack;
      return {
        logo: {
          bottom: top.top - frame.top - LOGO_HEADLINE_GAP,
          center: (stack.left + stack.right) / 2 - frame.left,
        },
        quiet: {
          left: stack.left - frame.left,
          top: top.top - frame.top,
          right: stack.right - frame.left,
          bottom: Math.max(stack.bottom, lastAnchor.bottom) - frame.top,
        },
      };
    };
    const engine = createAsciiShaderEngine(canvas, seed);

    if (engine === null) {
      const repaint = () => paintStill(canvas, seed, readLayout().logo);
      repaint();
      const stopResize = observeResize(canvas, repaint);
      const stopHeadlineResize = headline === null ? null : observeResize(headline, repaint);
      const theme = new MutationObserver(repaint);
      theme.observe(root, { attributeFilter: ["class", "data-theme-id"] });
      return () => {
        stopResize();
        stopHeadlineResize?.();
        theme.disconnect();
      };
    }

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const toRgb = colorProbe();
    let shader: AsciiShaderId = asciiShaderForTheme(root.dataset.themeId);
    let lookKey = "";
    let onScreen = true;

    const readLook = (): AsciiLook => {
      const themeId = root.dataset.themeId;
      if (themeId !== THEME_PREVIEW_ID) shader = asciiShaderForTheme(themeId);
      const style = getComputedStyle(canvas);
      const ink = toRgb(style.color, [1, 1, 1]);
      return { shader, ink, accent: toRgb(style.getPropertyValue("--primary").trim(), ink) };
    };

    const syncRunning = () => {
      const allowed = !motion.matches && onScreen && document.visibilityState === "visible";
      engine.setRunning(allowed && (document.hasFocus() || engine.isBusy()));
    };

    const syncLook = () => {
      const look = readLook();
      const key = JSON.stringify(look);
      if (key === lookKey) return;
      const opening = lookKey === "";
      lookKey = key;
      engine.setLook(look, !motion.matches && (opening || onScreen));
      syncRunning();
    };

    const syncLayout = () => {
      // The headline is gone by now; the mark has to dissolve where it stood.
      if (frozenRef.current) return;
      const fontFamily = getComputedStyle(canvas).getPropertyValue("--font-mono") || "monospace";
      engine.layout({ fontFamily, ...readLayout() });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (motion.matches || !(event.target instanceof Element)) return;
      if (!canvas.parentElement?.contains(event.target)) return;
      if (event.target.closest(RIPPLE_BLOCKERS) !== null) return;
      const frame = canvas.getBoundingClientRect();
      engine.ripple(event.clientX - frame.left, event.clientY - frame.top);
    };

    engineRef.current = engine;
    syncLayout();
    syncLook();
    void document.fonts?.ready.then(syncLayout);

    const stopResize = observeResize(canvas, syncLayout);
    const stopHeadlineResize = headline === null ? null : observeResize(headline, syncLayout);
    const theme = new MutationObserver(syncLook);
    theme.observe(root, { attributeFilter: ["class", "data-theme-id", "style"] });
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? false;
      syncRunning();
    });
    visibility.observe(canvas);
    document.addEventListener("visibilitychange", syncRunning);
    window.addEventListener("focus", syncRunning);
    window.addEventListener("blur", syncRunning);
    window.addEventListener("pointerdown", onPointerDown);
    motion.addEventListener("change", syncRunning);

    return () => {
      stopResize();
      stopHeadlineResize?.();
      theme.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", syncRunning);
      window.removeEventListener("focus", syncRunning);
      window.removeEventListener("blur", syncRunning);
      window.removeEventListener("pointerdown", onPointerDown);
      motion.removeEventListener("change", syncRunning);
      engineRef.current = null;
      engine.dispose();
    };
  }, [seed]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and cancels a WebGL animation, which lives outside React
  useEffect(() => {
    const engine = engineRef.current;
    frozenRef.current = dissolving;
    if (!dissolving) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (engine === null || reduced) {
      finishDissolve();
      return;
    }
    engine.dissolve(finishDissolve);
    return () => {
      frozenRef.current = false;
      engine.restore();
    };
  }, [dissolving]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-10 size-full text-foreground"
    />
  );
}

/**
 * Stays mounted past the empty state when a conversation starts, so the mark can dissolve while
 * the first message lands. Moving to a different thread cuts to it instead.
 */
export function AsciiLanding(props: {
  readonly seedText: string;
  readonly active: boolean;
  readonly threadId: string;
}) {
  const { active, threadId } = props;
  const [shown, setShown] = useState(active ? threadId : null);
  if (active && shown !== threadId) setShown(threadId);
  if (!active && shown !== null && shown !== threadId) setShown(null);
  if (shown === null) return null;
  return (
    <AsciiCanvas
      seedText={props.seedText}
      dissolving={!active}
      onDissolved={() => setShown(null)}
    />
  );
}
