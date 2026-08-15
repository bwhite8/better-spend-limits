/**
 * The landing route.
 *
 * A first-time visitor should arrive at something that reads as an answer, not
 * at a 250-row roster they have to search. `/analytics` is that page: it opens
 * on the same permission scope every other page uses, so the redirect grants
 * nothing — whoever lands there sees exactly what they would have seen by
 * clicking Analytics themselves, including the 403 when they are not
 * provisioned.
 *
 * The list this route used to render now lives at `/members`, beside the
 * `/members/[id]` detail page it links to.
 *
 * `force-dynamic` is kept from the page that was here: the destination is
 * per-request and must never be prerendered into a static redirect.
 */

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function RootPage(): never {
  redirect("/analytics");
}
