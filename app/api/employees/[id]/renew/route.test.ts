/**
 * Fail-first: POST /api/employees/[id]/renew (今すぐ更新).
 * Flag OFF / other org → 404. No secret in the body.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { OrgMember } from "@/lib/types";

const actor = {
  id: "mem_owner",
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  email: "owner@example.com",
  role: "owner",
  capabilities: ["hire_issue_credentials"],
  status: "active",
} as unknown as OrgMember;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
let proposeCalls: Array<Record<string, unknown>> = [];
let authCalls = 0;
let adminOk = true;
let proposeResult: Record<string, unknown> = {
  ok: true,
  approvalId: "apr_renew_1",
  nextStepJa: "承認者の Slack に「更新しますか」を送りました。鍵はこの画面には出ません。",
};

mock.module("@/lib/auth/session", () => ({
  getSessionContext: async () => ({ orgId: ORG }),
  getCurrentOrgId: async () => ORG,
}));
mock.module("@/lib/auth/require-credential-admin", () => ({
  requireCredentialAdmin: async () => {
    authCalls += 1;
    if (!adminOk) {
      return {
        ok: false,
        response: new Response(JSON.stringify({ error: "auth_required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      };
    }
    return { ok: true, actor };
  },
}));
mock.module("@/lib/approver-authority/web-direct", () => ({
  assertWebActorApproverAuthority: async () => ({ ok: true, requirement: null }),
  webDirectDeniedBody: () => ({}),
}));
mock.module("@/lib/data", () => ({
  getEmployee: async (id: string, orgId: string) =>
    id === "emp_1" && orgId === ORG
      ? { id: "emp_1", orgId: ORG, displayName: "x", credentialId: "cred_old", credentialExpiresAt: null, status: "active" }
      : null,
}));
mock.module("@/lib/employees/credential-auto-renew", () => ({
  isCredentialAutoRenewEnabled: () => process.env.CREDENTIAL_AUTO_RENEW_ENABLED === "1",
  isCredentialAutoRenewOnForOrg: (orgId: string) => orgId === ORG && process.env.CREDENTIAL_AUTO_RENEW_ENABLED === "1",
  proposeCredentialAutoRenewNow: async (input: Record<string, unknown>) => {
    proposeCalls.push(input);
    return proposeResult;
  },
}));

const { POST } = await import("./route");
const call = (id = "emp_1", body: Record<string, unknown> = { reason: "now" }) =>
  POST(
    new Request(`https://staffpass.test/api/employees/${id}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );

beforeEach(() => {
  proposeCalls = [];
  authCalls = 0;
  adminOk = true;
  proposeResult = {
    ok: true,
    approvalId: "apr_renew_1",
    nextStepJa: "承認者の Slack に「更新しますか」を送りました。鍵はこの画面には出ません。",
  };
  delete process.env.CREDENTIAL_AUTO_RENEW_ENABLED;
});

test("flag OFF: 404, no ticket, no secret", async () => {
  const res = await call();
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("feature_disabled");
  expect(proposeCalls).toHaveLength(0);
  expect(JSON.stringify(body)).not.toMatch(/gb_emp_|claim_token|oneTimeSecret/);
});

test("L-A: flag OFF + unauthenticated → 404 (not 401); auth is not consulted", async () => {
  adminOk = false;
  const res = await call();
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error).toBe("feature_disabled");
  expect(authCalls).toBe(0);
  expect(proposeCalls).toHaveLength(0);
});

test("flag ON + unauthenticated → 401 after the global flag check", async () => {
  process.env.CREDENTIAL_AUTO_RENEW_ENABLED = "1";
  adminOk = false;
  const res = await call();
  expect(res.status).toBe(401);
  expect(authCalls).toBe(1);
  expect(proposeCalls).toHaveLength(0);
});

test("flag ON: files now-ticket with session org + path employee; no secret", async () => {
  process.env.CREDENTIAL_AUTO_RENEW_ENABLED = "1";
  const res = await call();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(proposeCalls[0]).toMatchObject({
    orgId: ORG,
    employeeId: "emp_1",
    source: "web",
    actor: { memberId: "mem_owner", email: "owner@example.com" },
  });
  expect(body.ok).toBe(true);
  expect(body.approvalId).toBe("apr_renew_1");
  expect(body.nextStepJa).toContain("Slack");
  expect(JSON.stringify(body)).not.toMatch(/gb_emp_|claim_token|oneTimeSecret/);
});

test("flag ON: held / already_pending map to 4xx without secrets", async () => {
  process.env.CREDENTIAL_AUTO_RENEW_ENABLED = "1";
  proposeResult = { ok: false, code: "already_pending", messageJa: "進行中の更新があります" };
  const res = await call();
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("already_pending");
  expect(JSON.stringify(body)).not.toMatch(/gb_emp_|claim_token/);
});
