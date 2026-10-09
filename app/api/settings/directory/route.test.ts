/**
 * PR-SEC2: PUT /api/settings/directory (record=asset) must not trust
 * body.projectId. A project that is not in the caller's org (another org's
 * project, or an unknown id) is 404 project_not_found — the same answer for
 * both, so the response does not confirm that another org's id exists — and
 * nothing is written. The org always comes from the session, never the body.
 *
 * Gate: owner/admin session (requireOrgAdminSession, unchanged). The data
 * layer runs in demo (in-memory) mode; the session is mocked to production
 * shape so 401 / 403 are the real production answers.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { HumanCapability, OrgMember } from "@/lib/types";

const ORG = "org_demo";
const OTHER_ORG = "org_directory_other";

function sessionFor(orgId: string, role: OrgMember["role"] | null, caps: HumanCapability[] = ["view_dashboard"]): SessionContext {
  if (!role) return { demo: false, userId: null, email: null, orgId: null, member: null };
  return {
    demo: false,
    userId: `user-${role}-${orgId}`,
    email: `${role}@example.com`,
    orgId,
    member: { id: `mem-${role}-${orgId}`, orgId, email: `${role}@example.com`, displayName: role, role, status: "active", capabilities: caps } as OrgMember,
  };
}

let session: SessionContext = sessionFor(ORG, "admin");
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));

const { PUT, GET } = await import("./route");
const { listInformationAssets, upsertInformationAsset } = await import("@/lib/data/directory");
const { DEMO_PROJECT_A_ID, ensureDefaultOrgProject } = await import("@/lib/data/projects");

let seq = 0;
const ref = () => `kb/sec2-${Date.now()}-${++seq}`;

function put(body: Record<string, unknown>) {
  return PUT(
    new Request("https://staffpass.test/api/settings/directory", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

let foreignProjectId = "";
beforeEach(async () => {
  session = sessionFor(ORG, "admin");
  foreignProjectId = (await ensureDefaultOrgProject(OTHER_ORG)).id;
});

describe("PUT /api/settings/directory record=asset projectId", () => {
  test("own org's project → 200, asset carries it", async () => {
    const r = ref();
    const res = await put({ record: "asset", ref: r, class: "internal", projectId: DEMO_PROJECT_A_ID });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.asset.projectId).toBe(DEMO_PROJECT_A_ID);
    expect(body.asset.orgId).toBe(ORG);
  });

  test("BOLA: another org's project → 404 project_not_found, nothing written", async () => {
    const r = ref();
    const res = await put({ record: "asset", ref: r, class: "internal", projectId: foreignProjectId });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("project_not_found");
    expect(body.retryable).toBe(false);
    expect(typeof body.nextStep).toBe("string");
    expect((await listInformationAssets(ORG)).some((a) => a.ref === r)).toBe(false);
  });

  test("BOLA: re-pointing an existing asset at another org's project → 404, asset unchanged", async () => {
    const r = ref();
    expect((await put({ record: "asset", ref: r, class: "internal", projectId: DEMO_PROJECT_A_ID })).status).toBe(200);
    const res = await put({ record: "asset", ref: r, class: "restricted", projectId: foreignProjectId });
    expect(res.status).toBe(404);
    const row = (await listInformationAssets(ORG)).find((a) => a.ref === r);
    expect(row?.projectId).toBe(DEMO_PROJECT_A_ID);
    expect(row?.class).toBe("internal");
  });

  test("unknown project id → the same 404 (no existence oracle)", async () => {
    const res = await put({ record: "asset", ref: ref(), projectId: "prj_does_not_exist" });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("project_not_found");
  });

  test("projectId null / omitted → 200 (org default project), unchanged", async () => {
    expect((await put({ record: "asset", ref: ref(), projectId: null })).status).toBe(200);
    expect((await put({ record: "asset", ref: ref() })).status).toBe(200);
  });

  test("body orgId is ignored: another org's admin writes only into their own org", async () => {
    session = sessionFor(OTHER_ORG, "admin");
    const r = ref();
    const res = await put({ record: "asset", ref: r, orgId: ORG, projectId: foreignProjectId });
    expect(res.status).toBe(200);
    expect((await res.json()).asset.orgId).toBe(OTHER_ORG);
    expect((await listInformationAssets(ORG)).some((a) => a.ref === r)).toBe(false);
    // …and cannot point at the demo org's project either.
    const cross = await put({ record: "asset", ref: ref(), projectId: DEMO_PROJECT_A_ID });
    expect(cross.status).toBe(404);
  });

  test("plain member → 403; unauthenticated → 401 (gate unchanged)", async () => {
    session = sessionFor(ORG, "member");
    expect((await put({ record: "asset", ref: ref(), projectId: DEMO_PROJECT_A_ID })).status).toBe(403);
    session = sessionFor(ORG, null);
    expect((await put({ record: "asset", ref: ref(), projectId: DEMO_PROJECT_A_ID })).status).toBe(401);
    expect((await GET()).status).toBe(401);
  });
});

describe("upsertInformationAsset (data layer) re-checks project ownership", () => {
  test("another org's project → throws project_not_found, nothing written", async () => {
    const r = ref();
    await expect(upsertInformationAsset({ orgId: ORG, ref: r, class: "internal", projectId: foreignProjectId })).rejects.toThrow(
      "project_not_found"
    );
    expect((await listInformationAssets(ORG)).some((a) => a.ref === r)).toBe(false);
  });

  test("own project / null → ok", async () => {
    expect((await upsertInformationAsset({ orgId: ORG, ref: ref(), class: "internal", projectId: DEMO_PROJECT_A_ID })).projectId).toBe(
      DEMO_PROJECT_A_ID
    );
    expect((await upsertInformationAsset({ orgId: ORG, ref: ref(), class: "internal", projectId: null })).projectId).toBeNull();
  });
});
