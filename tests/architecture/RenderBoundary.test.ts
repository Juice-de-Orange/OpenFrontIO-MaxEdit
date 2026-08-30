import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * The renderer's import boundary, as a ratchet.
 *
 * Phase 0 severs `src/client/render/` from `src/core/`. Every commit that
 * resolves one coupling must remove its entry from ALLOWED below, so the
 * property is checked by machine while the surgery is in progress rather
 * than asserted afterwards. The list only ever shrinks.
 *
 * Counting import *statements*, not string occurrences: a prose comment
 * naming a core module is not an edge, and a multi-line import is one edge,
 * not several.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RENDER_DIR = path.join(REPO_ROOT, "src", "client", "render");

/** Module specifier -> number of import statements that still reach it. */
const ALLOWED: Record<string, number> = {
  "src/core/AssetUrls": 10,
  "src/core/CosmeticSchemas": 3,
  "src/core/configuration/Config": 10,
  "src/core/game/Game": 1,
  "src/core/game/GameUpdates": 1,
};

interface Edge {
  /** Repo-relative path of the importing file, forward slashes. */
  from: string;
  /** Resolved core module, e.g. "src/core/AssetUrls". */
  to: string;
  /** How the path was written: bare `src/...` alias, or a relative path. */
  form: "alias" | "relative";
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Strip comments before scanning. Without this, prose that mentions a core
 * module reads as an edge — `frame/RailroadCache.ts` has exactly such a
 * comment, and it is why a naive grep over this tree over-counts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function coreEdgesIn(file: string): Edge[] {
  const source = stripComments(fs.readFileSync(file, "utf-8"));
  const specifiers: string[] = [];

  // `import … from "x"` and `export … from "x"` — the quote must follow
  // `from` directly, which is also what keeps prose out of the results.
  for (const m of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    specifiers.push(m[1]);
  }
  // Dynamic `import("x")`.
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.push(m[1]);
  }

  const edges: Edge[] = [];
  for (const spec of specifiers) {
    let resolved: string;
    let form: Edge["form"];

    if (spec.startsWith("src/")) {
      resolved = spec;
      form = "alias";
    } else if (spec.startsWith(".")) {
      resolved = toPosix(
        path.relative(REPO_ROOT, path.resolve(path.dirname(file), spec)),
      );
      form = "relative";
    } else {
      continue; // npm package
    }

    resolved = resolved.replace(/\.(ts|js)$/, "");
    if (resolved.startsWith("src/core/")) {
      edges.push({
        from: toPosix(path.relative(REPO_ROOT, file)),
        to: resolved,
        form,
      });
    }
  }
  return edges;
}

function allCoreEdges(): Edge[] {
  return tsFilesUnder(RENDER_DIR).flatMap(coreEdgesIn);
}

describe("src/client/render -> src/core import boundary", () => {
  test("reaches no core module outside the allowlist", () => {
    const offending = allCoreEdges()
      .filter((e) => !(e.to in ALLOWED))
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

    expect(
      offending,
      "The renderer gained a new dependency on src/core. Resolve it rather " +
        "than widening ALLOWED — the list only shrinks.",
    ).toEqual([]);
  });

  test("reaches each allowed module no more often than recorded", () => {
    const counted = new Map<string, number>();
    for (const edge of allCoreEdges()) {
      counted.set(edge.to, (counted.get(edge.to) ?? 0) + 1);
    }

    const actual: Record<string, number> = {};
    for (const [mod, budget] of Object.entries(ALLOWED)) {
      const n = counted.get(mod) ?? 0;
      // A resolved coupling must be removed from ALLOWED, not left at 0 —
      // otherwise the list stops describing the work that remains.
      expect(
        n,
        `${mod} is fully severed; drop it from ALLOWED`,
      ).toBeGreaterThan(0);
      actual[mod] = Math.min(n, budget + 1);
      expect(n, `${mod} gained an import site`).toBeLessThanOrEqual(budget);
    }
    expect(actual).toEqual(ALLOWED);
  });

  /**
   * Counter-check for the scanner itself. The renderer writes core imports in
   * two forms — bare `src/core/...` alias and relative `../../core/...` — and
   * a matcher that only understands one of them would report a clean boundary
   * while a third of the edges sit unseen.
   */
  test("sees both the alias and the relative path form", () => {
    const edges = allCoreEdges();
    const byForm = {
      alias: edges.filter((e) => e.form === "alias").length,
      relative: edges.filter((e) => e.form === "relative").length,
    };

    expect(byForm.alias).toBeGreaterThan(0);
    expect(byForm.relative).toBeGreaterThan(0);
    expect(edges.length).toBe(
      Object.values(ALLOWED).reduce((a, b) => a + b, 0),
    );
  });
});
