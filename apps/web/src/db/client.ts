import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";
import { IN_MEMORY_DATABASE, resolveDatabasePath } from "./paths";

export type AppDatabase = ReturnType<typeof createDb>;

/**
 * Open a database at an explicit location. Callers that just want "the app's
 * database" should use {@link getDb}; this exists for tests and CLIs that need
 * their own handle.
 */
export function createDb(file: string) {
  const sqlite = new Database(file);

  // Enforce the §G7 `employees` self-references. Seeding defers these to the end
  // of its transaction (see `seed.ts`) because an employee may be aligned to an
  // AI lead who appears later in the insert order.
  sqlite.pragma("foreign_keys = ON");
  if (file !== IN_MEMORY_DATABASE) sqlite.pragma("journal_mode = WAL");

  return drizzle(sqlite, { schema });
}

let cached: AppDatabase | null = null;

/**
 * The process-wide database handle.
 *
 * Location comes from `DATABASE_PATH` (§G6, default `./data/app.db`), except
 * under `NODE_ENV=test` where an unset `DATABASE_PATH` means `:memory:` — so a
 * stray test can never scribble on a developer's real file.
 */
export function getDb(): AppDatabase {
  if (cached) return cached;

  const explicitPath = process.env.DATABASE_PATH?.trim();
  const useMemory = process.env.NODE_ENV === "test" && !explicitPath;

  cached = createDb(useMemory ? IN_MEMORY_DATABASE : resolveDatabasePath());
  return cached;
}

/** Drop the cached handle (tests; hot-reload teardown). */
export function closeDb(): void {
  cached?.$client.close();
  cached = null;
}
