import { describe, expect, it } from "vite-plus/test";

import { shadeAsciiFieldBlur } from "./asciiFieldBlur";
import type { AsciiFieldFrame } from "./asciiShaderEngine";

const frame = (cells: ReadonlyArray<number>, rows: number, dissolve: number): AsciiFieldFrame => ({
  cells: new Uint8Array(cells),
  columns: 1,
  rows,
  originX: 0,
  originY: 0,
  cellWidth: 8,
  cellHeight: 16,
  ink: [1, 1, 1],
  accent: [0, 0, 1],
  dissolve,
});

const shade = (input: AsciiFieldFrame) => {
  const output = new Uint8ClampedArray(input.columns * input.rows * 4);
  shadeAsciiFieldBlur(input, output);
  return output;
};

describe("shadeAsciiFieldBlur", () => {
  it("turns the field's bottom-up cells into a top-down image", () => {
    const output = shade(frame([255, 0, 0, 0, 0, 255, 0, 0], 2, 0));
    expect(Array.from(output.subarray(0, 3))).toEqual([0, 0, 255]);
    expect(Array.from(output.subarray(4, 7))).toEqual([255, 255, 255]);
    expect(output[7]).toBeGreaterThan(output[3] ?? 0);
  });

  it("holds until the burn arrives, then leaves nothing", () => {
    const near = [128, 0, 0, 0];
    const far = [128, 0, 0, 255];
    const alpha = (cell: ReadonlyArray<number>, dissolve: number) =>
      shade(frame(cell, 1, dissolve))[3];

    expect(alpha(near, 0.2)).toBe(alpha(near, 0));
    expect(alpha(near, 0.6)).toBe(0);
    expect(alpha(far, 0.6)).toBe(alpha(far, 0));
    expect(alpha(far, 1)).toBe(0);
  });
});
