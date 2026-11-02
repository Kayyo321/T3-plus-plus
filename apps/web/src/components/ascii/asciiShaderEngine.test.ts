import { BUILT_IN_THEME_IDS, COSMIC_THEME_IDS } from "@t3tools/shared/themePalettes";
import { describe, expect, it } from "vite-plus/test";

import { asciiLandingCells, ASCII_LOGO } from "./asciiLanding";
import { asciiGridOffset, ASCII_SHADERS, asciiShaderForTheme } from "./asciiShaderEngine";

const RAMP_LENGTH = 12;

describe("ascii shaders", () => {
  it.each([
    { pixels: 0, cells: 0, remainder: 0 },
    { pixels: 23, cells: 2, remainder: 7 },
    // A window left of the primary monitor must not reverse the grid.
    { pixels: -1, cells: -1, remainder: 7 },
    { pixels: -16, cells: -2, remainder: 0 },
  ])("keeps the grid on the desktop at $pixels pixels", ({ pixels, cells, remainder }) => {
    expect(asciiGridOffset(pixels, 8)).toEqual({ cells, remainder });
  });

  it("gives every cosmic theme its own shader", () => {
    const shaders = COSMIC_THEME_IDS.map(asciiShaderForTheme);
    expect(shaders).toEqual(COSMIC_THEME_IDS);
    expect(new Set(shaders.map((id) => ASCII_SHADERS[id].source)).size).toBe(shaders.length);
  });

  it.each(["t3-chat", "my-custom-theme", "drift", "constructor", undefined])(
    "falls back to the contour field for %s",
    (themeId) => {
      expect(asciiShaderForTheme(themeId)).toBe("drift");
    },
  );

  it("keeps every classic built-in on a shader", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
      expect(ASCII_SHADERS[asciiShaderForTheme(themeId)]).toBeDefined();
    }
  });

  it.each(Object.entries(ASCII_SHADERS))("%s has full ramps that start blank", (_, shader) => {
    for (const ramp of [shader.ramp, shader.unicode]) {
      const characters = Array.from(ramp);
      expect(characters).toHaveLength(RAMP_LENGTH);
      expect(characters[0]).toBe(" ");
    }
    expect(/^[\x20-\x7e]+$/.test(shader.ramp)).toBe(true);
    expect(/[^\x20-\x7e]/.test(shader.unicode)).toBe(true);
  });
});

describe("logo", () => {
  it("centers each plus's stem on its crossbar", () => {
    const stem = ASCII_LOGO[1]!;
    const crossbar = ASCII_LOGO[2]!;
    const foot = ASCII_LOGO[3]!;
    const stems = [...stem.matchAll(/██╗/g)].map((match) => match.index);
    const bars = [...crossbar.matchAll(/██████╗/g)].map((match) => match.index);
    const feet = [...foot.matchAll(/╚═██╔═╝/g)].map((match) => match.index);
    expect(stems).toHaveLength(3);
    // The first match is the 3's top right corner.
    expect(stems.slice(1)).toEqual(bars.slice(-2).map((bar) => bar + 2));
    expect(stems.slice(1)).toEqual(feet.map((start) => start + 2));
  });
});

describe("still landing", () => {
  const logoCells = (logo: { bottomRow: number; centerColumn: number } | null, columns: number) =>
    asciiLandingCells(columns, 40, 7, logo).filter((cell) => cell.weight === 1).length;

  it("draws the mark when it fits above the headline", () => {
    expect(logoCells({ bottomRow: 20, centerColumn: 60 }, 120)).toBeGreaterThan(0);
  });

  it("leaves the mark out rather than colliding with the headline or the pane edge", () => {
    expect(logoCells({ bottomRow: ASCII_LOGO.length - 1, centerColumn: 60 }, 120)).toBe(0);
    expect(logoCells({ bottomRow: 20, centerColumn: 6 }, 120)).toBe(0);
    expect(logoCells(null, 120)).toBe(0);
  });
});
