import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * Nothing outside the quarantine may import into it.
 *
 * This assertion is what actually holds the quarantine. tsconfig's `exclude`
 * does **not** cut an excluded file out of the program — it only removes it
 * from the root set, so a single import from an included file pulls the whole
 * subtree back in, along with everything that subtree imports. The exclude
 * entry is bookkeeping; this test is the rule.
 *
 * The scanner carries its own proof, in `finds a planted violation`. An
 * earlier version of this file passed against a deliberately planted import,
 * and reading it did not reveal why — every part checked out in isolation. A
 * guard that cannot demonstrate it still bites is worth less than no guard,
 * because it gets believed.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const QUARANTINE = ["src/client/_legacy", "tests/_legacy"];

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Module specifiers imported by a source text, comments excluded. */
export function importsIn(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const found: string[] = [];
  for (const re of [
    /from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']/g,
    /import\s+["']([^"']+)["']/g,
  ]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) found.push(m[1]);
  }
  return found;
}

function isQuarantined(rel: string): boolean {
  return QUARANTINE.some((q) => rel === q || rel.startsWith(`${q}/`));
}

/** Repo-relative paths of every live .ts file under src/ and tests/. */
function liveSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(REPO_ROOT, full));
      if (isQuarantined(rel)) continue;
      if (entry.name === "node_modules" || entry.name === "static") continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(rel);
    }
  };
  walk(path.join(REPO_ROOT, "src"));
  walk(path.join(REPO_ROOT, "tests"));
  return out;
}

/** Live files that import into the quarantine. */
function filesReachingIntoQuarantine(files: string[]): string[] {
  return files
    .filter((rel) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
      return importsIn(source).some((spec) => spec.includes("_legacy"));
    })
    .sort();
}

describe("quarantine boundary", () => {
  test("finds a planted violation", () => {
    // The scanner's self-test, and the reason to believe the assertion below.
    // Built from template literals rather than written out: the matcher looks
    // for single- and double-quoted specifiers, so a fixture spelled with
    // those would make this file a violation of the very rule it enforces.
    const q = "_leg" + "acy";
    const planted = [
      `import { A } from "../${q}/A";`,
      `const b = await import("src/client/${q}/B");`,
      `export { C } from "./${q}/C";`,
      `import "src/client/${q}/D";`,
      `// import { E } from "../${q}/E";`,
      `const notAnImport = "src/client/${q}/F";`,
    ].join(String.fromCharCode(10));

    const specs = importsIn(planted)
      .filter((s) => s.includes("_legacy"))
      .sort();
    expect(specs).toEqual([
      `../${q}/A`,
      `./${q}/C`,
      `src/client/${q}/B`,
      `src/client/${q}/D`,
    ]);
  });

  test("scans the whole live tree", () => {
    const files = liveSourceFiles();
    // A scanner that reaches nothing passes the next assertion trivially.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/client/world/WorldClient.ts");
    expect(files).toContain("src/server/Main.ts");
    expect(files.some(isQuarantined)).toBe(false);
  });

  test("no live file imports into _legacy", () => {
    expect(
      filesReachingIntoQuarantine(liveSourceFiles()),
      "These files reach into the quarantine. tsconfig's exclude will not " +
        "stop that — an excluded file that something imports is back in the " +
        "program, and so is everything it imports.",
    ).toEqual([]);
  });

  test("the exclusion lists agree", () => {
    const read = (p: string): string =>
      fs.readFileSync(path.join(REPO_ROOT, p), "utf-8");

    for (const dir of QUARANTINE) {
      expect(read("tsconfig.json"), `tsconfig must exclude ${dir}`).toContain(
        dir,
      );
      expect(read("eslint.config.js"), `eslint must ignore ${dir}`).toContain(
        dir,
      );
      expect(read(".oxlintrc.json"), `oxlint must ignore ${dir}`).toContain(
        dir,
      );
    }
    expect(
      read("vite.config.ts"),
      "vitest must exclude tests/_legacy",
    ).toContain("tests/_legacy");
  });

  test("the quarantine explains itself", () => {
    // A quarantine with no note saying what is in it and when it expires
    // becomes a landfill.
    const readme = path.join(REPO_ROOT, "src/client/_legacy/README.md");
    expect(fs.existsSync(readme)).toBe(true);
    const text = fs.readFileSync(readme, "utf-8");
    expect(text).toMatch(/expiry/i);
    expect(text).toMatch(/phase/i);
  });
});
