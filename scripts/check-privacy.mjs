#!/usr/bin/env node
/**
 * Fail if a tracked file names a specific deployment.
 *
 * `docs/README.md` says host names, IP addresses, ports and paths belong in a
 * git-ignored `*.local.md`, because this repository is public. That rule was
 * prose, and prose does not fail a build: between 2026-08-31 and 2026-09-01
 * `HANDOVER.md` carried the deployment host's name, its address and its port,
 * in the same paragraph as the sentence saying it would not. One commit put it
 * there and four more touched the file without noticing.
 *
 *   node scripts/check-privacy.mjs
 *   node scripts/check-privacy.mjs --self-test
 *
 * Exits non-zero on a finding, so it can go in CI.
 *
 * **What it can and cannot know.** A host name is a word; a checker cannot
 * recognise one without being told, and telling it in a tracked file would
 * leak the very thing it guards. So it works in two layers:
 *
 * 1. Shapes that need no secret: a routable IPv4 literal, and an absolute path
 *    into somebody's home directory. These catch the leak that actually
 *    happened.
 * 2. Words from `docs/deploy/private-terms.local.txt`, one per line, if that
 *    file exists. It is git-ignored (`*.local.txt`), so the terms stay on the
 *    machine that knows them. Absent, layer 1 still runs — a checker that
 *    refuses to work without configuration gets deleted.
 *
 * Loopback, private and documentation-reserved ranges pass: `127.0.0.1` in a
 * compose snippet is the *advice*, not the leak. The quarantine is skipped,
 * because it is inherited code nobody deploys.
 *
 * **Known false positive, accepted.** A four-part version number whose first
 * part is under 256 — `6.8.0.134`, say — is an address as far as any regular
 * expression is concerned, and gets reported. The trade is deliberate: a false
 * positive costs one rephrase, a missed address costs a push to a public
 * repository. Nothing tracked here trips it today.
 *
 * The scanner carries its own counter-proof in `--self-test` and in
 * `tests/architecture/PrivacyGuard.test.ts`. A guard that has never been seen
 * to bite is worth less than no guard, because it gets believed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

/** Inherited code nobody deploys; its fixtures are full of example addresses. */
const SKIP_PREFIXES = ["src/client/_legacy/", "tests/_legacy/"];

/** Binary, generated, or path-data files where a match is never a leak. */
const SKIP_EXTENSIONS = new Set([
  ".bin",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp3",
  ".ogg",
  ".wav",
  ".zip",
  ".lock",
]);

const SKIP_FILES = new Set(["package-lock.json"]);

/** Where the machine-local deny-list lives, if the machine has one. */
export const PRIVATE_TERMS_FILE = "docs/deploy/private-terms.local.txt";

const IPV4 = /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g;

/**
 * True for an address that says nothing about where anything is deployed.
 *
 * Loopback, link-local, the private ranges, the unspecified and broadcast
 * addresses, and the three ranges RFC 5737 reserves for documentation. Also
 * anything with an octet above 255, which is a version number wearing four
 * dots rather than an address.
 */
export function isNonRoutable(octets) {
  const [a, b, c] = octets;
  if (octets.some((n) => n > 255)) return true;
  if (a === 0 || a === 127 || a === 255) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  // RFC 5737 documentation ranges. All three are /24s, so the third octet is
  // part of the range — `203.0.113.0/24` is reserved, `203.113.0.0/16` is not.
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

/**
 * Findings in one file's text.
 *
 * `terms` is the optional machine-local deny-list. Returns
 * `{ line, kind, text }` for each, one-indexed, so a caller can print
 * `file:line`.
 */
export function findViolations(source, terms = []) {
  const found = [];
  const lines = source.split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const m of line.matchAll(IPV4)) {
      const octets = [m[1], m[2], m[3], m[4]].map(Number);
      if (isNonRoutable(octets)) continue;
      found.push({ line: i + 1, kind: "address", text: m[0] });
    }

    const home = line.match(
      /(\/home\/[a-z][a-z0-9_-]*|[A-Z]:\\Users\\[^\\\s"']+)/,
    );
    if (home) found.push({ line: i + 1, kind: "path", text: home[1] });

    for (const term of terms) {
      if (line.toLowerCase().includes(term.toLowerCase())) {
        found.push({ line: i + 1, kind: "term", text: term });
      }
    }
  });

  return found;
}

