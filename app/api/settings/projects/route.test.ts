/**
 * PR-SEC2 (directory audit): /api/settings/projects writes are already scoped
 * by the session org in the data layer. Pin it: another org's project id is a
 * 404 on PUT (same answer as an unknown id) and a no-op on DELETE; the other
 * org's project is never changed.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

const ORG = "org_demo";
const OTHER_ORG = "org_projects_other";
const admin = (orgId: string): SessionContext => ({
  demo: false,
  userId: `user-${orgId}`,
  email: "admin@example.com",
  orgId,
  member: { id: `mem-${orgId}`, orgId, email: "admin@example.com", displayName: "admin", role: "admin", status: "active", capabilities: ["view_dashboard"] } as OrgMember,
});
let session = admin(ORG);
const realSession = await import("@/lib/auth/session");
mock.module("@/lib/auth/session", () => ({
  ...realSession,
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));

const { PUT, DELETE } = await import("./route");
const { getOrgProject, upsertOrgProject } = await import("@/lib/data/projects");

let foreignId = "";
beforeEach(async () => {
  session = admin(ORG);
  foreignId = (await upsertOrgProject({ orgId: OTHER_ORG, name: `他社案件-${Math.random()}` })).id;
});

describe("/api/settings/projects BOLA", () => {
  test("PUT with another org's project id → 404 project_not_found; foreign project unchanged", async () => {
    const before = await getOrgProject(OTHER_ORG, foreignId);
    const res = await PUT(
      new Request("https://staffpass.test/api/settings/projects", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: foreignId, name: "乗っ取り" }),
      })
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("project_not_found");
    expect((await getOrgProject(OTHER_ORG, foreignId))?.name).toBe(before?.name);
  });

  test("DELETE with another org's project id → nothing deleted", async () => {
    const res = await DELETE(new Request(`https://staffpass.test/api/settings/projects?id=${encodeURIComponent(foreignId)}`, { method: "DELETE" }));
    expect((await res.json()).ok).toBe(false);
    expect(await getOrgProject(OTHER_ORG, foreignId)).not.toBeNull();
  });
});
