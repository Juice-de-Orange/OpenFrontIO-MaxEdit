import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * The renderer's import boundary.
 *
 * `src/client/render/` draws `FrameData` and knows nothing else. It may not
 * reach into `src/client/world/`, where the HUD, the state store and the
 * socket live, and it may not reach into `src/core/`, which phase 0 severed
 * and deleted.
 *
 * **This file is a repair.** `src/client/world/ui/Hud.ts` has claimed since
 * phase 0 that "`tests/architecture/RenderBoundary.test.ts` fails if the
 * renderer imports anything from here" — and that file did not exist at that
 * path. It was moved into `tests/_legacy/` with the rest of the inherited
 * client, where `vite.config.ts` excludes it from every run, and the eslint
 * zone that was supposed to cover the same ground names `src/core/`, which is
 * an empty directory. So the boundary was guarded by a comment. It happened to
 * hold; nothing was holding it. The quarantined copy stays where it is as
 * history — this one is the rule.
 *
 * Two assertions, because the boundary fails in two different ways. A direct
 * `src/client/world/...` import is the obvious regression. The subtler one is
 * a fresh edge into some other part of `src/client/`, which reads as harmless
 * and drags the world in through that module's own imports — upstream's
 * `client/Utils.ts` did exactly that and kept 56 simulation files in the
 * renderer's type graph long after every direct import looked clean.
 *
 * Counting import *statements*, not string occurrences: a prose comment
 * naming a module is not an edge, and a multi-line import is one edge, not
 * several.
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const RENDER_DIR = path.join(REPO_ROOT, "src", "client", "render");

/**
 * Modules outside `src/client/render/` the renderer may import.
 *
 * `src/shared/` is unrestricted by construction: it imports nothing from
 * client/, server/ or core/, which eslint enforces separately. Everything
 * else has to be named here, together with the reason it is safe.
 */
const ALLOWED_OUTSIDE_RENDER = [
  // Asset URL resolution. Reaches only shared/util/AssetPath.
  "src/client/util/AssetUrl",
  // Translation lookup, for the strings baked into the renderer's own
  // overlays. Its only import is `intl-messageformat`, so it brings nothing
  // with it — verified rather than assumed, because that is the whole point
  // of naming a module here.
  "src/client/i18n/Translate",
];

/** Trees the renderer must never reach into, and why each one matters. */
const FORBIDDEN_PREFIXES: ReadonlyArray<[string, string]> = [
  [
    "src/client/world/",
    "the HUD, the state store and the socket — the renderer is a consumer of " +
      "FrameData, not a participant in the world",
  ],
  [
    "src/core/",
    "the deterministic simulation phase 0 severed; the server owns it now",
  ],
  ["src/server/", "the server does not ship to a browser"],
  ["src/client/_legacy/", "the quarantine, which nothing live may import"],
];

