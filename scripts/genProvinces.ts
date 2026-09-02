/**
 * Generate the province artefacts for the maps a world can run on.
 *
 *   npm run gen-provinces            # every map listed below
 *   npm run gen-provinces -- europe  # just one
 *
 * Not every map in resources/maps: there are 120 of them, each would add a
 * couple of megabytes to the repository, and a world runs on one. The list is
 * explicit so adding a map to a world is a deliberate act with a commit
 * attached — the artefact is what a season's province ids mean, and it should
 * not appear by accident.
 */

import fs from "fs/promises";
import path from "path";
import {
  generateProvinceMap,
  serialiseProvinceMeta,
  type GeneratorBorders,
  type GeneratorManifest,
} from "src/build/GenerateProvinceMap";
import type { BorderCollection, BordersFit } from "src/build/NationBorders";

/** Map directories to generate, as `<root>:<id>` pairs. */
const TARGETS: { root: string; id: string }[] = [
  { root: "resources/maps", id: "europe" },
];

// The test fixtures under tests/testdata/maps are deliberately absent. Their
// manifests carry no nations, so they partition into zero provinces, and the
// server tests build their own terrain in memory and run it through this same
// generator — which is a better test than a checked-in artefact for a map
// nothing plays on.

async function generateOne(root: string, id: string): Promise<void> {
  const dir = path.join(root, id);
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf-8"),
  ) as GeneratorManifest;
  const terrain = new Uint8Array(
    await fs.readFile(path.join(dir, "map4x.bin")),
  );
  const borders = await loadBorders(dir);

  const started = Date.now();
  const { bin, meta } = generateProvinceMap(id, manifest, terrain, borders);
  await fs.writeFile(path.join(dir, "provinces.bin"), bin);
  await fs.writeFile(
    path.join(dir, "provinces.json"),
    serialiseProvinceMeta(meta),
  );

  console.info(
    `${dir}: ${meta.provinceCount} provinces, ${meta.airZoneCount} air zones, ` +
      `${meta.seaZoneCount} sea zones, partition ${meta.partitionHash.toString(16)}, ` +
      `${(bin.byteLength / 1024 / 1024).toFixed(2)} MB, ${Date.now() - started} ms`,
  );
}

/** Real borders, if the map carries them; undefined falls back to Voronoi. */
async function loadBorders(dir: string): Promise<GeneratorBorders | undefined> {
  try {
    const [fit, geometry] = await Promise.all([
      fs.readFile(path.join(dir, "borders-fit.json"), "utf-8"),
      fs.readFile(path.join(dir, "ne-borders.geojson"), "utf-8"),
    ]);
    return {
      fit: JSON.parse(fit) as BordersFit,
      geometry: JSON.parse(geometry) as BorderCollection,
    };
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const targets =
    wanted.length === 0
      ? TARGETS
      : TARGETS.filter((t) => wanted.includes(t.id));
  if (targets.length === 0) {
    throw new Error(
      `no target matches ${wanted.join(", ")}. Known: ${TARGETS.map((t) => t.id).join(", ")}`,
    );
  }
  for (const target of targets) await generateOne(target.root, target.id);
}

main().catch((e: unknown) => {
  console.error("gen-provinces failed", e);
  process.exit(1);
});
