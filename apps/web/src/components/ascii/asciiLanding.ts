/** Block letters in the terminal-banner style, so the mark reads as a place to start. */
const LOGO = [
  "████████╗ ██████╗          ",
  "╚══██╔══╝ ╚════██╗   ██╗   ██╗",
  "   ██║     █████╔╝ ██████╗██████╗",
  "   ██║     ╚═══██╗ ╚═██╔═╝╚═██╔═╝",
  "   ██║    ██████╔╝   ╚═╝    ╚═╝",
  "   ╚═╝    ╚═════╝",
].map((line) => line.padEnd(33));

const FIELD_RAMP = " ··∙∙:::--==";

const fract = (value: number) => value - Math.floor(value);
const hash = (x: number, y: number, seed: number) =>
  fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453);

const smooth = (t: number) => t * t * (3 - 2 * t);

const valueNoise = (x: number, y: number, seed: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const top = hash(ix, iy, seed) * (1 - fx) + hash(ix + 1, iy, seed) * fx;
  const bottom = hash(ix, iy + 1, seed) * (1 - fx) + hash(ix + 1, iy + 1, seed) * fx;
  return top * (1 - fy) + bottom * fy;
};

export const asciiSeed = (text: string) => {
  let value = 7;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) % 9973;
  return value;
};

interface AsciiCell {
  readonly character: string;
  /** How strongly the cell shows, 0 to 1. The mark is 1; the field fades toward the edges. */
  readonly weight: number;
  /** When it resolves during the opening, 0 to 1, spreading out from the mark. */
  readonly delay: number;
}

/**
 * A contour map that gathers into the mark. Contours rather than random dots read as a place, and
 * they stay legible at low contrast in every theme.
 */
export const asciiLandingCells = (
  columns: number,
  rows: number,
  seed: number,
): ReadonlyArray<AsciiCell> => {
  const logoWidth = LOGO[0]?.length ?? 0;
  const logoLeft = Math.floor((columns - logoWidth) / 2);
  const logoTop = Math.max(1, Math.floor(rows * 0.1));
  const cells: Array<AsciiCell> = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const logoCharacter = LOGO[row - logoTop]?.[column - logoLeft];
      const dx = (column - columns / 2) / (columns / 2);
      const dy = (row - logoTop - 3) / rows;
      const distance = Math.min(1, Math.hypot(dx, dy * 2));
      if (logoCharacter !== undefined && logoCharacter !== " ") {
        cells.push({
          character: logoCharacter,
          weight: 1,
          delay: 0.55 + hash(column, row, seed) * 0.3,
        });
        continue;
      }
      const height =
        valueNoise(column / 11, row / 5, seed) * 0.7 +
        valueNoise(column / 5, row / 2.5, seed) * 0.3;
      const contour = Math.abs(fract(height * 7) - 0.5) * 2;
      const index = Math.floor(contour * contour * (FIELD_RAMP.length - 1));
      const character = FIELD_RAMP[index] ?? " ";
      cells.push({
        character,
        weight: character === " " ? 0 : (1 - distance) * 0.5,
        delay: distance * 0.6,
      });
    }
  }
  return cells;
};
