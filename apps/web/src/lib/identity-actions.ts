"use server";

/**
 * The dev-mode impersonation server actions, for the Phase-9 user switcher.
 *
 * They live apart from `identity.ts` because a `"use server"` module may only
 * export async functions — every export becomes a callable RPC endpoint — while
 * `identity.ts` is mostly synchronous helpers and types.
 *
 * These wrappers take only the arguments a client is allowed to control. The
 * underlying functions accept an `env` override for testing; exposing that
 * parameter over the wire would let a caller claim to be in dev mode.
 */

import {
  clearImpersonation as clearImpersonationCookie,
  setImpersonation as setImpersonationCookie,
} from "./identity";

/** Switch the current dev session to `email`. Throws when `AUTH_MODE` is not `dev`. */
export async function setImpersonation(email: string): Promise<void> {
  await setImpersonationCookie(email);
}

/** Sign the current dev session out. Throws when `AUTH_MODE` is not `dev`. */
export async function clearImpersonation(): Promise<void> {
  await clearImpersonationCookie();
}
