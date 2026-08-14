/**
 * `@bsl/seed` — the deterministic synthetic org shared by the mock API and the
 * web app's `db:seed`.
 *
 * The package ships TypeScript source with a single root export, so everything
 * consumers need is re-exported here.
 *
 * - `types`     — `SyntheticOrg` and friends (employee fields mirror §G7)
 * - `generate`  — `generateOrg(seed?, { now? })`, the whole universe
 * - `effective` — §G4 limit resolution over the seeded configuration
 * - `fixtures`  — `FIXTURE`, the named people every test suite refers to
 * - `rng`       — the mulberry32 PRNG, if a consumer needs its own stream
 */

export * from "./types";
export * from "./rng";
export * from "./names";
export * from "./effective";
export * from "./generate";
export * from "./fixtures";
