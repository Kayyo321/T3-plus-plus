import { useEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";

import { asciiLandingCells, asciiSeed } from "./asciiLanding";

const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const OPENING_MS = 900;
const FRAME_MS = 1000 / 24;

const paint = (canvas: HTMLCanvasElement, seed: number, progress: number) => {
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
  const cells = asciiLandingCells(columns, rows, seed);
  for (let index = 0; index < cells.length; index += 1) {
    const cell = cells[index];
    if (cell === undefined || cell.weight === 0) continue;
    const reveal = Math.min(1, Math.max(0, (progress - cell.delay) / 0.2));
    if (reveal === 0) continue;
    context.globalAlpha = cell.weight * reveal;
    context.fillText(
      cell.character,
      (index % columns) * CELL_WIDTH,
      Math.floor(index / columns) * CELL_HEIGHT,
    );
  }
};

/**
 * The empty conversation's wallpaper. It plays once when it mounts, at a capped frame rate, then
 * never paints again unless the panel resizes or the theme changes, so it costs nothing at rest.
 */
export function AsciiLanding(props: { readonly seedText: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seed = asciiSeed(props.seedText);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints a canvas, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const hidden = document.visibilityState !== "visible";
    let frame = 0;
    let done = reduced || hidden;
    const repaintAtRest = () => {
      if (done) paint(canvas, seed, 1);
    };
    if (done) {
      paint(canvas, seed, 1);
    } else {
      const startedAt = performance.now();
      let lastPaint = 0;
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / OPENING_MS);
        if (now - lastPaint >= FRAME_MS || progress === 1) {
          lastPaint = now;
          paint(canvas, seed, progress);
        }
        if (progress === 1 || document.visibilityState !== "visible") {
          done = true;
          paint(canvas, seed, 1);
          return;
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }
    const stopResize = observeResize(canvas, repaintAtRest);
    const theme = new MutationObserver(repaintAtRest);
    theme.observe(document.documentElement, { attributeFilter: ["class", "data-theme"] });
    return () => {
      cancelAnimationFrame(frame);
      stopResize();
      theme.disconnect();
    };
  }, [seed]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full text-foreground/45 [mask-image:linear-gradient(to_bottom,black_55%,transparent_92%)]"
    />
  );
}
