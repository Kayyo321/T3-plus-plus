import aetherSource from "./shaders/aether.hlsl?raw";
import astralSource from "./shaders/astral.hlsl?raw";
import compositeSource from "./shaders/composite.hlsl?raw";
import driftSource from "./shaders/drift.hlsl?raw";
import eclipseSource from "./shaders/eclipse.hlsl?raw";
import entrySource from "./shaders/entry.hlsl?raw";
import lunaSource from "./shaders/luna.hlsl?raw";
import nebulaSource from "./shaders/nebula.hlsl?raw";
import novaSource from "./shaders/nova.hlsl?raw";
import orbitSource from "./shaders/orbit.hlsl?raw";
import preludeSource from "./shaders/prelude.hlsl?raw";
import solSource from "./shaders/sol.hlsl?raw";
import voidSource from "./shaders/void.hlsl?raw";

import { readWindowOrigin } from "./asciiWindowOrigin";
import { ASCII_FIELD_SEED, ASCII_LOGO, ASCII_LOGO_GLYPHS } from "./asciiLanding";

/**
 * Density ramps, sparse to solid, one plain ASCII and one Unicode per shader, each RAMP_LENGTH
 * characters. Unicode stays in blocks every desktop font stack covers, and out of emoji.
 */
export const ASCII_SHADERS = {
  drift: { source: driftSource, ramp: " .,:;-~=+*#%", unicode: " ╌┄┈─╍┅┉━═≡≣" },
  void: { source: voidSource, ramp: " .,:'-~=+*#%", unicode: " ⠁⠂⠆⠖⠶⠾⠿⡿⣟⣯⣿" },
  nova: { source: novaSource, ramp: " .':+*xX#%@&", unicode: " ∙∘⋆✧✦✶✴✷✸✹❋" },
  luna: { source: lunaSource, ramp: " .,:-=+*o#%@", unicode: " ·∘◌○◔◑◕◉◍●⬤" },
  orbit: { source: orbitSource, ramp: " .,-~=oO0@#&", unicode: " ·∘○◯◌◍◎◉⊙⊚●" },
  nebula: { source: nebulaSource, ramp: " .,:~^*%&@#$", unicode: " ⁘⁙∴∵∷※⁂❖❉✺✾" },
  sol: { source: solSource, ramp: " .,^~*!+=#%@", unicode: " ⋅∗∴∵⁂✶✹✺❂✷✸" },
  eclipse: { source: eclipseSource, ramp: " .':-=/\\|*#@", unicode: " ·╱╲╳┼╋╬◢◣◆█" },
  astral: { source: astralSource, ramp: " .':+*xX#%@&", unicode: " ⋅∗⋆✧✦✶✴✷✸✹✺" },
  aether: { source: aetherSource, ramp: " .,-~^=+*%#@", unicode: " ∼∽≀≈∿≋⌇⌒⌓∾∯" },
} as const;

export type AsciiShaderId = keyof typeof ASCII_SHADERS;
export type AsciiRgb = readonly [number, number, number];

export interface AsciiLook {
  readonly shader: AsciiShaderId;
  readonly ink: AsciiRgb;
  readonly accent: AsciiRgb;
}

export const asciiShaderForTheme = (themeId: string | undefined): AsciiShaderId =>
  themeId !== undefined && themeId !== "drift" && Object.hasOwn(ASCII_SHADERS, themeId)
    ? (themeId as AsciiShaderId)
    : "drift";

const SHADER_IDS = Object.keys(ASCII_SHADERS) as ReadonlyArray<AsciiShaderId>;
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;
const MORPH_MS = 1100;
const LOGO_SLIDE_MS = 320;
const DISSOLVE_MS = 2200;
const RIPPLE_SLOTS = 4;
const RIPPLE_SECONDS = 2.4;
const IDLE_FRAME_MS = 1000 / 30;
const MAX_FRAME_DELTA_MS = 100;
const STILL_TIME_SECONDS = 42;
const MAX_DEVICE_PIXEL_RATIO = 2;
const TAP_FRAME_MS = 1000 / 15;
const TAP_REACH_SCALE = 2;
const NO_QUIET_AREA = [-1, -1, -1, -1] as const;

const VERTEX_SOURCE = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Every engine reads one clock, so two canvases of the field always show the same moment. */
const fieldClock = { time: STILL_TIME_SECONDS, tickedAt: 0 };

