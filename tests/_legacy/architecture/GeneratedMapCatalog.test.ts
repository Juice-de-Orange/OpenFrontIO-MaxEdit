import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * The Go generator's output path has to agree with where Maps.gen.ts actually
 * lives.
 *
 * This is the failure that leaves no trace. `npm run gen-maps` writes the
 * catalog to a path hardcoded in map-generator/codegen.go. Move the file in
 * TypeScript and forget the Go line, and everything stays green — tsc, lint,
 * every test — until someone regenerates. The generator then cheerfully
 * writes a fresh Maps.gen.ts at the old location that nothing imports, and
 * the real catalog quietly goes stale. Nothing catches it, because every
 * consumer imports the TS module rather than checking the path.
 *
 * Running the generator here would be the direct check, but it needs a Go
 * toolchain that not every machine has (this one does not). Comparing the
 * path it would write against the file that exists needs nothing but fs, and
 * unlike a one-off manual check it keeps holding after this commit.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CODEGEN_GO = path.join(REPO_ROOT, "map-generator", "codegen.go");

/** Parse `filepath.Join(cwd, "..", "src", …, "Maps.gen.ts")` into a repo-relative path. */
function generatorOutputPath(): string {
  const source = fs.readFileSync(CODEGEN_GO, "utf-8");
  const call = source.match(
    /outPath\s*:?=\s*filepath\.Join\(\s*cwd\s*,\s*((?:"[^"]*"\s*,\s*)*"[^"]*")\s*\)/,
  );
  expect(
    call,
    "could not find the outPath filepath.Join in map-generator/codegen.go — " +
      "if its shape changed, update this test rather than deleting it",
  ).not.toBeNull();

  const segments = [...call![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  // The generator runs with cwd = map-generator/, so a leading ".." is the repo root.
  expect(segments[0]).toBe("..");
  return segments.slice(1).join("/");
}

describe("generated map catalog", () => {
  test("the generator writes to the file the tree actually imports", () => {
    const declared = generatorOutputPath();
    expect(declared).toBe("src/shared/map/Maps.gen.ts");
    expect(
      fs.existsSync(path.join(REPO_ROOT, declared)),
      `map-generator/codegen.go writes ${declared}, which does not exist`,
    ).toBe(true);
  });

  test("no stale copy is left behind at the old location", () => {
    expect(
      fs.existsSync(path.join(REPO_ROOT, "src/core/game/Maps.gen.ts")),
    ).toBe(false);
  });

  test("the generated catalog stays import-free", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "src/shared/map/Maps.gen.ts"),
      "utf-8",
    );
    // shared/ imports nothing from client/, server/ or core/. This file is
    // pure data and is the reason the move was cheap; keep it that way.
    expect(source.match(/^import\s/m)).toBeNull();
  });
});
