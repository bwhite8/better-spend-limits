"use client";

/**
 * The dev-mode "become somebody else" control (§G6 `AUTH_MODE=dev`).
 *
 * It writes the `bsl_impersonate` cookie through the Phase-7 server action and
 * then refreshes the router, so every server component re-renders under the new
 * identity without a full page load. The layout only renders it in dev mode;
 * in `proxy` mode the action throws by design, so there is nothing to hide.
 *
 * `currentEmail` may be an address with no employee row — that is the "not
 * provisioned" state, and the switcher is exactly how a user gets out of it,
 * which is why it also renders on the forbidden page.
 */

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { setImpersonation } from "@/lib/identity-actions";

// Values, not just types: `SWITCHER_GROUPS` must NOT be re-exported from this
// module. Anything exported from a `"use client"` file becomes a client
// reference on the server, and the layout needs the real array.
import { SWITCHER_GROUPS, type SwitcherOption } from "./switcher-groups";

export interface UserSwitcherProps {
  options: SwitcherOption[];
  /** The email currently impersonated, even if it matches no employee. */
  currentEmail: string | null;
}

export function UserSwitcher({ options, currentEmail }: UserSwitcherProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const handleChange = (email: string) => {
    if (email === "" || email === currentEmail) return;
    startTransition(async () => {
      await setImpersonation(email);
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-1" data-testid="user-switcher-root" data-pending={pending}>
      <label htmlFor="user-switcher" className="text-xs font-medium tracking-wide text-slate-500 uppercase">
        Viewing as
      </label>
      <select
        id="user-switcher"
        data-testid="user-switcher"
        value={currentEmail ?? ""}
        disabled={pending}
        onChange={(event) => handleChange(event.target.value)}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <option value="" disabled>
          Choose a user…
        </option>
        {/* An impersonated address with no employee row still needs to show up. */}
        {currentEmail !== null && !options.some((option) => option.email === currentEmail) ? (
          <option value={currentEmail}>{currentEmail} (not provisioned)</option>
        ) : null}
        {SWITCHER_GROUPS.map((group) => {
          const members = options.filter((option) => option.group === group);
          if (members.length === 0) return null;
          return (
            <optgroup key={group} label={`${group} (${members.length})`}>
              {members.map((option) => (
                <option key={option.email} value={option.email}>
                  {option.name} — {option.email}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}
