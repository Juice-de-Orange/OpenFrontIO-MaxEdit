#!/usr/bin/env node
/**
 * Build `resources/atlases/icon-atlas.png`: the six inherited columns, kept
 * byte for byte, followed by this fork's own building icons.
 *
 * The structure passes read the atlas as N equal 64-pixel columns, one row,
 * alpha only — the glyph's colour comes from a uniform, so an icon is a white
 * shape on transparent and nothing else. Which column a type uses is
 * `STRUCTURE_ORDER` in `src/client/render/types/UnitType.ts`; the list below
 * has to follow it, and `tests/build/StructureAtlas.test.ts` checks that it
 * does by counting the columns in the PNG.
 *
 * The headers of the passes name a `generate-sprite-atlases.mjs` that never
 * existed (HANDOVER); this is the generator that does. It renders through
 * headless Chromium (Playwright is a devDependency since the browser leg) —
 * the one SVG rasteriser this repository already ships. The sources are the
 * SVGs in `resources/images/structures/`; edit them, run this, commit both.
 *
 *   npm run gen-structure-atlas
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ATLAS = resolve(root, "resources/atlases/icon-atlas.png");
const SOURCES = resolve(root, "resources/images/structures");
const CELL = 64;
/** The inherited columns: City, Port, Factory, Defense Post, SAM Launcher, Missile Silo. */
const INHERITED_COLS = 6;
/** Our icons, in `STRUCTURE_ORDER` order after the inherited six. */
const OURS = [
  "civilian_factory",
  "military_factory",
  "dockyard",
  "refinery",
  "air_base",
  "naval_base",
  "supply_hub",
  // Not buildings: the forces (§6.3, §6.7, §6.8). They ride the same atlas
  // and the same passes, because a division standing in a province and a
  // factory standing in a province are the same drawing problem — an icon
  // on a coloured plate with a number over it.
  "division",
  "wing",
  "fleet",
];
/** The glyph's box inside a cell; the passes scale by `iconFill`, so keep a margin. */
const GLYPH = 44;

const inherited = readFileSync(ATLAS).toString("base64");
const svgs = OURS.map((name) =>
  readFileSync(resolve(SOURCES, `${name}.svg`)).toString("base64"),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const dataUrl = await page.evaluate(
  async ({ inherited, svgs, cell, inheritedCols, glyph }) => {
    const load = (src) =>
      new Promise((ok, fail) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () =>
          fail(new Error(`could not load ${src.slice(0, 40)}`));
        img.src = src;
      });
    const canvas = document.createElement("canvas");
    canvas.width = cell * (inheritedCols + svgs.length);
    canvas.height = cell;
    const ctx = canvas.getContext("2d");
    const old = await load(`data:image/png;base64,${inherited}`);
    if (old.height !== cell || old.width < cell * inheritedCols) {
      throw new Error(`the inherited atlas is ${old.width}x${old.height}`);
    }
    // Exactly the first six columns of the old atlas, unscaled.
    const w = cell * inheritedCols;
    ctx.drawImage(old, 0, 0, w, cell, 0, 0, w, cell);
    for (let i = 0; i < svgs.length; i++) {
      const img = await load(`data:image/svg+xml;base64,${svgs[i]}`);
      const x = cell * (inheritedCols + i) + (cell - glyph) / 2;
      ctx.drawImage(img, x, (cell - glyph) / 2, glyph, glyph);
    }
    return canvas.toDataURL("image/png");
  },
  { inherited, svgs, cell: CELL, inheritedCols: INHERITED_COLS, glyph: GLYPH },
);
await browser.close();

const png = Buffer.from(dataUrl.split(",")[1], "base64");
writeFileSync(ATLAS, png);
console.log(
  `wrote ${ATLAS}: ${CELL * (INHERITED_COLS + OURS.length)}x${CELL}, ` +
    `${png.length} bytes, ${INHERITED_COLS + OURS.length} columns`,
);