/** Deny-list terms from the machine-local file, or none if it does not exist. */
export function readPrivateTerms(root = REPO_ROOT) {
  const file = path.join(root, PRIVATE_TERMS_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 2 && !l.startsWith("#"));
}

/** Tracked files worth reading, repo-relative and POSIX-separated. */
export function trackedFiles(root = REPO_ROOT) {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((f) => !SKIP_PREFIXES.some((p) => f.startsWith(p)))
    .filter((f) => !SKIP_FILES.has(path.posix.basename(f)))
    .filter((f) => !SKIP_EXTENSIONS.has(path.posix.extname(f).toLowerCase()));
}

function main() {
  const terms = readPrivateTerms();
  const files = trackedFiles();
  const findings = [];

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(REPO_ROOT, file), "utf-8");
    } catch {
      continue; // Unreadable as text is not a leak.
    }
    for (const v of findViolations(text, terms)) {
      findings.push({ file, ...v });
    }
  }

  const scope =
    terms.length > 0
      ? `${files.length} tracked files, ${terms.length} local terms`
      : `${files.length} tracked files, no local deny-list ` +
        `(${PRIVATE_TERMS_FILE} absent — shape checks only)`;

  if (findings.length === 0) {
    console.log(`check-privacy: clean — ${scope}`);
    return 0;
  }

  console.error(`check-privacy: ${findings.length} finding(s) — ${scope}\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.kind}: ${f.text}`);
  }
  console.error(
    `\nThis repository is public. Host names, addresses, ports and paths of a\n` +
      `specific deployment belong in a git-ignored *.local.md — see docs/README.md.\n` +
      `Deleting the line does not undo a push: assume what leaked is public and\n` +
      `secure it, then clean the file so the rule stays credible.`,
  );
  return 1;
}

/**
 * The counter-proof. A guard nobody has seen fail proves nothing.
 *
 * The planted violations are assembled from parts rather than written out.
 * This file is tracked, so `main()` reads it like any other — a literal
 * address here would make the checker fail on itself, and the obvious way out
 * of that (exempting its own path) is a hole big enough to hide a real leak
 * in. Nothing below is a real address, host or path.
 */
function selfTest() {
  const checks = [];
  const ok = (name, pass) => checks.push({ name, pass });

  const plantedAddress = ["93", "184", "216", "34"].join(".");
  const plantedPath = ["", "home", "example", "openfront"].join("/");

  ok(
    "finds a planted address",
    findViolations(`the world runs at http://${plantedAddress}:8095/`).some(
      (v) => v.kind === "address" && v.text === plantedAddress,
    ),
  );
  ok(
    "finds a planted home path",
    findViolations(`checkout at ${plantedPath}/repo`).some(
      (v) => v.kind === "path",
    ),
  );
  ok(
    "finds a planted term",
    findViolations("redeploy of examplehost tonight", ["examplehost"]).some(
      (v) => v.kind === "term",
    ),
  );
  ok(
    "passes loopback and private ranges",
    findViolations('- "127.0.0.1:55434:5432" and 10.8.0.2 and 0.0.0.0:3000')
      .length === 0,
  );
  ok(
    "passes a four-part version whose first part cannot be an octet",
    findViolations("build 999.1.2.3").length === 0,
  );
  ok(
    "passes a documentation address",
    findViolations("example host 203.0.113.7").length === 0,
  );
  ok("reads more than a handful of tracked files", trackedFiles().length > 50);
  ok(
    "skips the quarantine, which is full of example addresses",
    !trackedFiles().some((f) => f.startsWith("tests/_legacy/")),
  );

  for (const c of checks) {
    console.log(`${c.pass ? "  ok  " : " FAIL "} ${c.name}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(
    failed === 0
      ? `\ncheck-privacy self-test: ${checks.length} checks passed`
      : `\ncheck-privacy self-test: ${failed} of ${checks.length} FAILED`,
  );
  return failed === 0 ? 0 : 1;
}

// Only when run as a command. `tests/architecture/PrivacyGuard.test.ts`
// imports the three functions above, and a module that exits on import takes
// the test suite with it.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  const isSelfTest = process.argv.includes("--self-test");
  process.exit(isSelfTest ? selfTest() : main());
}
