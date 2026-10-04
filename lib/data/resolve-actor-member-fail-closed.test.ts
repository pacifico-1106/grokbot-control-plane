import { expect, mock, test } from "bun:test";

/**
 * resolveActorMember (lib/data/members.ts) had the same production owner
 * fallback as requireCapability: an unknown / missing actor id resolved to the
 * org owner (or the first member). Production must resolve only an exact,
 * active member of that org and otherwise return null. DEMO is unchanged.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED_ID = "44444444-4444-4444-8444-444444444444";
const ROWS = [
  { id: OWNER_ID, org_id: ORG, email: "owner@corp.test", display_name: "owner", role: "owner", job_role: "owner", capabilities: ["approve_actions", "hire_issue_credentials"], status: "active" },
  { id: MEMBER_ID, org_id: ORG, email: "m@corp.test", display_name: "m", role: "member", job_role: "custom", capabilities: ["view_dashboard"], status: "active" },
  { id: DISABLED_ID, org_id: ORG, email: "d@corp.test", display_name: "d", role: "admin", job_role: "custom", capabilities: ["approve_actions"], status: "disabled" },
];

let demo = false;
mock.module("@/lib/mode", () => ({ isDemoMode: () => demo }));
function fakeAdmin() {
  const q = {
    filters: {} as Record<string, unknown>,
    select() { return q; },
    eq(col: string, v: unknown) { q.filters[col] = v; return q; },
    order() {
      const rows = ROWS.filter((r) => r.org_id === q.filters.org_id);
      return Promise.resolve({ data: rows, error: null });
    },
  };
  return { from: () => ({ select: () => { q.filters = {}; return q; } }) };
}
mock.module("@/lib/supabase", () => ({
  createSupabaseAdminClient: () => fakeAdmin(),
  createSupabaseServerClient: () => null,
}));

const { resolveActorMember } = await import("./members");

test("production: exact active member id in the org resolves to that member", async () => {
  const m = await resolveActorMember(MEMBER_ID, ORG);
  expect(m?.id).toBe(MEMBER_ID);
});

test("production: real owner id resolves to the owner", async () => {
  const m = await resolveActorMember(OWNER_ID, ORG);
  expect(m?.id).toBe(OWNER_ID);
  expect(m?.role).toBe("owner");
});

for (const [label, id] of [
  ["missing actor id", null],
  ["empty actor id", ""],
  ["unknown actor id", "55555555-5555-4555-8555-555555555555"],
  ["demo id mem_1", "mem_1"],
] as const) {
  test(`production: ${label} → null (no owner / first-member fallback)`, async () => {
    expect(await resolveActorMember(id, ORG)).toBeNull();
  });
}

test("production: no org → null", async () => {
  expect(await resolveActorMember(OWNER_ID, null)).toBeNull();
});

test("production: member of another org → null", async () => {
  expect(await resolveActorMember(OWNER_ID, "99999999-9999-4999-8999-999999999999")).toBeNull();
});

test("production: non-active member → null", async () => {
  expect(await resolveActorMember(DISABLED_ID, ORG)).toBeNull();
});

test("DEMO (unchanged): missing id → demo owner mem_1", async () => {
  demo = true;
  try {
    const m = await resolveActorMember(null, "org_demo");
    expect(m?.id).toBe("mem_1");
  } finally {
    demo = false;
  }
});
