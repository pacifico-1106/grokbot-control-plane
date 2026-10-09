/**
 * project_access same-org check, production (Supabase) lookup: scoped by
 * org_id, non-uuid ids never queried (refused), lookup errors fail closed
 * (project_access_unverified, 503). Stubbed client; no network.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const realMode = await import("@/lib/mode");
const realSupabase = await import("@/lib/supabase");
mock.module("@/lib/mode", () => ({ ...realMode, isDemoMode: () => false }));
type Call = { table: string; eq: Array<[string, unknown]>; inIds: string[] };
let calls: Call[] = [];
let rows: Array<{ id: string }> = [];
let failWith: "error" | "throw" | "noclient" | null = null;
mock.module("@/lib/supabase", () => ({
  ...realSupabase,
  createSupabaseAdminClient: () => {
    if (failWith === "noclient") return null;
    return {
      from(table: string) {
        const call: Call = { table, eq: [], inIds: [] };
        calls.push(call);
        const q = {
          select: () => q,
          eq: (k: string, v: unknown) => { call.eq.push([k, v]); return q; },
          in: async (_k: string, ids: string[]) => {
            call.inIds = ids;
            if (failWith === "throw") throw new Error("boom");
            if (failWith === "error") return { data: null, error: { message: "db down" } };
            return { data: rows.filter((r) => ids.includes(r.id)), error: null };
          },
        };
        return q;
      },
    };
  },
}));
const audits: Array<Record<string, unknown>> = [];
mock.module("@/lib/data/audit", () => ({ appendAuditEvent: async (e: Record<string, unknown>) => { audits.push(e); } }));

const { findProjectIdsOutsideOrg, assertProjectAccessSameOrg, ProjectAccessOrgError, projectAccessRefusalStatus } =
  await import("@/lib/employees/project-access-org");

const ORG = "11111111-1111-4111-8111-111111111111";
const P1 = "22222222-2222-4222-8222-222222222222";
const P2 = "33333333-3333-4333-8333-333333333333";

beforeEach(() => { calls = []; rows = [{ id: P1 }]; failWith = null; audits.length = 0; });

describe("production lookup", () => {
  test("one query, scoped by org_id, only uuid-shaped ids; others are outside", async () => {
    const r = await findProjectIdsOutsideOrg(ORG, [P1, P2, "not-a-uuid"]);
    expect(r).toEqual({ ok: true, outside: [P2, "not-a-uuid"] });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("org_projects");
    expect(calls[0].eq).toEqual([["org_id", ORG]]);
    expect(calls[0].inIds).toEqual([P1, P2]);
  });
  test("all ids in the org → nothing outside, no audit", async () => {
    rows = [{ id: P1 }, { id: P2 }];
    await assertProjectAccessSameOrg({ orgId: ORG, projectAccess: { mode: "selected", projectIds: [P1, P2] }, audit: { path: "t" } });
    expect(audits).toHaveLength(0);
  });
  for (const mode of ["error", "throw", "noclient"] as const) {
    test(`lookup ${mode} → fail closed: project_access_unverified (503), one audit row`, async () => {
      failWith = mode;
      const e = await assertProjectAccessSameOrg({ orgId: ORG, projectAccess: { mode: "selected", projectIds: [P1] }, audit: { path: "t" } })
        .then(() => null, (x: unknown) => x);
      expect(e instanceof ProjectAccessOrgError).toBe(true);
      expect((e as InstanceType<typeof ProjectAccessOrgError>).code).toBe("project_access_unverified");
      expect(projectAccessRefusalStatus(e as InstanceType<typeof ProjectAccessOrgError>)).toBe(503);
      expect(audits).toHaveLength(1);
    });
  }
  test("no org → every id is outside (fail closed), no query", async () => {
    expect(await findProjectIdsOutsideOrg("", [P1])).toEqual({ ok: true, outside: [P1] });
    expect(calls).toHaveLength(0);
  });
});

// 木村 2026-10-09 #296 follow-ups (2) empty orgId and (1) information_assets.project_id.
describe("empty orgId → refused up front (no lookup, no audit with an empty org)", () => {
  for (const orgId of ["", "   "]) {
    test(`orgId ${JSON.stringify(orgId)}: project_access_org_required`, async () => {
      const e = await assertProjectAccessSameOrg({ orgId, projectAccess: { mode: "selected", projectIds: [P1] }, audit: { path: "t" } })
        .then(() => null, (x: unknown) => x);
      expect(e instanceof ProjectAccessOrgError).toBe(true);
      expect((e as InstanceType<typeof ProjectAccessOrgError>).code).toBe("project_access_org_required");
      expect(calls).toHaveLength(0);
      expect(audits).toHaveLength(0);
    });
  }
  test("no project ids to check → still nothing to refuse (company / all)", async () => {
    await assertProjectAccessSameOrg({ orgId: "", projectAccess: { mode: "company", projectIds: [] }, audit: { path: "t" } });
    expect(audits).toHaveLength(0);
  });
});

describe("information_assets.project_id (production lookup)", () => {
  test("same-org project → ok, one org-scoped query, no audit", async () => {
    const pa = await import("@/lib/employees/project-access-org");
    await pa.assertAssetProjectSameOrg({ orgId: ORG, projectId: P1, audit: { path: "t" } });
    expect(calls[0].eq).toEqual([["org_id", ORG]]);
    expect(audits).toHaveLength(0);
  });
  test("another org's / unknown → project_access_cross_org, one IDs-only audit row", async () => {
    const pa = await import("@/lib/employees/project-access-org");
    const e = await pa.assertAssetProjectSameOrg({ orgId: ORG, projectId: P2, audit: { path: "t" } }).then(() => null, (x: unknown) => x);
    expect((e as { code?: string }).code).toBe("project_access_cross_org");
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("information_asset.project_refused");
    expect((audits[0].metadata as Record<string, unknown>).refusedProjectIds).toEqual([P2]);
  });
  test("lookup error → project_access_unverified (503)", async () => {
    const pa = await import("@/lib/employees/project-access-org");
    failWith = "error";
    const e = await pa.assertAssetProjectSameOrg({ orgId: ORG, projectId: P1, audit: { path: "t" } }).then(() => null, (x: unknown) => x);
    expect((e as { code?: string }).code).toBe("project_access_unverified");
    expect(pa.projectAccessRefusalStatus(e as InstanceType<typeof ProjectAccessOrgError>)).toBe(503);
  });
  test("null / empty projectId → nothing to check; empty orgId with an id → org_required, no query", async () => {
    const pa = await import("@/lib/employees/project-access-org");
    await pa.assertAssetProjectSameOrg({ orgId: ORG, projectId: null, audit: { path: "t" } });
    expect(calls).toHaveLength(0);
    const e = await pa.assertAssetProjectSameOrg({ orgId: "", projectId: P1, audit: { path: "t" } }).then(() => null, (x: unknown) => x);
    expect((e as { code?: string }).code).toBe("project_access_org_required");
    expect(calls).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});
