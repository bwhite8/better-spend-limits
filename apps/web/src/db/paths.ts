import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** §G6 default. Relative paths resolve against `process.cwd()`. */
export const DEFAULT_DATABASE_PATH = "./data/app.db";

/** better-sqlite3's in-memory sentinel; used by tests (see `client.ts`). */
export const IN_MEMORY_DATABASE = ":memory:";

/**
 * Where the SQLite file lives, per §G6 `DATABASE_PATH`.
 *
 * Relative paths are resolved against `process.cwd()`, which is the standard
 * Next.js convention and — importantly — is `apps/web` for every command that
 * touches the database: `next dev`/`next start`, `drizzle-kit migrate` and
 * `tsx src/db/seed.ts` all run through `npm -w apps/web`. So the default lands
 * at `apps/web/data/app.db` no matter which of them created it.
 *
 * (Anchoring to the module's own location via `import.meta.url` would be more
 * cwd-proof but is unreliable here: `client.ts` gets bundled into `.next/`,
 * where `import.meta.url` points at the emitted chunk rather than the source.)
 */
export function resolveDatabasePath(options: { ensureDir?: boolean } = {}): string {
  const configured = process.env.DATABASE_PATH?.trim();
  const raw = configured && configured.length > 0 ? configured : DEFAULT_DATABASE_PATH;

  if (raw === IN_MEMORY_DATABASE) return raw;

  // `turbopackIgnore` because this is a runtime data path, not a module
  // reference. Without it Turbopack's static analysis assumes the worst and
  // traces the entire project into the server bundle.
  const absolute = isAbsolute(raw) ? raw : resolve(/* turbopackIgnore: true */ process.cwd(), raw);

  // better-sqlite3 will not create a missing parent directory, so a fresh clone
  // running `npm run db:migrate` would fail without this.
  if (options.ensureDir !== false) mkdirSync(dirname(absolute), { recursive: true });

  return absolute;
}
