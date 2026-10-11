/**
 * POST /api/employees/[id]/rotate with reissueApprovalId (ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED):
 * the hand-over for an approved admin MCP reissue ticket. Same gate as rotate
 * (credential admin + approver authority); the redeem itself is
 * lib/employees/credential-reissue (tested there). Without reissueApprovalId the
 * route is unchanged (route.test.ts).
 */
import { beforeEach, expect, mock, test } from "bun:test";
import type { OrgMember } from "@/lib/types";

const actor = { id: "mem_owner", orgId: "org_a", email: "owner@example.com", role: "owner", capabilities: ["hire_issue_credentials"], status: "active" } as unknown as OrgMember;
let redeemCalls: Array<Record<string, unknown>> = [];
let rotateCalls = 0;
let redeemResult: Record<string, unknown> = { ok: true, secret: { raw: "gb_emp_new_secret_value", prefix: "gb_emp_new_sec", fingerprint: "f".repeat(64) }, generation: 3, binding: { employeeId: "emp_1" } };

mock.module("@/lib/auth/session", () => ({ getSessionContext: async () => ({ orgId: "org_a" }), getCurrentOrgId: async () => "org_a" }));
mock.module("@/lib/auth/require-credential-admin", () => ({ requireCredentialAdmin: async () => ({ ok: true, actor }) }));
mock.module("@/lib/approver-authority/web-direct", () => ({
  assertWebActorApproverAuthority: async () => ({ ok: true, requirement: null }),
  webDirectDeniedBody: () => ({}),
  webSessionActorMemberId: async () => null,
}));
mock.module("@/lib/data", () => ({
  getEmployee: async (id: string, orgId: string) => (id === "emp_1" && orgId === "org_a" ? { id: "emp_1", orgId: "org_a", displayName: "x", credentialId: "cred_old", scopes: [], allowedPurposes: [], approvalPolicy: "risk_based", actionLimits: {}, spend: null, allowedAccounts: [] } : null),
  rotateCredential: async () => {
    rotateCalls++;
    return { binding: { employeeId: "emp_1" }, generation: 2 };
  },
  appendAuditEvent: async () => undefined,
  bindingPublicView: (b: unknown) => b,
  runtimeModeLabel: () => "production",
}));
mock.module("@/lib/employees/credential-reissue", () => ({
  redeemCredentialReissue: async (input: Record<string, unknown>) => {
    redeemCalls.push(input);
    return redeemResult;
  },
}));
const { POST } = await import("./route");
const call = (body: Record<string, unknown>) =>
  POST(new Request("https://staffpass.test/api/employees/emp_1/rotate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "emp_1" }) });

beforeEach(() => {
  redeemCalls = [];
  rotateCalls = 0;
  delete process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED;
});

test("flag OFF: reissueApprovalId refused (feature_disabled), nothing rotated", async () => {
  const res = await call({ reissueApprovalId: "apr_1" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toBe("feature_disabled");
  expect(redeemCalls).toHaveLength(0);
  expect(rotateCalls).toBe(0);
});

test("flag ON: redeems with the session org + path employee + gate actor; one-time secret to the browser", async () => {
  process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED = "1";
  const res = await call({ reissueApprovalId: "apr_1" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(redeemCalls[0]).toMatchObject({ orgId: "org_a", employeeId: "emp_1", approvalId: "apr_1", actor: { memberId: "mem_owner", email: "owner@example.com" } });
  expect(body.credential.oneTimeSecret).toBe("gb_emp_new_secret_value");
  expect(body.reissueApprovalId).toBe("apr_1");
  expect(rotateCalls).toBe(0); // the redeem does the rotation itself
});

test("flag ON: a refused redeem maps to 4xx with the code, no secret", async () => {
  process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED = "1";
  redeemResult = { ok: false, code: "reissue_approval_used", messageJa: "使用済み" };
  const res = await call({ reissueApprovalId: "apr_1" });
  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.error).toBe("reissue_approval_used");
  expect(JSON.stringify(body)).not.toContain("gb_emp_");
});
