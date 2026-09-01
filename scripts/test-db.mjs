#!/usr/bin/env node
/**
 * Run the Postgres integration tests against a real database.
 *
 *   node scripts/test-db.mjs            # against the compose database
 *   TEST_DATABASE_URL=... node scripts/test-db.mjs
 *
 * `tests/server/PgStore.test.ts` skips itself unless `TEST_DATABASE_URL` is
 * set, so the nine tests that touch Postgres only ever run when something
 * deliberately points them at one. That something used to be a shell prefix in
 * `package.json`:
 *
 *   TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://...} vitest run ...
 *
 * which is POSIX and npm runs scripts through `cmd.exe` on Windows, where it
 * fails before vitest starts: `Der Befehl "TEST_DATABASE_URL" ist entweder
 * falsch geschrieben oder konnte nicht gefunden werden.` The standing
 * end-of-phase checklist asks for `npm run test:db` after every phase, so on a
 * Windows machine the one suite that rots when nobody runs it was also the one
 * suite nobody *could* run.
 *
 * `cross-env` is already a devDependency and would fix the platform half, but
 * not the `:-` default: it assigns unconditionally and would silently point a
 * developer's explicit `TEST_DATABASE_URL` at localhost. Hence a script — it
 * keeps "use what you set, otherwise the compose database" and works the same
 * on both platforms.
 */

import { spawnSync } from "node:child_process";

/** Matches docker-compose.yml: user, password and database are all `openfront`. */
const COMPOSE_DATABASE_URL =
  "postgres://openfront:openfront@localhost:5432/openfront";

/**
 * Empty counts as unset, which `??` would not do.
 *
 * `example.env` ships `TEST_DATABASE_URL=` with nothing after it, so a
 * developer who copies it to `.env` and sources it has the variable *set* to
 * the empty string. Handing that to pg produces a connection error about a
 * missing host, which reads as a broken database rather than a missing
 * setting.
 */
const configured = process.env.TEST_DATABASE_URL?.trim();
const isConfigured = configured !== undefined && configured.length > 0;
const url = isConfigured ? configured : COMPOSE_DATABASE_URL;

if (!isConfigured) {
  console.log(`TEST_DATABASE_URL unset — using the compose database at ${url}`);
}

const result = spawnSync(
  "npx",
  ["vitest", "run", "tests/server/PgStore.test.ts", ...process.argv.slice(2)],
  {
    stdio: "inherit",
    // npx is a shell script on Windows; without this, spawn cannot find it.
    shell: true,
    env: { ...process.env, TEST_DATABASE_URL: url },
  },
);

process.exit(result.status ?? 1);
