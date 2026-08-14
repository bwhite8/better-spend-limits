/**
 * @bsl/shared — the wire contract and money rules every workspace agrees on.
 *
 * The package ships TypeScript source with a single root export, so everything
 * consumers need must be re-exported here.
 *
 * - `schemas/spend-limits` — Zod schemas + types for the Spend Limits API (§G4)
 * - `schemas/analytics`    — Zod schemas + types for the cost report (§G5)
 * - `money`                — decimal minor-unit parsing, formatting, ratios (§G9)
 * - `cursor`               — opaque, parameter-bound pagination cursors (§G4)
 */

export * from "./open-enum";
export * from "./schemas/spend-limits";
export * from "./schemas/analytics";
export * from "./money";
export * from "./cursor";
