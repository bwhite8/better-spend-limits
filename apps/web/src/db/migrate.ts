import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { AppDatabase } from "./client";

/**
 * Absolute path to the generated migrations folder.
 *
 * `import.meta.url` is safe here because nothing in the Next.js app imports this
 * module — it is used by tests and by tooling that runs the source directly.
 * `drizzle-kit migrate` (the `db:migrate` command) reads the same folder via
 * `drizzle.config.ts`, and both share the `__drizzle_migrations` journal, so the
 * two paths are interchangeable on the same file.
 */
export const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Apply every pending migration. Idempotent. */
export function runMigrations(db: AppDatabase): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
