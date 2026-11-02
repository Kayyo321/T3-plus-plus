import { asciiTapReach, type AsciiFieldFrame } from "./asciiShaderEngine";

const BASE_ALPHA = 0.08;
const DENSITY_ALPHA = 0.5;

const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

const smoothstep = (from: number, to: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * One RGBA pixel per cell, top row first, for the browser to blur. It burns on the composite's
 * schedule so the two go out together, with the field's contours standing in for the glyphs' scatter.
 */
export function shadeAsciiFieldBlur(frame: AsciiFieldFrame, output: Uint8ClampedArray) {
  const { accent, cells, columns, dissolve, ink, rows } = frame;
  const burn = (dissolve - 0.34) * 2.5;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const from = ((rows - 1 - row) * columns + column) * 4;
      const to = (row * columns + column) * 4;
      const density = (cells[from] ?? 0) / 255;
      const tint = (cells[from + 1] ?? 0) / 255;
      const gone = lerp(asciiTapReach(cells[from + 3] ?? 0), (cells[from + 2] ?? 0) / 255, 0.4);
      const left = 1 - smoothstep(gone - 0.16, gone + 0.16, burn);
      output[to] = lerp(ink[0], accent[0], tint) * 255;
      output[to + 1] = lerp(ink[1], accent[1], tint) * 255;
      output[to + 2] = lerp(ink[2], accent[2], tint) * 255;
      output[to + 3] = (BASE_ALPHA + density * DENSITY_ALPHA) * left * 255;
    }
  }
}
