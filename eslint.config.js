import { includeIgnoreFile } from "@eslint/compat";
import pluginJs from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const gitignorePath = path.resolve(__dirname, ".gitignore");

/** @type {import('eslint').Linter.Config[]} */
export default [
  includeIgnoreFile(gitignorePath),
  {
    ignores: [
      // Quarantine. Must stay in step with tsconfig's exclude and
      // .oxlintrc.json: a file outside every tsconfig project makes both
      // linters abort with "not found by the project service".
      "src/client/_legacy/**",
      "tests/_legacy/**",
      "src/server/gatekeeper/**",
      "tests/pathfinding/playground/**",
      ".claude/**",
    ],
  },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "__mocks__/fileMock.js",
            "eslint.config.js",
            "scripts/sync-assets.mjs",
            "scripts/check-doc-links.mjs",
            "scripts/phase1-gate.mjs",
            "scripts/phase2-gate.mjs",
            "scripts/phase3-gate.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      // Disable rules that would fail. The failures should be fixed, and the entries here removed.
      "@typescript-eslint/no-explicit-any": "off",
      "no-unused-vars": "off",
    },
  },
  {
    rules: {
      // Enable rules
      "@typescript-eslint/prefer-nullish-coalescing": "error",
      eqeqeq: "error",
      "no-case-declarations": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
        },
      ],
    },
  },
  // Package boundaries. tests/architecture/RenderBoundary.test.ts is the
  // authority — it resolves specifiers and checks the whole tree; these zones
  // are the fast editor-time half.
  //
  // The render zone deliberately covers core/ only, not "any module outside
  // render/". no-restricted-imports matches the written specifier rather than
  // the resolved module, so a rule broad enough to catch `../../Utils` also
  // catches every relative import *within* render/ (measured: 315 false
  // positives), and `!`-negations do not lift a matched group. The transitive
  // case — an edge into another client package that drags core in behind it —
  // is therefore only caught by the test.
  {
    files: ["src/client/render/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/core/*", "**/core/**", "src/core/*", "src/core/**"],
              message:
                "render/ must not import core/ — the client renders, the server simulates. See docs/decisions/0004-renderer-owns-its-vocabulary.md.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/shared/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/client/**",
                "**/server/**",
                "**/core/**",
                "src/client/**",
                "src/server/**",
                "src/core/**",
              ],
              message:
                "shared/ imports nothing from client/, server/ or core/. It is the layer both sides depend on, so a single edge out of it inverts the dependency.",
            },
          ],
        },
      ],
    },
  },
];
