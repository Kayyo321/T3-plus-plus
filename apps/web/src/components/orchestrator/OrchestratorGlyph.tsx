import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

export type OrchestratorGlyphMotion = "still" | "idle" | "working";

const RAMP = " ·:+*#@";
const SMALL_CELL_LIMIT = 4;
const FRAME_MS: Record<Exclude<OrchestratorGlyphMotion, "still">, number> = {
  idle: 1000 / 8,
  working: 1000 / 14,
};
const ORBIT_SECONDS: Record<OrchestratorGlyphMotion, number> = { still: 1, idle: 6, working: 1.8 };

/**
 * One conductor and the agents circling it: a bright head sweeps the ring while the hub pulses.
 */
const orchestratorCell = (u: number, v: number, phase: number) => {
  const radius = Math.hypot(u, v);
  const angle = Math.atan2(v, u);
  const hub = Math.exp(-radius * radius * 11) * (0.82 + 0.18 * Math.sin(phase * Math.PI * 4));
  const ring = Math.exp(-((radius - 0.74) ** 2) * 34);
  const lag = (((phase * Math.PI * 2 - angle) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const comet = Math.exp(-lag * 1.5);
  const spokes = Math.max(0, Math.cos(angle * 4 - phase * Math.PI * 2)) ** 10 * 0.42;
  const spoke = spokes * Math.max(0, 1 - radius) * (radius > 0.2 ? 1 : 0);
  return Math.min(1, hub + ring * (0.34 + comet * 0.66) + spoke);
};

const paint = (canvas: HTMLCanvasElement, size: number, phase: number) => {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const ratio = window.devicePixelRatio || 1;
  const pixels = Math.round(size * ratio);
  if (canvas.width !== pixels) {
    canvas.width = pixels;
    canvas.height = pixels;
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, size, size);
  const style = getComputedStyle(canvas);
  context.fillStyle = style.color;
  const dots = size / 9 < SMALL_CELL_LIMIT;
  const columns = dots ? 7 : Math.round(size / 4.5);
  const rows = dots ? 7 : Math.round(size / 6.5);
  const cellWidth = size / columns;
  const cellHeight = size / rows;
  if (!dots) {
    context.font = `bold ${cellHeight * 1.2}px ${style.getPropertyValue("--font-mono") || "monospace"}`;
    context.textAlign = "center";
    context.textBaseline = "middle";
  }
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const u = ((column + 0.5) / columns) * 2 - 1;
      const v = ((row + 0.5) / rows) * 2 - 1;
      const intensity = orchestratorCell(u, v, phase);
      if (dots) {
        if (intensity < 0.12) continue;
        context.globalAlpha = Math.min(1, 0.2 + intensity);
        const inset = cellWidth * 0.12;
        context.fillRect(
          column * cellWidth + inset,
          row * cellHeight + inset,
          cellWidth - inset * 2,
          cellHeight - inset * 2,
        );
        continue;
      }
      const character = RAMP[Math.round(intensity * (RAMP.length - 1))] ?? " ";
      if (character === " ") continue;
      context.globalAlpha = 0.5 + intensity * 0.5;
      context.fillText(character, (column + 0.5) * cellWidth, (row + 0.5) * cellHeight);
    }
  }
  context.globalAlpha = 1;
};

/** The orchestrator's mark. It only repaints in motion, and `still` never schedules a frame. */
export function OrchestratorGlyph(props: {
  readonly size: number;
  readonly motion: OrchestratorGlyphMotion;
  readonly className?: string;
}) {
  const { size, motion } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints a canvas, which lives outside React
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const repaintStill = () => paint(canvas, size, 0.12);
    const theme = new MutationObserver(repaintStill);
    theme.observe(document.documentElement, { attributeFilter: ["class", "data-theme-id"] });
    if (motion === "still" || reduced) {
      repaintStill();
      return () => theme.disconnect();
    }
    let frame = 0;
    let last = 0;
    const startedAt = performance.now();
    const step = (now: number) => {
      frame = requestAnimationFrame(step);
      if (now - last < FRAME_MS[motion] || document.visibilityState !== "visible") return;
      last = now;
      paint(canvas, size, ((now - startedAt) / 1000 / ORBIT_SECONDS[motion]) % 1);
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      theme.disconnect();
    };
  }, [motion, size]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("shrink-0 text-primary", props.className)}
      style={{ width: size, height: size }}
    />
  );
}
