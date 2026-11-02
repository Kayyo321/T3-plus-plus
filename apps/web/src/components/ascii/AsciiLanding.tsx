import type { NewThreadLayout } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { THEME_PREVIEW_ID } from "~/themePalette";

import {
  asciiColorProbe,
  asciiShaderForTheme,
  createAsciiShaderEngine,
  type AsciiLayout,
  type AsciiLook,
  type AsciiShaderEngine,
  type AsciiShaderId,
} from "./asciiShaderEngine";
import { ASCII_FIELD_SEED, asciiLandingCells } from "./asciiLanding";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const LOGO_HEADLINE_GAP = 20;
/** Everything in the chat canvas that is not bare background. */
const RIPPLE_BLOCKERS =
  '[data-chat-composer-stack], [data-thread-details-card], button, a, input, textarea, select, [role="button"], [role="menu"], [role="dialog"]';

/** Outlives the canvas: a tab switch remounts the screen, and the mark slides on from here. */
let lastLogo: AsciiLayout["logo"] = null;

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

/**
 * The empty conversation's wallpaper: the theme's shader, drawn as text, with the mark living in
 * it. It only runs while this screen is on show, focused, and motion is allowed.
 */
function AsciiCanvas(props: {
  readonly layout: NewThreadLayout;
  readonly dissolving: boolean;
  readonly onDissolved: () => void;
  readonly onEngineChange: ((engine: AsciiShaderEngine | null) => void) | undefined;
}) {
  const { dissolving, layout, onEngineChange } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<AsciiShaderEngine | null>(null);
  const frozenRef = useRef(false);
  const finishDissolve = useEffectEvent(() => props.onDissolved());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives a WebGL canvas, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const root = document.documentElement;
    const headline = canvas.parentElement?.querySelector("[data-draft-hero-headline]") ?? null;
    const composer =
      canvas.parentElement?.querySelector('[data-chat-composer-stack="true"]') ?? null;
    // The details card insets the lane, which moves the composer without resizing anything else.
    const composerLane = composer?.parentElement ?? null;
    const tracked = [canvas, headline, composerLane].filter((element) => element !== null);
    const readLayout = (): Omit<AsciiLayout, "fontFamily" | "fadeEdges"> => {
      if (headline === null) return { logo: null, quiet: null };
      const frame = canvas.getBoundingClientRect();
      const top = headline.getBoundingClientRect();
      const stack = composer?.getBoundingClientRect() ?? top;
      const logo = {
        bottom: top.top - frame.top - LOGO_HEADLINE_GAP,
        center: (stack.left + stack.right) / 2 - frame.left,
      };
      const lastAnchor =
        canvas.parentElement
          ?.querySelector("[data-orchestrator-launcher]")
          ?.getBoundingClientRect() ?? stack;
      // Pushed to the bottom, the composer leaves open field between it and the headline.
      if (composer !== null && !composer.contains(headline)) {
        return {
          logo,
          quiet: {
            left: top.left - frame.left,
            top: top.top - frame.top,
            right: top.right - frame.left,
            bottom: top.bottom - frame.top,
          },
          quietBelow: {
            left: stack.left - frame.left,
            top: Math.min(stack.top, lastAnchor.top) - frame.top,
            right: stack.right - frame.left,
            bottom: stack.bottom - frame.top,
          },
        };
      }
      return {
        logo,
        quiet: {
          left: stack.left - frame.left,
          top: top.top - frame.top,
          right: stack.right - frame.left,
          bottom: Math.max(stack.bottom, lastAnchor.bottom) - frame.top,
        },
      };
    };
    const engine = createAsciiShaderEngine(canvas);

    if (engine === null) {
      const repaint = () => paintStill(canvas, ASCII_FIELD_SEED, readLayout().logo);
      repaint();
      const stopResize = observeResize(tracked, repaint);
      const theme = new MutationObserver(repaint);
      theme.observe(root, { attributeFilter: ["class", "data-theme-id"] });
      return () => {
        stopResize();
        theme.disconnect();
      };
    }

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const toRgb = asciiColorProbe();
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
      // A tab switch is the same field carrying on, so it must not fade in like a first open.
      const switching = root.dataset.modeMorph !== undefined;
      engine.setLook(look, !motion.matches && !switching && (opening || onScreen));
      syncRunning();
    };

    const syncLayout = () => {
      // The headline is gone by now; the mark has to dissolve where it stood.
      if (frozenRef.current) return;
      const fontFamily = getComputedStyle(canvas).getPropertyValue("--font-mono") || "monospace";
      const next = readLayout();
      const switching = root.dataset.modeMorph !== undefined;
      engine.layout({
        ...next,
        fontFamily,
        fadeEdges: true,
        ...(switching ? { logoFrom: lastLogo } : {}),
      });
      lastLogo = next.logo;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (motion.matches || !(event.target instanceof Element)) return;
      if (!canvas.parentElement?.contains(event.target)) return;
      if (event.target.closest(RIPPLE_BLOCKERS) !== null) return;
      const frame = canvas.getBoundingClientRect();
      engine.ripple(event.clientX - frame.left, event.clientY - frame.top);
    };

    engineRef.current = engine;
    onEngineChange?.(engine);
    syncLayout();
    syncLook();
    void document.fonts?.ready.then(syncLayout);
    // Rects read during the composer's slide into place are mid-flight; settle on where it lands.
    void Promise.allSettled(
      composerLane?.getAnimations().map((animation) => animation.finished) ?? [],
    ).then(() => {
      if (engineRef.current === engine) syncLayout();
    });

    const stopResize = observeResize(tracked, syncLayout);
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
      theme.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", syncRunning);
      window.removeEventListener("focus", syncRunning);
      window.removeEventListener("blur", syncRunning);
      window.removeEventListener("pointerdown", onPointerDown);
      motion.removeEventListener("change", syncRunning);
      engineRef.current = null;
      onEngineChange?.(null);
      engine.dispose();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Changing the layout swaps the headline element this effect tracks.
  }, [layout, onEngineChange]);

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
  readonly active: boolean;
  readonly threadId: string;
  readonly layout: NewThreadLayout;
  /** Reports the engine for as long as it runs, so other surfaces can follow the field. */
  readonly onEngineChange?: (engine: AsciiShaderEngine | null) => void;
}) {
  const { active, threadId } = props;
  const [shown, setShown] = useState(active ? threadId : null);
  if (active && shown !== threadId) setShown(threadId);
  if (!active && shown !== null && shown !== threadId) setShown(null);
  if (shown === null) return null;
  return (
    <AsciiCanvas
      layout={props.layout}
      dissolving={!active}
      onDissolved={() => setShown(null)}
      onEngineChange={props.onEngineChange}
    />
  );
}
