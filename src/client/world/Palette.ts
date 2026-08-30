/**
 * The renderer's colour table.
 *
 * Two rows, and the second one is easy to miss: row 0 holds fill colour at
 * `smallID * 4` with alpha 150/255, row 1 holds **border** colour at
 * `PALETTE_SIZE * 4 + smallID * 4` with alpha 1. Filling only row 0 gives
 * coloured territory and black borders, with no error anywhere.
 *
 * Slot 0 is left at zero: it is the unowned marker, and territory is only
 * drawn where a tile carries a non-zero owner.
 *
 * Colours are derived from the nation index rather than allocated by
 * client/theme/ColorAllocator, which distributes them for LAB contrast
 * between neighbours. That is worth having and comes back with the theme
 * layer; until then adjacent nations can look similar.
 */

/** Palette rows per channel block. Must match the renderer's texture width. */
export const PALETTE_SIZE = 4096;

export interface PaletteEntry {
  /** Renderer slot. 1-based; 0 means unowned. */
  smallID: number;
  /** Hue in degrees, 0..360. */
  hue: number;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/**
 * Build the palette for `count` nations.
 *
 * Hues are spread by the golden angle so that consecutive ids are far apart in
 * colour — with 52 nations, a plain even split puts neighbours-by-id at 7
 * degrees, which is indistinguishable on screen.
 */
export function buildPalette(count: number): Float32Array {
  if (count >= PALETTE_SIZE) {
    throw new Error(`${count} nations exceeds the palette's ${PALETTE_SIZE}`);
  }
  const palette = new Float32Array(PALETTE_SIZE * 2 * 4);
  for (let i = 0; i < count; i++) {
    const smallID = i + 1;
    const hue = (i * 137.508) % 360;

    const [fr, fg, fb] = hslToRgb(hue, 0.55, 0.5);
    const fillOff = smallID * 4;
    palette[fillOff] = fr;
    palette[fillOff + 1] = fg;
    palette[fillOff + 2] = fb;
    palette[fillOff + 3] = 150 / 255;

    // Row 1: border, a darker shade of the same hue, fully opaque.
    const [br, bg, bb] = hslToRgb(hue, 0.7, 0.3);
    const borderOff = PALETTE_SIZE * 4 + smallID * 4;
    palette[borderOff] = br;
    palette[borderOff + 1] = bg;
    palette[borderOff + 2] = bb;
    palette[borderOff + 3] = 1;
  }
  return palette;
}
