import { defineConfig } from "drizzle-kit";

// Migrations are generated into drizzle/ and applied by the server at startup.
// A shipped migration is never edited (CLAUDE.md §9): a world that has already
// run one would not run it again, so an edit reaches only the machines that
// have not started yet.
export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/openfront",
  },
});
