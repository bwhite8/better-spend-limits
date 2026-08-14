/**
 * mock-api — a Hono server emulating `api.anthropic.com` for the spend-limits
 * and analytics surfaces (plan §G4/§G5).
 *
 * Importing this package gives you the app FACTORY, not a running server:
 * `apps/web`'s sync tests boot the very same routing stack in-process so they
 * exercise the real wire contract instead of a hand-rolled stub.
 */

export * from "./app.js";
export * from "./auth.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./rate-limit.js";
export * from "./request.js";
export * from "./state.js";
export * from "./routes/spend-limits.js";
export * from "./routes/increase-requests.js";
export * from "./routes/analytics.js";
