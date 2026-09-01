import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

// The guard is a plain .mjs script so CI can run it without a build step; the
// three functions below are its only exports that this test needs.
import {
  findViolations,
  isNonRoutable,
  trackedFiles,
} from "../../scripts/check-privacy.mjs";

/**
 * The repository is public, and the rule that keeps it safe to be public is
 * that no tracked file names a specific deployment.
 *
 * That rule lived in `docs/README.md` as prose for eleven phases, and prose
 * does not fail a build. Between 2026-08-31 and 2026-09-01 `HANDOVER.md`
 * carried the deployment host's name, its address and its port — in the same
 * paragraph as the sentence promising it would not. One commit introduced it
 * and four more edited the file without seeing it, because nothing looked.
 *
 * `scripts/check-privacy.mjs` looks. This test is what says it still bites:
 * every planted violation below is one the scanner must find, and the scope
 * assertions are there because a scanner that has quietly stopped reading the
 * repository passes a "no findings" check perfectly.
 *
 * The script carries the same proof as `--self-test`, for CI and for anyone
 * running it by hand. This file is the half that runs with `npm run test`, so
 * a change to the scanner cannot go green without one of the two objecting.
 */

/** Assembled from parts: a literal address here would trip the guard itself. */
const PLANTED_ADDRESS = ["93", "184", "216", "34"].join(".");
const PLANTED_HOME = ["", "home", "example", "openfront"].join("/");

describe("the privacy guard", () => {
  describe("finds a planted violation", () => {
    test("a routable address, which is the leak that happened", () => {
      const found = findViolations(
        `The world runs at http://${PLANTED_ADDRESS}:8095/`,
      );
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        line: 1,
        kind: "address",
        text: PLANTED_ADDRESS,
      });
    });

    test("an absolute path into somebody's home directory", () => {
      const found = findViolations(`checkout at ${PLANTED_HOME}/repo`);
      expect(found.map((v: { kind: string }) => v.kind)).toContain("path");
    });

    test("a Windows user path", () => {
      const found = findViolations(["C:", "Users", "someone"].join("\\"));
      expect(found.map((v: { kind: string }) => v.kind)).toContain("path");
    });

    test("a word from the machine-local deny-list", () => {
      const found = findViolations("redeploy of examplehost tonight", [
        "examplehost",
      ]);
      expect(found.map((v: { kind: string }) => v.kind)).toContain("term");
    });

    test("reports the line it found it on", () => {
      const found = findViolations(
        ["clean", "clean", `see ${PLANTED_ADDRESS}`].join("\n"),
      );
      expect(found[0].line).toBe(3);
    });
  });

  describe("passes what is advice rather than a leak", () => {
    test("loopback, private and unspecified addresses", () => {
      expect(
        findViolations('- "127.0.0.1:55434:5432", 10.8.0.2, 0.0.0.0:3000'),
      ).toEqual([]);
      expect(findViolations("192.168.1.10 and 172.16.0.5")).toEqual([]);
    });

    test("the three ranges RFC 5737 reserves for documentation", () => {
      for (const a of ["192.0.2.7", "198.51.100.7", "203.0.113.7"]) {
        expect(findViolations(`example host ${a}`), a).toEqual([]);
      }
    });

    test("but not an address that only looks reserved", () => {
      // Only the documentation /24 is reserved. The same leading octet with
      // the other digits rearranged is a real address and must be reported.
      expect(isNonRoutable([203, 113, 0, 7])).toBe(false);
      expect(isNonRoutable([203, 0, 113, 7])).toBe(true);
    });

    test("a version number with an impossible octet", () => {
      expect(findViolations("build 999.1.2.3")).toEqual([]);
    });
  });

  describe("still reads the repository", () => {
    // A scanner that reaches nothing passes every assertion above trivially.
    test("scans a real number of tracked files", () => {
      expect(trackedFiles().length).toBeGreaterThan(100);
    });

    test("scans the files the leak was in", () => {
      const files = trackedFiles();
      expect(files).toContain("HANDOVER.md");
      expect(files).toContain("docs/README.md");
      expect(files).toContain("CLAUDE.md");
    });

    test("skips the quarantine, whose fixtures are full of example addresses", () => {
      const files = trackedFiles();
      expect(files.some((f: string) => f.startsWith("tests/_legacy/"))).toBe(
        false,
      );
      expect(
        files.some((f: string) => f.startsWith("src/client/_legacy/")),
      ).toBe(false);
    });
  });

  test("the repository is clean right now", () => {
    const findings = trackedFiles().flatMap((file: string) => {
      const full = path.resolve(__dirname, "..", "..", file);
      let text: string;
      try {
        text = fs.readFileSync(full, "utf-8");
      } catch {
        return [];
      }
      return findViolations(text).map((v: { line: number; text: string }) => ({
        where: `${file}:${v.line}`,
        what: v.text,
      }));
    });

    expect(
      findings,
      "A tracked file names a specific deployment. This repository is public — " +
        "host names, addresses, ports and paths belong in a git-ignored " +
        "*.local.md. See docs/README.md.",
    ).toEqual([]);
  });
});
