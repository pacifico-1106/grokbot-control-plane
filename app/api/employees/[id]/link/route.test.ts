/**
 * POST /api/employees/[id]/link re-points an employee's binding at a Grok Bot
 * agent (employee_bindings.grok_bot_agent_id) → org owner/admin only,
 * enforced server-side (木村 review, PR #259). GET (read) stays member-level.
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
let links: Array<{ id: string; orgId: string; agent: string }> = [];
const binding = { employeeId: "emp-1", orgId: "org-a", status: "linked", grokBotAgentId: "agent-x" };

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => session,
  getCurrentOrgId: async () => session.orgId,
}));
mock.module("@/lib/data", () => ({
  getEmployee: async (id: string, orgId: string | null) => (id === "emp-1" && orgId === "org-a" ? { id, orgId } : null),
  getBinding: async () => binding,
  linkAgent: async (id: string, input: { orgId: string; grokBotAgentId: string }) => {
    links.push({ id, orgId: input.orgId, agent: input.grokBotAgentId });
    return { ...binding, grokBotAgentId: input.grokBotAgentId };
  },
  bindingPublicView: (b: unknown) => b,
  runtimeModeLabel: () => "production",
}));
const { GET, POST } = await import("./route");

const ctx = { params: Promise.resolve({ id: "emp-1" }) };
const post = () =>
  POST(
    new Request("http://localhost/api/employees/emp-1/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grokBotAgentId: "attacker-agent" }),
    }),
    ctx
  );
const as = (role: OrgMember["role"] | null) => {
  session = role
    ? { demo: false, userId: `u-${role}`, email: `${role}@example.com`, orgId: "org-a", member: member(role) }
    : { demo: false, userId: null, email: null, orgId: null, member: null };
};

beforeEach(() => {
  links = [];
});

test("member session is rejected (403 admin_required) and the binding is not re-linked", async () => {
  as("member");
  const res = await post();
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("admin_required");
  expect(links).toEqual([]);
});

test("unauthenticated request is rejected (401) without a write", async () => {
  as(null);
  const res = await post();
  expect(res.status).toBe(401);
  expect(links).toEqual([]);
});

test("org admin and owner can link an agent for an employee of their own org", async () => {
  for (const role of ["admin", "owner"] as const) {
    as(role);
    const res = await post();
    expect(res.status).toBe(200);
  }
  expect(links).toEqual([
    { id: "emp-1", orgId: "org-a", agent: "attacker-agent" },
    { id: "emp-1", orgId: "org-a", agent: "attacker-agent" },
  ]);
});

test("GET (read binding) stays available to members", async () => {
  as("member");
  const res = await GET(new Request("http://localhost/api/employees/emp-1/link"), ctx);
  expect(res.status).toBe(200);
});