const advanceFieldClock = (now: number) => {
  if (now <= fieldClock.tickedAt) return;
  fieldClock.time += Math.min(now - fieldClock.tickedAt, MAX_FRAME_DELTA_MS) / 1000;
  fieldClock.tickedAt = now;
};

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

const mixRgb = (from: AsciiRgb, to: AsciiRgb, t: number): AsciiRgb => [
  from[0] + (to[0] - from[0]) * t,
  from[1] + (to[1] - from[1]) * t,
  from[2] + (to[2] - from[2]) * t,
];

const drawGlyph = (
  context: CanvasRenderingContext2D,
  character: string,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  // Fonts leave gaps between rows; drawn blocks tile into a solid mark.
  const shade = character === "█" ? 1 : character === "▓" ? 0.72 : character === "▒" ? 0.46 : 0;
  if (shade > 0) {
    context.globalAlpha = shade;
    context.fillRect(x, y, width, height);
    context.globalAlpha = 1;
    return;
  }
  // Wide symbols would otherwise bleed into their atlas neighbors.
  context.save();
  context.beginPath();
  context.rect(x, y, width, height);
  context.clip();
  context.fillText(character, x + width / 2, y + height / 2);
  context.restore();
};

const glyphAtlas = (cellWidth: number, cellHeight: number, fontFamily: string) => {
  const rows = [
    ...SHADER_IDS.flatMap((id) => [ASCII_SHADERS[id].ramp, ASCII_SHADERS[id].unicode]),
    ASCII_LOGO_GLYPHS,
  ];
  const columns = Math.max(...rows.map((row) => Array.from(row).length));
  const atlas = document.createElement("canvas");
  atlas.width = columns * cellWidth;
  atlas.height = rows.length * cellHeight;
  const context = atlas.getContext("2d");
  if (context === null) return null;
  context.fillStyle = "#000";
  context.fillRect(0, 0, atlas.width, atlas.height);
  context.fillStyle = "#fff";
  context.font = `${cellWidth / 0.6}px ${fontFamily}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  rows.forEach((row, rowIndex) => {
    Array.from(row).forEach((character, column) => {
      drawGlyph(
        context,
        character,
        column * cellWidth,
        rowIndex * cellHeight,
        cellWidth,
        cellHeight,
      );
    });
  });
  return { atlas, logoRow: rows.length - 1 };
};

interface FieldTarget {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
}

/** All distances are CSS pixels from the canvas's top left corner. */
export interface AsciiLayout {
  readonly fontFamily: string;
  /** Where the mark sits, or null to leave it out. */
  readonly logo: { readonly bottom: number; readonly center: number } | null;
  /** The content the field must thin out behind so text stays readable. */
  readonly quiet: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  } | null;
  /** A second such area, for content that does not sit against the first. */
  readonly quietBelow?: NonNullable<AsciiLayout["quiet"]>;
  /** Fades the field toward the canvas's edges, for a canvas that is the whole background. */
  readonly fadeEdges: boolean;
  /** Where the mark stood on the last screen, so it slides here instead of jumping. */
  readonly logoFrom?: AsciiLayout["logo"];
}

/** Splits a distance into whole cells and the pixels left over, for either side of the origin. */
export const asciiGridOffset = (pixels: number, cellSize: number) => {
  const cells = Math.floor(pixels / cellSize);
  return { cells, remainder: pixels - cells * cellSize };
};

/** The field under a tapped element, with the composite's ripples and bloom already applied. */
export interface AsciiFieldFrame {
  /** RGBA per cell, bottom row first: density, height, contour, and how late the burn arrives. */
  readonly cells: Uint8Array;
  readonly columns: number;
  readonly rows: number;
  /** The element's top left corner, in `cells` coordinates. */
  readonly originX: number;
  readonly originY: number;
  /** CSS pixels per cell. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly ink: AsciiRgb;
  readonly accent: AsciiRgb;
  readonly dissolve: number;
}

/** Lets DOM above the canvas take part in the field without a second WebGL context. */
export interface AsciiFieldTap {
  readonly element: Element;
  readonly onFrame: (frame: AsciiFieldFrame) => void;
}

/** A tapped cell's burn order back in the composite's `reach` units. */
export const asciiTapReach = (byte: number) => (byte / 255) * TAP_REACH_SCALE;

export interface AsciiShaderEngine {
  readonly layout: (next: AsciiLayout) => void;
  /** Morphs to the look unless `animate` is false, then repaints when the loop is stopped. */
  readonly setLook: (look: AsciiLook, animate: boolean) => void;
  readonly setRunning: (running: boolean) => void;
  /** True while something must finish even if the loop would otherwise rest. */
  readonly isBusy: () => boolean;
  /** A ring from this canvas position, in CSS pixels. */
  readonly ripple: (x: number, y: number) => void;
  /** Burns the mark into the field and the field to nothing, then calls back. */
  readonly dissolve: (onDone: () => void) => void;
  readonly restore: () => void;
  /** Replaces the tap and sends it a frame now, even if the loop is stopped. */
  readonly setTap: (tap: AsciiFieldTap | null) => void;
  readonly dispose: () => void;
}

/** Reads a CSS color as linear 0 to 1 channels. */
export const asciiColorProbe = () => {
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

/** The wallpaper is decoration: without WebGL2, or if its shaders fail, the app simply has none. */
export function createAsciiShaderEngine(
  canvas: HTMLCanvasElement,
  frameMs = IDLE_FRAME_MS,
): AsciiShaderEngine | null {
  try {
    return makeAsciiShaderEngine(canvas, frameMs);
  } catch (cause) {
    console.error(cause);
    return null;
  }
}

function makeAsciiShaderEngine(
  canvas: HTMLCanvasElement,
  frameMs: number,
): AsciiShaderEngine | null {
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    powerPreference: "low-power",
  });
  if (gl === null) return null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (shader === null) throw new Error("Could not allocate an ASCII shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`ASCII shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  };

  const link = (fragmentSource: string) => {
    const program = gl.createProgram();
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS) && !gl.isContextLost()) {
      throw new Error(`ASCII shader failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  };

  const texture = () => {
    const created = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, created);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return created;
  };

  const fieldTarget = (): FieldTarget => {
    const created = texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, created, 0);
    return { texture: created, framebuffer };
  };

  const fieldPrograms = new Map<AsciiShaderId, WebGLProgram>();
  const fieldProgram = (id: AsciiShaderId): WebGLProgram => {
    const existing = fieldPrograms.get(id);
    if (existing !== undefined) return existing;
    try {
      const program = link(preludeSource + ASCII_SHADERS[id].source + entrySource);
      fieldPrograms.set(id, program);
      return program;
    } catch (cause) {
      // One bad theme shader costs that theme its field, never the app.
      console.error(cause);
      if (id === "drift") throw cause;
      const fallback = fieldProgram("drift");
      fieldPrograms.set(id, fallback);
      return fallback;
    }
  };

  const vertexArray = gl.createVertexArray();
  gl.bindVertexArray(vertexArray);
  const compositeProgram = link(preludeSource + compositeSource);
  const uniform = (name: string) => gl.getUniformLocation(compositeProgram, name);
  const compositeUniforms = {
    cells: uniform("uCells"),
    seed: uniform("uSeed"),
    fieldFrom: uniform("uFieldFrom"),
    fieldTo: uniform("uFieldTo"),
    glyphs: uniform("uGlyphs"),
    logo: uniform("uLogo"),
    morph: uniform("uMorph"),
    cellPx: uniform("uCellPx"),
    rampFrom: uniform("uRampFrom"),
    rampTo: uniform("uRampTo"),
    logoRow: uniform("uLogoRow"),
    ink: uniform("uInk"),
    accent: uniform("uAccent"),
    focus: uniform("uFocus"),
    quiet: uniform("uQuiet"),
    quietBelow: uniform("uQuietBelow"),
    frame: uniform("uFrame"),
    edgeFade: uniform("uEdgeFade"),
    gridShift: uniform("uGridShift"),
    gridOffset: uniform("uGridOffset"),
    logoShift: uniform("uLogoShift"),
    canvasPx: uniform("uCanvasPx"),
    time: uniform("uTime"),
    dissolve: uniform("uDissolve"),
    ripples: uniform("uRipples"),
  };

  const fieldFrom = fieldTarget();
  const fieldTo = fieldTarget();
  const glyphs = texture();
  const logo = texture();

  let columns = 0;
  let rows = 0;
  let cellWidth = 0;
  let cellHeight = 0;
  let atlasKey = "";
  let logoRow = 0;
  let focus: readonly [number, number] = [0.5, 0.7];
  let quiet: readonly [number, number, number, number] = NO_QUIET_AREA;
  let quietBelow: readonly [number, number, number, number] = NO_QUIET_AREA;
  let fieldFrame: readonly [number, number, number, number] = [0, 0, 1, 1];
  let edgeFade = 1;
  let gridShift = 0;
  let gridOffset: readonly [number, number] = [0, 0];
  let logoShift: readonly [number, number] = [0, 0];
  let logoSlide = 1;
  let pixelRatio = 1;

  let shaderTo: AsciiShaderId = "drift";
  let shaderFrom: AsciiShaderId | null = null;
  let inkFrom: AsciiRgb = [1, 1, 1];
  let inkTo: AsciiRgb = [1, 1, 1];
  let accentFrom: AsciiRgb = [1, 1, 1];
  let accentTo: AsciiRgb = [1, 1, 1];
  let morph = 1;
  let dissolve = 0;
  let onDissolved: (() => void) | null = null;
  const ripples = Array.from({ length: RIPPLE_SLOTS }, () => ({ x: 0, y: 0, born: -Infinity }));
  let nextRipple = 0;
  const rippleData = new Float32Array(RIPPLE_SLOTS * 3);

  let frame = 0;
  let running = false;
  let lastTick = 0;
  let lastPaint = 0;
  let cssCellWidth = CELL_WIDTH;
  let cssCellHeight = CELL_HEIGHT;
  let tap: AsciiFieldTap | null = null;
  let tapCells = new Uint8Array(0);
  let lastTap = 0;

  const drawField = (id: AsciiShaderId, target: FieldTarget) => {
    const program = fieldProgram(id);
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, columns, rows);
    gl.uniform2f(gl.getUniformLocation(program, "uCells"), columns, rows);
    gl.uniform4fv(gl.getUniformLocation(program, "uFrame"), fieldFrame);
    gl.uniform1f(gl.getUniformLocation(program, "uTime"), fieldClock.time);
    gl.uniform1f(gl.getUniformLocation(program, "uSeed"), ASCII_FIELD_SEED);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const bindTexture = (
    unit: number,
    bound: WebGLTexture,
    location: WebGLUniformLocation | null,
  ) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, bound);
    gl.uniform1i(location, unit);
  };

  const ripplesAlive = () =>
    ripples.some((ripple) => fieldClock.time - ripple.born < RIPPLE_SECONDS);

  /** Runs with `fieldTo` bound, before the composite, so the read only waits on the small field pass. */
  const readTap = (current: AsciiFieldTap) => {
    const stage = canvas.getBoundingClientRect();
    const slot = current.element.getBoundingClientRect();
    const gridLeft = stage.left - gridOffset[0] / pixelRatio;
    const gridBottom = stage.bottom + gridOffset[1] / pixelRatio;
    const firstColumn = Math.max(0, Math.floor((slot.left - gridLeft) / cssCellWidth));
    const firstRow = Math.max(0, Math.floor((gridBottom - slot.bottom) / cssCellHeight));
    const endColumn = Math.min(columns, Math.ceil((slot.right - gridLeft) / cssCellWidth) + 1);
    const endRow = Math.min(rows, Math.ceil((gridBottom - slot.top) / cssCellHeight) + 1);
    const tapColumns = endColumn - firstColumn;
    const tapRows = endRow - firstRow;
    if (tapColumns <= 0 || tapRows <= 0) return null;
    if (tapCells.length !== tapColumns * tapRows * 4) {
      tapCells = new Uint8Array(tapColumns * tapRows * 4);
    }
    gl.readPixels(firstColumn, firstRow, tapColumns, tapRows, gl.RGBA, gl.UNSIGNED_BYTE, tapCells);

    const aspect = columns / rows / 2;
    const liveRipples = ripples.filter((ripple) => fieldClock.time - ripple.born < RIPPLE_SECONDS);
    const bloomStrength = Math.sin(Math.min(1, dissolve * 2) * Math.PI);
    for (let row = 0; row < tapRows; row += 1) {
      for (let column = 0; column < tapColumns; column += 1) {
        const offset = (row * tapColumns + column) * 4;
        const u = (firstColumn + column + 0.5) / columns;
        const v = (firstRow + row + 0.5) / rows;
        const reach = Math.hypot(u - focus[0], (v - focus[1]) * 0.7) * 1.25;
        let wave = 0;
        for (const ripple of liveRipples) {
          const age = fieldClock.time - ripple.born;
          const away = Math.hypot((u - ripple.x) * aspect, v - ripple.y);
          wave += Math.exp(-(((away - age * 1.05) * 10) ** 2)) * Math.exp(-age * 1.9);
          wave += Math.exp(-(((away - age * 0.7) * 15) ** 2)) * Math.exp(-age * 2.8) * 0.55;
        }
        const bloom = bloomStrength * Math.exp(-reach * 2.2);
        tapCells[offset] = Math.min(
          255,
          (tapCells[offset] ?? 0) + (wave * 0.55 + bloom * 0.5) * 255,
        );
        tapCells[offset + 1] = Math.min(255, (tapCells[offset + 1] ?? 0) + wave * 0.7 * 255);
        tapCells[offset + 2] = Math.min(255, (tapCells[offset + 2] ?? 0) + wave * 0.6 * 255);
        tapCells[offset + 3] = Math.min(255, (reach / TAP_REACH_SCALE) * 255);
      }
    }

    const eased = easeInOut(morph);
    return {
      cells: tapCells,
      columns: tapColumns,
      rows: tapRows,
      originX: (slot.left - gridLeft) / cssCellWidth - firstColumn,
      originY: (gridBottom - slot.top) / cssCellHeight - firstRow,
      cellWidth: cssCellWidth,
      cellHeight: cssCellHeight,
      ink: mixRgb(inkFrom, inkTo, eased),
      accent: mixRgb(accentFrom, accentTo, eased),
      dissolve,
    };
  };

  /** Places the field on the desktop, so moving the window slides a view across it. */
  const syncDesktop = () => {
    if (cellWidth === 0 || cellHeight === 0) return false;
    const stage = canvas.getBoundingClientRect();
    const origin = readWindowOrigin();
    const left = origin.x + stage.left;
    const top = origin.y + stage.top;
    const { width: desktopWidth, height: desktopHeight } = window.screen;
    // The field is bottom up, so its origin is the desktop's bottom edge.
    const column = asciiGridOffset(Math.round(left * pixelRatio), cellWidth);
    const row = asciiGridOffset(
      Math.round((desktopHeight - top - stage.height) * pixelRatio),
      cellHeight,
    );
    const moved =
      column.cells !== fieldFrame[0] ||
      row.cells !== fieldFrame[1] ||
      column.remainder !== gridOffset[0] ||
      row.remainder !== gridOffset[1];
    fieldFrame = [
      column.cells,
      row.cells,
      Math.ceil((desktopWidth * pixelRatio) / cellWidth),
      Math.ceil((desktopHeight * pixelRatio) / cellHeight),
    ];
    gridOffset = [column.remainder, row.remainder];
    return moved;
  };

  const paint = (shouldTap = true) => {
    if (columns === 0 || rows === 0 || gl.isContextLost()) return;
    drawField(shaderTo, fieldTo);
    const tapFrame = tap !== null && shouldTap ? readTap(tap) : null;
    if (morph >= 1) {
      // At rest both sides read the one field that was drawn.
    } else if (shaderFrom === null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fieldFrom.framebuffer);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      drawField(shaderFrom, fieldFrom);
    }

    const eased = easeInOut(morph);
    gl.useProgram(compositeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const uniforms = compositeUniforms;
    bindTexture(0, morph >= 1 ? fieldTo.texture : fieldFrom.texture, uniforms.fieldFrom);
    bindTexture(1, fieldTo.texture, uniforms.fieldTo);
    bindTexture(2, glyphs, uniforms.glyphs);
    bindTexture(3, logo, uniforms.logo);
    gl.uniform2f(uniforms.cells, columns, rows);
    gl.uniform1f(uniforms.seed, ASCII_FIELD_SEED);
    gl.uniform1f(uniforms.morph, eased);
    gl.uniform2i(uniforms.cellPx, cellWidth, cellHeight);
    gl.uniform1i(uniforms.rampFrom, SHADER_IDS.indexOf(shaderFrom ?? shaderTo) * 2);
    gl.uniform1i(uniforms.rampTo, SHADER_IDS.indexOf(shaderTo) * 2);
    gl.uniform1i(uniforms.logoRow, logoRow);
    gl.uniform3fv(uniforms.ink, mixRgb(inkFrom, inkTo, eased));
    gl.uniform3fv(uniforms.accent, mixRgb(accentFrom, accentTo, eased));
    gl.uniform2f(uniforms.focus, focus[0], focus[1]);
    gl.uniform4fv(uniforms.quiet, quiet);
    gl.uniform4fv(uniforms.quietBelow, quietBelow);
    gl.uniform4fv(uniforms.frame, fieldFrame);
    gl.uniform1f(uniforms.edgeFade, edgeFade);
    gl.uniform1i(uniforms.gridShift, gridShift);
    gl.uniform2i(uniforms.gridOffset, gridOffset[0], gridOffset[1]);
    const logoLeft = 1 - easeInOut(logoSlide);
    gl.uniform2i(
      uniforms.logoShift,
      Math.round(logoShift[0] * logoLeft),
      Math.round(logoShift[1] * logoLeft),
    );
    gl.uniform2f(uniforms.canvasPx, canvas.width, canvas.height);
    gl.uniform1f(uniforms.time, fieldClock.time);
    gl.uniform1f(uniforms.dissolve, dissolve);
    ripples.forEach((ripple, index) => {
      const age = fieldClock.time - ripple.born;
      rippleData[index * 3] = ripple.x;
      rippleData[index * 3 + 1] = ripple.y;
      rippleData[index * 3 + 2] = age < RIPPLE_SECONDS ? age : -1;
    });
    gl.uniform3fv(uniforms.ripples, rippleData);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (tapFrame !== null) tap?.onFrame(tapFrame);
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    const delta = Math.min(now - lastTick, MAX_FRAME_DELTA_MS);
    lastTick = now;
    advanceFieldClock(now);
    if (morph < 1) morph = Math.min(1, morph + delta / MORPH_MS);
    if (logoSlide < 1) logoSlide = Math.min(1, logoSlide + delta / LOGO_SLIDE_MS);
    if (onDissolved !== null) dissolve = Math.min(1, dissolve + delta / DISSOLVE_MS);
    const moved = syncDesktop();
    const moving = moved || morph < 1 || logoSlide < 1 || onDissolved !== null || ripplesAlive();
    if (!moving && now - lastPaint < frameMs) return;
    lastPaint = now;
    const tapDue = moving || now - lastTap >= TAP_FRAME_MS;
    if (tapDue) lastTap = now;
    paint(tapDue);
    if (dissolve >= 1 && onDissolved !== null) {
      const done = onDissolved;
      onDissolved = null;
      done();
    }
  };

  const setRunning = (next: boolean) => {
    if (next === running) return;
    running = next;
    if (running) {
      lastTick = performance.now();
      frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
    }
  };

  return {
    layout: ({
      fontFamily,
      logo: logoPlacement,
      quiet: quietArea,
      quietBelow: quietBelowArea,
      fadeEdges,
      logoFrom,
    }) => {
      const ratio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      pixelRatio = ratio;
      const { width, height } = canvas.getBoundingClientRect();
      const nextWidth = Math.round(width * ratio);
      const nextHeight = Math.round(height * ratio);
      if (nextWidth === 0 || nextHeight === 0) return;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      cellWidth = Math.round(CELL_WIDTH * ratio);
      cellHeight = Math.round(CELL_HEIGHT * ratio);
      cssCellWidth = cellWidth / ratio;
      cssCellHeight = cellHeight / ratio;
      // One spare column lets the grid slide under the mark.
      columns = Math.ceil(nextWidth / cellWidth) + 1;
      const logoRows = Math.ceil(nextHeight / cellHeight);
      rows = logoRows + 1;
      edgeFade = fadeEdges ? 1 : 0;
      syncDesktop();
      if (logoFrom && logoPlacement) {
        const shift = [
          Math.round((logoFrom.center - logoPlacement.center) * ratio),
          Math.round((logoPlacement.bottom - logoFrom.bottom) * ratio),
        ] as const;
        if (shift[0] !== 0 || shift[1] !== 0) {
          logoShift = shift;
          logoSlide = 0;
        }
      }

      const key = `${cellWidth}x${cellHeight} ${fontFamily}`;
      if (key !== atlasKey) {
        const built = glyphAtlas(cellWidth, cellHeight, fontFamily);
        if (built !== null) {
          atlasKey = key;
          logoRow = built.logoRow;
          gl.bindTexture(gl.TEXTURE_2D, glyphs);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, built.atlas);
        }
      }

      for (const target of [fieldFrom, fieldTo]) {
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, columns, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }

      const logoCells = new Uint8Array(columns * logoRows * 4);
      const logoHeight = ASCII_LOGO.length;
      const logoWidth = ASCII_LOGO[0]?.length ?? 0;
      const bottomRow =
        logoPlacement === null ? -1 : Math.floor((logoPlacement.bottom * ratio) / cellHeight);
      const centerColumn =
        logoPlacement === null ? columns / 2 : (logoPlacement.center * ratio) / cellWidth;
      const logoTop = bottomRow - logoHeight;
      // Sliding the grid by part of a cell keeps the mark exactly centered.
      const exactLeft = centerColumn - logoWidth / 2;
      const logoLeft = Math.ceil(exactLeft);
      gridShift = logoPlacement === null ? 0 : Math.round((logoLeft - exactLeft) * cellWidth);
      const logoFits = logoTop >= 1 && logoLeft >= 2 && logoLeft + logoWidth <= columns - 2;
      if (logoFits) {
        ASCII_LOGO.forEach((line, lineIndex) => {
          Array.from(line).forEach((character, characterIndex) => {
            const glyphIndex = ASCII_LOGO_GLYPHS.indexOf(character);
            if (glyphIndex < 0) return;
            const offset = ((logoTop + lineIndex) * columns + logoLeft + characterIndex) * 4;
            logoCells[offset] = glyphIndex === 0 ? 0 : glyphIndex - 2;
            logoCells[offset + 3] = 255;
          });
        });
      }
      focus = [centerColumn / columns, logoFits ? 1 - (logoTop + logoHeight / 2) / logoRows : 0.6];
      const toCellUv = (area: NonNullable<AsciiLayout["quiet"]>) =>
        [
          area.left / width,
          1 - area.bottom / height,
          area.right / width,
          1 - area.top / height,
        ] as const;
      quiet = quietArea === null ? NO_QUIET_AREA : toCellUv(quietArea);
      quietBelow = quietBelowArea === undefined ? NO_QUIET_AREA : toCellUv(quietBelowArea);
      gl.bindTexture(gl.TEXTURE_2D, logo);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        columns,
        logoRows,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        logoCells,
      );
      paint();
    },
    setLook: (look, animate) => {
      const first = shaderFrom === null && morph >= 1 && lastPaint === 0;
      const changed = look.shader !== shaderTo;
      const eased = easeInOut(morph);
      inkFrom = first ? look.ink : mixRgb(inkFrom, inkTo, eased);
      accentFrom = first ? look.accent : mixRgb(accentFrom, accentTo, eased);
      inkTo = look.ink;
      accentTo = look.accent;
      if (first) {
        shaderFrom = null;
      } else if (changed) {
        shaderFrom = shaderTo;
      }
      shaderTo = look.shader;
      morph = animate ? 0 : 1;
      if (animate && !running) setRunning(true);
      if (!running) paint();
    },
    setRunning,
    isBusy: () => morph < 1 || logoSlide < 1 || onDissolved !== null || ripplesAlive(),
    ripple: (x, y) => {
      const { width, height } = canvas.getBoundingClientRect();
      if (width === 0 || height === 0) return;
      const slot = ripples[nextRipple % RIPPLE_SLOTS];
      if (slot === undefined) return;
      slot.x = x / width;
      slot.y = 1 - y / height;
      slot.born = fieldClock.time;
      nextRipple += 1;
      setRunning(true);
    },
    dissolve: (onDone) => {
      onDissolved = onDone;
      setRunning(true);
    },
    restore: () => {
      onDissolved = null;
      dissolve = 0;
      if (!running) paint();
    },
    setTap: (next) => {
      tap = next;
      if (next !== null && !running) paint();
    },
    dispose: () => {
      setRunning(false);
      tap = null;
      for (const program of fieldPrograms.values()) gl.deleteProgram(program);
      fieldPrograms.clear();
      gl.deleteProgram(compositeProgram);
      for (const target of [fieldFrom, fieldTo]) {
        gl.deleteTexture(target.texture);
        gl.deleteFramebuffer(target.framebuffer);
      }
      gl.deleteTexture(glyphs);
      gl.deleteTexture(logo);
      gl.deleteVertexArray(vertexArray);
    },
  };
}
