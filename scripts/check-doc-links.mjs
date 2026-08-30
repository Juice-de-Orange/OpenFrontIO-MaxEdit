#!/usr/bin/env node
/**
 * Verify that every relative link in every Markdown file resolves.
 *
 * Documentation rots quietly. A moved file leaves links that still look fine in
 * a diff and only fail when somebody follows them — usually the person who had
 * the least context to begin with. This catches that in a second.
 *
 *   node scripts/check-doc-links.mjs
 *
 * Exits non-zero if anything is broken, so it can go in CI.
 *
 * External links (http/https) are deliberately not checked: they fail for
 * reasons that have nothing to do with this repository, and a check that cries
 * wolf gets ignored.
 */

import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "static",
  "out",
  "build",
  "coverage",
  ".worktrees",
]);

/** @returns {string[]} every .md file, repo-relative, POSIX separators */
function collectMarkdown(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        collectMarkdown(path.join(dir, entry.name), acc);
      }
    } else if (entry.name.endsWith(".md")) {
      acc.push(
        path
          .relative(".", path.join(dir, entry.name))
          .split(path.sep)
          .join("/"),
      );
    }
  }
  return acc;
}

const LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const files = collectMarkdown(".");
const broken = [];
let checked = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const dir = path.dirname(file);
  for (const [, , target] of source.matchAll(LINK)) {
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    // Strip any anchor; we verify the file exists, not the heading.
    const filePart = target.split("#")[0];
    if (!filePart) continue;
    checked += 1;
    if (!fs.existsSync(path.resolve(dir, filePart))) {
      broken.push({ file, target });
    }
  }
}

console.log(
  `${files.length} markdown files, ${checked} relative links checked`,
);

if (broken.length > 0) {
  console.error(`\n${broken.length} broken link(s):`);
  for (const { file, target } of broken) {
    console.error(`  ${file} -> ${target}`);
  }
  process.exit(1);
}

console.log("All relative links resolve.");
