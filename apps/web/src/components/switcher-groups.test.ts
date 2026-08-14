/**
 * The switcher's buckets are derived from the hierarchy columns, not from a job
 * title the database does not store — so the derivation is worth pinning.
 *
 * The seed guarantees the interesting shapes: VPs and AI leads are deliberately
 * never admins (Phase 3), so "Admin wins over both" is only observable on a
 * fixture that genuinely holds two roles.
 */

import { getFixtureOrg } from "@bsl/seed";
import { describe, expect, it } from "vitest";

import { switcherOptionsFor, SWITCHER_GROUPS, type SwitcherSubject } from "./switcher-groups";

function subject(overrides: Partial<SwitcherSubject> & { id: string }): SwitcherSubject {
  return {
    name: overrides.id,
    email: `${overrides.id}@example.com`,
    is_admin: false,
    direct_manager_id: null,
    tier2_manager_id: null,
    tier3_manager_id: null,
    tier4_manager_id: null,
    aligned_ai_lead_id: null,
    ...overrides,
  };
}

describe("switcherOptionsFor", () => {
  it("puts everybody in exactly one known group", () => {
    const options = switcherOptionsFor(getFixtureOrg().employees);

    expect(options).toHaveLength(250);
    for (const option of options) {
      expect(SWITCHER_GROUPS).toContain(option.group);
    }
  });

  it("classifies by hierarchy reference, with admin taking precedence", () => {
    const rows = [
      subject({ id: "boss" }),
      subject({ id: "lead" }),
      subject({ id: "admin-and-lead", is_admin: true }),
      subject({ id: "ic", direct_manager_id: "boss", aligned_ai_lead_id: "lead" }),
      subject({ id: "ic2", tier4_manager_id: "boss", aligned_ai_lead_id: "admin-and-lead" }),
    ];

    const byId = new Map(switcherOptionsFor(rows).map((o) => [o.email.split("@")[0], o.group]));

    expect(byId.get("boss")).toBe("Managers");
    expect(byId.get("lead")).toBe("AI Leads");
    // Referenced as an AI lead, but admin wins.
    expect(byId.get("admin-and-lead")).toBe("Admins");
    expect(byId.get("ic")).toBe("ICs");
    expect(byId.get("ic2")).toBe("ICs");
  });

  it("produces at least one option per group for the seeded org", () => {
    const groups = new Set(switcherOptionsFor(getFixtureOrg().employees).map((o) => o.group));

    for (const group of SWITCHER_GROUPS) expect(groups).toContain(group);
  });
});