interface Edge {
  /** Repo-relative path of the importing file, forward slashes. */
  from: string;
  /** Resolved module, e.g. "src/client/world/ui/Hud". */
  to: string;
  /** How the path was written: bare `src/...` alias, or a relative path. */
  form: "alias" | "relative";
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
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
 * Strip comments before scanning. Without this, prose that mentions a module
 * reads as an edge — `frame/RailroadCache.ts` used to carry exactly such a
 * comment, and it is why a naive grep over this tree over-counts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every module specifier a source text imports, comments excluded. */
function importedSpecifiers(source: string): string[] {
  const stripped = stripComments(source);
  const specifiers: string[] = [];

  // `import … from "x"` and `export … from "x"` — the quote must follow
  // `from` directly, which is also what keeps prose out of the results.
  for (const m of stripped.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
    specifiers.push(m[1]);
  }
  // Dynamic `import("x")`.
  for (const m of stripped.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) {
    specifiers.push(m[1]);
  }
  // Side-effect `import "x"` — no bindings, no `from`. Easy to miss, and it
  // produces a real dependency in the bundle.
  for (const m of stripped.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
    specifiers.push(m[1]);
  }
  return specifiers;
}

/**
 * Resolve a specifier to a repo-relative module path, or null for an npm
 * package. Handles both forms the tree uses: the bare `src/...` alias from
 * tsconfig paths, and ordinary relative paths.
 */
function resolveSpecifier(file: string, spec: string): string | null {
  let resolved: string;
  if (spec.startsWith("src/")) {
    resolved = spec;
  } else if (spec.startsWith(".")) {
    resolved = toPosix(
      path.relative(REPO_ROOT, path.resolve(path.dirname(file), spec)),
    );
  } else {
    return null;
  }
  return resolved.replace(/\?raw$/, "").replace(/\.(ts|js)$/, "");
}

/**
 * Edges out of one module, given its path and its source text.
 *
 * Split from `edgesIn` so the scanner's own test can feed it a fixture
 * without writing a file: a fixture written into `src/client/render/` and left
 * behind by an interrupted run would break `tsc` with unresolvable imports and
 * be reported by these very assertions as a real violation.
 */
function edgesFromSource(file: string, source: string): Edge[] {
  const from = toPosix(path.relative(REPO_ROOT, file));
  const edges: Edge[] = [];
  for (const spec of importedSpecifiers(source)) {
    const to = resolveSpecifier(file, spec);
    if (to === null) continue;
    edges.push({
      from,
      to,
      form: spec.startsWith("src/") ? "alias" : "relative",
    });
  }
  return edges;
}

function edgesIn(file: string): Edge[] {
  return edgesFromSource(file, fs.readFileSync(file, "utf-8"));
}

function allRendererEdges(): Edge[] {
  return tsFilesUnder(RENDER_DIR).flatMap(edgesIn);
}

describe("src/client/render import boundary", () => {
  test("scans the whole renderer", () => {
    // A scanner that reaches nothing passes every assertion below trivially.
    const files = tsFilesUnder(RENDER_DIR).map((f) =>
      toPosix(path.relative(REPO_ROOT, f)),
    );
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("src/client/render/gl/Renderer.ts");
    expect(files).toContain("src/client/render/types/FrameData.ts");
    // `FrameAdapter` is on the *world* side of the boundary — it produces
    // FrameData, the renderer consumes it — so it must not be in this scan.
    expect(files).not.toContain("src/client/world/FrameAdapter.ts");
    expect(allRendererEdges().length).toBeGreaterThan(100);
  });

  for (const [prefix, why] of FORBIDDEN_PREFIXES) {
    test(`imports nothing from ${prefix}`, () => {
      const offending = allRendererEdges()
        .filter((e) => e.to.startsWith(prefix))
        .map((e) => `${e.from} -> ${e.to}`)
        .sort();

      expect(
        offending,
        `The renderer must not import ${prefix} — ${why}.`,
      ).toEqual([]);
    });
  }

  test("leaves render/ only for modules that are named and clean", () => {
    const offending = allRendererEdges()
      .filter(
        (e) =>
          // Bare specifiers (npm packages, and the `resources/*` alias the
          // atlas metadata uses) are dropped by resolveSpecifier before this.
          !e.to.startsWith("src/client/render/") &&
          !e.to.startsWith("src/shared/") &&
          !ALLOWED_OUTSIDE_RENDER.includes(e.to),
      )
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

    expect(
      offending,
      "A new edge out of render/. Every such module brings its own imports " +
        "with it, which is how the simulation came back the last time. Point " +
        "at shared/, or add it to ALLOWED_OUTSIDE_RENDER with the reason.",
    ).toEqual([]);
  });

  /**
   * Counter-check for the scanner itself, run against a fixture rather than
   * against the tree.
   *
   * The renderer writes imports two ways — bare `src/...` alias and relative
   * `../../...` — and a matcher that understood only one of them would report
   * a clean boundary with a third of the edges unseen. Covers every form that
   * produces a real dependency, including the bindings-free `import "x"`, which
   * is invisible to a `from`-based matcher and would let a side-effect import
   * through.
   */
  test("resolves every import form the tree can use", () => {
    // A fictional path inside render/, so relative specifiers resolve the way
    // they would in a real pass. Nothing is written to disk.
    const pretendFile = path.join(RENDER_DIR, "gl", "passes", "Fixture.ts");
    const source = [
      'import { a } from "src/client/world/AliasForm";',
      'import { b } from "../../../world/RelativeForm";',
      'import { c } from "zod";',
      'const d = await import("src/client/world/DynamicForm");',
      '// import { e } from "src/client/world/CommentForm";',
      'export { f } from "src/client/world/ExportForm";',
      'import "src/client/world/SideEffectForm";',
    ].join(String.fromCharCode(10));

    const seen = edgesFromSource(pretendFile, source)
      .map((e) => `${e.form}:${e.to}`)
      .sort();

    expect(seen).toEqual([
      "alias:src/client/world/AliasForm",
      "alias:src/client/world/DynamicForm",
      "alias:src/client/world/ExportForm",
      "alias:src/client/world/SideEffectForm",
      "relative:src/client/world/RelativeForm",
    ]);
  });

  test("the planted violation is reported, not merely resolved", () => {
    // Resolving an edge and *acting* on it are two different things: the
    // boundary assertions above filter, and a filter with the wrong prefix
    // passes a tree full of violations. This runs the same filter over a
    // fixture that is known to be dirty.
    const pretendFile = path.join(RENDER_DIR, "Planted.ts");
    const edges = edgesFromSource(
      pretendFile,
      'import { Hud } from "src/client/world/ui/Hud";',
    );

    for (const [prefix] of FORBIDDEN_PREFIXES.filter(
      ([p]) => p === "src/client/world/",
    )) {
      expect(edges.filter((e) => e.to.startsWith(prefix))).toHaveLength(1);
    }
  });
});
