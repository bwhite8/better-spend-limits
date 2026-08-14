import { defineConfig } from "drizzle-kit";

import { resolveDatabasePath } from "./src/db/paths";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Same §G6 resolution the running app uses, and it creates `data/` if the
    // clone is fresh — otherwise better-sqlite3 fails on the missing directory.
    url: resolveDatabasePath(),
  },
});
