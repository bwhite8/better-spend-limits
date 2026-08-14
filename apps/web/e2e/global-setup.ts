/**
 * Give the suite a database it can reason about: delete, migrate, seed.
 *
 * Deleting rather than re-seeding in place matters because `db:seed` only wipes
 * `employees` — the synced snapshot tables and the audit log survive it, and a
 * run that inherits the previous run's approved requests is a run whose
 * assertions mean nothing.
 *
 * Ordering note: Playwright starts `webServer` processes BEFORE global setup
 * runs, so the web server is already listening while this executes. That is
 * safe only because its readiness probe is `/api/health`, which opens no
 * database handle — see that route's comment.
 */

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { E2E_DATABASE_PATH, REPO_ROOT } from "./paths";

/** WAL mode leaves sidecars behind; a stale one would resurrect old pages. */
const SQLITE_SUFFIXES = ["", "-journal", "-wal", "-shm"];

export default function globalSetup(): void {
  for (const suffix of SQLITE_SUFFIXES) {
    rmSync(`${E2E_DATABASE_PATH}${suffix}`, { force: true });
  }

  const env = { ...process.env, DATABASE_PATH: E2E_DATABASE_PATH };
  for (const script of ["db:migrate", "db:seed"]) {
    execFileSync("npm", ["run", script], { cwd: REPO_ROOT, env, stdio: "inherit" });
  }
}
