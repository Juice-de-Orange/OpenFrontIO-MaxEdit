import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

/**
 * Every migration the journal names must exist **and be in the repository**.
 *
 * `.gitignore` carries `*.sql` — inherited, and aimed at database dumps, which
 * contain password hashes. It also matched `drizzle/*.sql`, so neither
 * migration was ever committed: `drizzle/meta/_journal.json` listed two
 * migrations whose SQL was not in the repository, and a fresh clone would have
 * started a world against a database with no tables in it. Nothing failed
 * locally, because the files were on the disk of the machine that generated
 * them.
 *
 * Existence on disk is therefore not the check. Being tracked by git is.
 */
const REPO = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(REPO, "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Whether git has this path in the index. Paths are repository-relative. */
function isTracked(relative: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relative], {
      cwd: REPO,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

describe("database migrations", () => {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf-8"),
  ) as Journal;

  test("the journal is not empty", () => {
    // Otherwise every assertion below passes over nothing.
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  test("every migration in the journal exists on disk", () => {
    for (const entry of journal.entries) {
      const file = path.join(MIGRATIONS, `${entry.tag}.sql`);
      expect(fs.existsSync(file), `${entry.tag}.sql is missing`).toBe(true);
    }
  });

  test("and every one of them is tracked by git", () => {
    for (const entry of journal.entries) {
      expect(
        isTracked(`drizzle/${entry.tag}.sql`),
        `drizzle/${entry.tag}.sql is on disk but not in the repository — ` +
          `check .gitignore`,
      ).toBe(true);
    }
  });

  /**
   * The guard's own self-test. The first version of this file would have
   * passed against the very state it was written to catch, because
   * `fs.existsSync` is true for a file that git has never seen. Verify a guard
   * by breaking something on purpose, not by reading it.
   */
  test("the tracked check can tell an untracked file from a tracked one", () => {
    expect(isTracked("drizzle/meta/_journal.json")).toBe(true);
    expect(isTracked("drizzle/this-file-does-not-exist.sql")).toBe(false);
  });
});
