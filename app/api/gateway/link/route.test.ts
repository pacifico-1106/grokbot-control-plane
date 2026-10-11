/**
 * (d) POST /api/gateway/link changes tenant-level integration state
 * (orgs.gateway_status / gateway_links) → org owner/admin only, enforced
 * server-side. GET (read status) stays available to every member.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { SessionContext } from "@/lib/auth/session";
import type { OrgMember } from "@/lib/types";

const member = (role: OrgMember["role"]): OrgMember => ({
  id: `m-${role}`,
  orgId: "org-a",
  userId: `u-${role}`,
  email: `${role}@example.com`,
  displayName: role,
  role,
  status: "active",
});
let session: SessionContext = { demo: false, userId: null, email: null, orgId: null, member: null };
let writes: Array<{ status: string; orgId: string }> = [];

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/data", () => ({
  getGatewayStatusForOrg: async () => "disconnected",
  setGatewayStatusForOrg: async (status: string, orgId: string) => {
    writes.push({ status, orgId });
  },
  runtimeModeLabel: () => "production",
}));
const { GET, POST } = await import("./route");

const post = (action = "connect") =>
  POST(
    new Request("http://localhost/api/gateway/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, mode: "managed" }),
    })
  );
const as = (role: OrgMember["role"] | null) => {
  session = role
    ? { demo: false, userId: `u-${role}`, email: `${role}@example.com`, orgId: "org-a", member: member(role) }
    : { demo: false, userId: null, email: null, orgId: null, member: null };
};

beforeEach(() => {
  writes = [];
});

test("member session is rejected (403 admin_required) and gateway status is not written", async () => {
  as("member");
  for (const action of ["connect", "handshake", "disconnect"]) {
    const res = await post(action);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("admin_required");
  }
  expect(writes).toEqual([]);
});

test("unauthenticated request is rejected (401) without a write", async () => {
  as(null);
  const res = await post("handshake");
  expect(res.status).toBe(401);
  expect(writes).toEqual([]);
});

test("org admin and owner can change the gateway status of their own org", async () => {
  for (const role of ["admin", "owner"] as const) {
    as(role);
    const res = await post("handshake");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("linked");
  }
  expect(writes).toEqual([
    { status: "linked", orgId: "org-a" },
    { status: "linked", orgId: "org-a" },
  ]);
});

test("GET (read status) stays available to members", async () => {
  as("member");
  const res = await GET();
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe("disconnected");
});
