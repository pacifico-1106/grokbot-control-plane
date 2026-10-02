import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";
import { DEMO_ORG } from "@/lib/demo-data";

const ORG = DEMO_ORG.id;
const owner: OrgMember = {
  id: "mem_cs_owner",
  orgId: ORG,
  email: "owner@example.com",
  displayName: "Owner",
  role: "owner",
  status: "active",
} as OrgMember;
let session: SessionContext = { demo: false, userId: "u1", email: owner.email, orgId: ORG, member: owner };
mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));

const { GET, PATCH, POST } = await import("./route");
const { __resetChannelScopeDemoStore, getOrgChannelScopePolicyRaw } = await import("@/lib/channel-scope/data");
const { getApprovalById, listAuditEvents } = await import("@/lib/data");

const saved = { a: process.env.P1_CHANNEL_SCOPE_ENABLED, b: process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED };
const url = "http://localhost/api/channel-scope";
const patchReq = (body: unknown) =>
  new Request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  __resetChannelScopeDemoStore();
  session = { demo: false, userId: "u1", email: owner.email, orgId: ORG, member: owner };
  delete process.env.P1_CHANNEL_SCOPE_ENABLED;
  delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED;
});
afterEach(() => {
  if (saved.a === undefined) delete process.env.P1_CHANNEL_SCOPE_ENABLED; else process.env.P1_CHANNEL_SCOPE_ENABLED = saved.a;
  if (saved.b === undefined) delete process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED; else process.env.P1_CHANNEL_SCOPE_CONNECT_ENABLED = saved.b;
});

describe("/api/channel-scope auth", () => {
  test("401 without org session; 403 for member role / inactive / other org", async () => {
    session = { demo: false, userId: null, email: null, orgId: null, member: null };
    expect((await GET(new Request(url))).status).toBe(401);
    expect((await PATCH(patchReq({ mode: "all_joined" }))).status).toBe(401);
    for (const member of [
      { ...owner, role: "member" },
      { ...owner, status: "suspended" },
      { ...owner, orgId: "org_other" },
    ] as OrgMember[]) {
      session = { demo: false, userId: "u1", email: owner.email, orgId: ORG, member };
      expect((await GET(new Request(url))).status).toBe(403);
      expect((await PATCH(patchReq({ mode: "all_joined" }))).status).toBe(403);
    }
  });
});

describe("/api/channel-scope flag OFF", () => {
  test("GET reports disabled; PATCH is 403 feature_disabled", async () => {
    const res = await GET(new Request(url));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, enabled: false });
    const p = await PATCH(patchReq({ mode: "all_joined" }));
    expect(p.status).toBe(403);
    expect(await p.json()).toMatchObject({ ok: false, error: "feature_disabled" });
  });
});

describe("/api/channel-scope flag ON", () => {
  beforeEach(() => {
    process.env.P1_CHANNEL_SCOPE_ENABLED = "1";
  });

  test("PATCH files an always_human ticket and never writes the policy", async () => {
    const get = await (await GET(new Request(url))).json();
    const res = await PATCH(patchReq({ mode: "all_joined", beforeStateHash: get.beforeStateHash }));
    expect(res.status).toBe(200); // same as /api/approval-routes
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, code: "needs_approval", always_human: true });
    expect(String(body.pollPath)).toContain(body.approvalId);
    expect(body.diffSummary.join("\n")).toContain("参加中すべて");
    expect(await getOrgChannelScopePolicyRaw(ORG)).toBeNull();
    const approval = await getApprovalById(body.approvalId, ORG);
    expect(approval?.metadata).toMatchObject({ adminTool: "channelScope.patch", source: "web_api", actorMemberId: owner.id });
    expect(approval?.metadata?.isAdminMcpTool).toBe(true);
  });

  test("POST is an alias of PATCH", async () => {
    expect(POST).toBe(PATCH);
  });

  test("409 on stale beforeStateHash (with conflict audit)", async () => {
    const res = await PATCH(patchReq({ mode: "all_joined", beforeStateHash: "cs1:stale" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "before_state_mismatch" });
    const audits = await listAuditEvents(ORG, 20);
    expect(audits.some((e) => e.action === "channel_scope.patch_conflict")).toBe(true);
  });

  test("400 on invalid body / client-supplied approvalId; 403 connect_disabled", async () => {
    expect((await PATCH(patchReq({ mode: "bogus" }))).status).toBe(400);
    expect((await PATCH(patchReq({ mode: "all_joined", approvalId: "apr_x" }))).status).toBe(400);
    expect((await PATCH(new Request(url, { method: "PATCH", body: "{not json" }))).status).toBe(400);
    const connect = await PATCH(patchReq({ mode: "all_joined", includeSlackConnect: true }));
    expect(connect.status).toBe(403);
    expect(await connect.json()).toMatchObject({ error: "connect_disabled" });
  });

  test("GET 404 for unknown employee", async () => {
    expect((await GET(new Request(`${url}?employeeId=emp_nope`))).status).toBe(404);
  });
});
