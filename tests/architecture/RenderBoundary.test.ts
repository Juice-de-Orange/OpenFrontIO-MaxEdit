import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * The renderer's import boundary.
 *
 * Phase 0 severed `src/client/render/` from `src/core/`. This began as a
 * ratchet whose allowlist shrank commit by commit; the allowlist is empty now
 * and the rule is absolute.
 *
 * Two assertions, because the boundary fails in two different ways. A direct
 * `src/core/...` import is the obvious regression. The subtler one is a fresh
 * edge into some other part of `src/client/`, which reads as harmless and
 * drags the simulation back in through that module's own imports —
 * client/Utils.ts did exactly that, and it kept 56 core files in the
 * renderer's type graph long after every direct import looked clean.
 *
 * Counting import *statements*, not string occurrences: a prose comment
 * naming a core module is not an edge, and a multi-line import is one edge,
 * not several.
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
  // Translation lookup. Types its lang-selector structurally precisely so it
  // does not drag LangSelector -> LanguageModal -> ModalRouter -> Utils along.
  "src/client/i18n/Translate",
  // A small lit element for the "WebGL unavailable" state, used by
  // gl/initGL.ts. It imports nothing but lit, and the probe from initGL.ts
  // reports zero core files. It is UI, so it would sit oddly under render/.
  "src/client/components/WebGLGate",
];

interface Edge {
  /** Repo-relative path of the importing file, forward slashes. */
  from: string;
  /** Resolved module, e.g. "src/core/configuration/Config". */
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
 * module reads as an edge — frame/RailroadCache.ts used to carry exactly such
 * a comment, and it is why a naive grep over this tree over-counts.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Every module specifier a file imports, comments excluded. */
function importedSpecifiers(file: string): string[] {
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
  return resolved.replace(/\.(ts|js)$/, "");
}

function edgesIn(file: string): Edge[] {
  const from = toPosix(path.relative(REPO_ROOT, file));
  const edges: Edge[] = [];
  for (const spec of importedSpecifiers(file)) {
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

function allRendererEdges(): Edge[] {
  return tsFilesUnder(RENDER_DIR).flatMap(edgesIn);
}

describe("src/client/render import boundary", () => {
  test("imports nothing from src/core", () => {
    const offending = allRendererEdges()
      .filter((e) => e.to.startsWith("src/core/"))
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

    expect(
      offending,
      "The renderer must not import src/core. The client renders; the " +
        "server owns the simulation.",
    ).toEqual([]);
  });

  test("leaves render/ only for modules that are named and clean", () => {
    const offending = allRendererEdges()
      .filter(
        (e) =>
          !e.to.startsWith("src/client/render/") &&
          !e.to.startsWith("src/shared/") &&
          !e.to.startsWith("resources/") &&
          !ALLOWED_OUTSIDE_RENDER.includes(e.to),
      )
      .map((e) => `${e.from} -> ${e.to}`)
      .sort();

    expect(
      offending,
      "A new edge out of render/. Every such module brings its own imports " +
        "with it, which is how src/core came back the last time. Point at " +
        "shared/, or add it to ALLOWED_OUTSIDE_RENDER with the reason.",
    ).toEqual([]);
  });

  /**
   * Counter-check for the scanner itself, run against a fixture rather than
   * against the tree.
   *
   * The renderer wrote core imports two ways — bare `src/core/...` alias and
   * relative `../../core/...` — and a matcher that understood only one of them
   * would have reported a clean boundary with a third of the edges unseen.
   * Asserting that both forms appear in the tree only worked while both
   * happened to be present, which stopped being true as the couplings were
   * resolved. A fixture keeps the check meaningful now that the real edges are
   * gone.
   */
  test("resolves both the alias and the relative path form", () => {
    const fixture = path.join(RENDER_DIR, "__scanner_fixture__.ts");
    fs.writeFileSync(
      fixture,
      [
        'import { a } from "src/core/AliasForm";',
        'import { b } from "../../core/RelativeForm";',
        'import { c } from "zod";',
        'const d = await import("src/core/DynamicForm");',
        '// import { e } from "src/core/CommentForm";',
        'export { f } from "src/core/ExportForm";',
      ].join(String.fromCharCode(10)),
    );
    try {
      const seen = edgesIn(fixture)
        .filter((e) => e.to.startsWith("src/core/"))
        .map((e) => `${e.form}:${e.to}`)
        .sort();
      expect(seen).toEqual([
        "alias:src/core/AliasForm",
        "alias:src/core/DynamicForm",
        "alias:src/core/ExportForm",
        "relative:src/core/RelativeForm",
      ]);
    } finally {
      fs.unlinkSync(fixture);
    }
  });
});
