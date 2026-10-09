/**
 * PR-D gap closure (2026-10-09): the dashboard can change approvers and
 * permissions directly (no ticket). With APPROVER_AUTHORITY_ENABLED the person
 * saving must be someone who could have approved that change:
 *   - approval inbox (notification channels: destination / allowedUserIds) → owner or designated admin
 *   - employee policy: approvalPolicy / toolApprovalDefaults / approver inbox → owner or designated admin,
 *     money-related (spend, money scope holder's approval weakened) → owner
 * Flag OFF: unchanged. Unrelated edits (display name) are not gated.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { OrgMember } from "@/lib/types";

const { PUT: putChannels } = await import("@/app/api/settings/notification-channels/route");
const { PATCH: patchPolicy } = await import("@/app/api/employees/[id]/policy/route");
const { getEmployee } = await import("@/lib/data");
const { writeDesignatedAdminMemberIds, resetDemoDesignatedAdminsForTests } = await import("@/lib/approver-authority/designated-admins");
const { assertWebActorApproverAuthority } = await import("@/lib/approver-authority/web-direct");
const { POST: issuePost } = await import("@/app/api/employees/issue/route");
const { PUT: putSodPolicy } = await import("@/app/api/settings/sod-warn-policy/route");
const { PUT: putAdapters } = await import("@/app/api/settings/conversation-adapters/route");
const { PATCH: patchBinding } = await import("@/app/api/employees/[id]/binding/route");
const { POST: rotatePost } = await import("@/app/api/employees/[id]/rotate/route");
const { POST: terminatePost } = await import("@/app/api/employees/[id]/terminate/route");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const DADMIN = "mem_wd_designated";
const ADMIN = "mem_wd_plain_admin";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
let saved: string | undefined;
const caps = ["view_dashboard", "view_employees", "hire_issue_credentials", "manage_team"] as OrgMember["capabilities"];

beforeEach(async () => {
  saved = process.env[FLAG];
  process.env[FLAG] = "true";
  resetRuntimeMembers();
  for (const id of [DADMIN, ADMIN]) {
    upsertRuntimeMember({ id, orgId: ORG, email: `${id}@fixture.invalid`, displayName: id, role: "admin", status: "active", capabilities: caps }, { audit: false });
  }
  resetDemoDesignatedAdminsForTests();
  await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
});
afterEach(() => {
  DEMO_ORG.sodWarnPolicy = { domains: ["comm_external", "money", "destructive", "commit"] };
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  resetRuntimeMembers();
  resetDemoDesignatedAdminsForTests();
});

const channelsPut = (actor: string) =>
  putChannels(new Request("http://localhost/api/settings/notification-channels", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-member-id": actor },
    body: JSON.stringify({ provider: "line", enabled: true, isDefault: false, label: "wd", destinationId: "C_WD", allowedUserIds: ["U_WD"], channelAccessToken: "line-fixture-not-real", channelSecret: "line-secret-fixture" }),
  }));

async function policyPatch(actor: string, change: Record<string, unknown>, employeeId = "emp_sales") {
  const existing = (await getEmployee(employeeId, ORG))!;
  const body = {
    scopes: existing.scopes, allowedPurposes: existing.allowedPurposes, approvalPolicy: existing.approvalPolicy,
    actionLimits: existing.actionLimits, actorMemberId: actor, sodOverrideAcknowledged: true, ...change,
  };
  return patchPolicy(new Request(`http://localhost/api/employees/${employeeId}/policy`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: employeeId }) });
}
const denied = async (res: Response) => (res.status === 403 ? ((await res.json()) as Record<string, unknown>) : null);

describe("approval inbox settings (notification channels PUT)", () => {
  test("plain admin refused; designated admin and owner pass the gate", async () => {
    const d = await denied(await channelsPut(ADMIN));
    expect(d?.error).toBe("approver_authority_denied");
    expect(d?.reason).toBe("approver_not_authorized");
    expect(typeof d?.nextStepJa).toBe("string");
    expect((await denied(await channelsPut(DADMIN)))?.error).not.toBe("approver_authority_denied");
    expect((await denied(await channelsPut(OWNER)))?.error).not.toBe("approver_authority_denied");
  });

  test("flag OFF: plain admin unchanged", async () => {
    delete process.env[FLAG];
    expect((await denied(await channelsPut(ADMIN)))?.error).not.toBe("approver_authority_denied");
  });
});

describe("employee policy PATCH", () => {
  test("approval policy change: plain admin refused, designated admin allowed", async () => {
    const existing = (await getEmployee("emp_sales", ORG))!;
    const next = existing.approvalPolicy === "always_human" ? "risk_based" : "always_human";
    const d = await denied(await policyPatch(ADMIN, { approvalPolicy: next }));
    expect(d?.reason).toBe("approver_not_authorized");
    const ok = await policyPatch(DADMIN, { approvalPolicy: "always_human" });
    expect((await denied(ok))?.error).not.toBe("approver_authority_denied");
  });

  test("spend limits are owner-only: designated admin → owner_approval_required; owner passes", async () => {
    const d = await denied(await policyPatch(DADMIN, { spend: { monthlyLimitJpy: 12345 } }));
    expect(d?.reason).toBe("owner_approval_required");
    expect((await denied(await policyPatch(OWNER, { spend: { monthlyLimitJpy: 12345 } })))?.error).not.toBe("approver_authority_denied");
  });

  test("approver inbox of the employee: plain admin refused", async () => {
    expect((await denied(await policyPatch(ADMIN, { approverUserIds: ["U_NEW_APPROVER"] })))?.reason).toBe("approver_not_authorized");
  });

  test("display-name-only edit is not gated; flag OFF unchanged", async () => {
    expect((await denied(await policyPatch(ADMIN, { displayName: "営業AI 2" })))?.error).not.toBe("approver_authority_denied");
    delete process.env[FLAG];
    expect((await denied(await policyPatch(ADMIN, { spend: { monthlyLimitJpy: 1 } })))?.error).not.toBe("approver_authority_denied");
  });

  test("BOLA: another org's employee id → 404 before any authority decision", async () => {
    const res = await patchPolicy(new Request("http://localhost/api/employees/emp_not_in_this_org/policy", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["slack:post"], allowedPurposes: [], approvalPolicy: "always_human", actorMemberId: OWNER }),
    }), { params: Promise.resolve({ id: "emp_not_in_this_org" }) });
    expect(res.status).toBe(404);
  });
});

describe("helper", () => {
  test("no member id → fail closed; non-target change → ok", async () => {
    const r = await assertWebActorApproverAuthority({ orgId: ORG, memberId: null, changes: [{ tool: "setup.slackApprover.set", adminMutation: {} }] });
    expect(r.ok).toBe(false);
    expect((await assertWebActorApproverAuthority({ orgId: ORG, memberId: null, changes: [] })).ok).toBe(true);
    expect((await assertWebActorApproverAuthority({ orgId: ORG, memberId: ADMIN, changes: [{ tool: "mail.send", adminMutation: {} }] })).ok).toBe(true);
  });
});

// 木村 2026-10-09 review #279 items 1–2: the rest of the dashboard writes that change
// permissions / approvers / where notices go. terminate stays owner/admin (emergency stop).
const json = (url: string, method: string, actor: string, body: Record<string, unknown>) =>
  new Request(url, { method, headers: { "content-type": "application/json", "x-member-id": actor }, body: JSON.stringify({ actorMemberId: actor, ...body }) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const surfaces: Array<{ name: string; call: (actor: string) => Promise<Response> }> = [
  { name: "POST /api/employees/issue", call: (a) => issuePost(json("http://localhost/api/employees/issue", "POST", a, { displayName: "wd発行", roleLabel: "テスト", scopes: ["mail:draft"] })) },
  { name: "PUT /api/settings/sod-warn-policy", call: (a) => putSodPolicy(json("http://localhost/api/settings/sod-warn-policy", "PUT", a, { domains: ["money"] })) },
  { name: "PUT /api/settings/conversation-adapters", call: (a) => putAdapters(json("http://localhost/api/settings/conversation-adapters", "PUT", a, { surface: "slack", enabled: false, label: "wd" })) },
  { name: "PATCH /api/employees/[id]/binding", call: (a) => patchBinding(json("http://localhost/api/employees/emp_sales/binding", "PATCH", a, { wakeWebhookUrl: "https://wake.example.com/hook" }), params("emp_sales")) },
  { name: "POST /api/employees/[id]/rotate", call: (a) => rotatePost(json("http://localhost/api/employees/emp_ops/rotate", "POST", a, {}), params("emp_ops")) },
];

describe("dashboard writes (review items 1–2)", () => {
  for (const s of surfaces) {
    test(`${s.name}: plain admin refused; designated admin and owner pass the gate; flag OFF unchanged`, async () => {
      const d = await denied(await s.call(ADMIN));
      expect(d?.error).toBe("approver_authority_denied");
      expect(d?.reason).toBe("approver_not_authorized");
      expect((await denied(await s.call(DADMIN)))?.error).not.toBe("approver_authority_denied");
      expect((await denied(await s.call(OWNER)))?.error).not.toBe("approver_authority_denied");
      delete process.env[FLAG];
      expect((await denied(await s.call(ADMIN)))?.error).not.toBe("approver_authority_denied");
    });
  }

  test("POST /api/employees/issue: same content rule as MCP employees.issue — money scope → owner only", async () => {
    const call = (a: string) => issuePost(json("http://localhost/api/employees/issue", "POST", a, {
      displayName: "wd発注", roleLabel: "テスト", scopes: ["commerce:order"], spend: { monthlyLimitJpy: 1000 }, sodOverrideAcknowledged: true,
    }));
    expect((await denied(await call(DADMIN)))?.reason).toBe("owner_approval_required");
    expect((await denied(await call(OWNER)))?.error).not.toBe("approver_authority_denied");
  });

  test("terminate stays owner/admin (emergency stop): a plain admin is not refused by this guard", async () => {
    const res = await terminatePost(json("http://localhost/api/employees/emp_comm/terminate", "POST", ADMIN, {}), params("emp_comm"));
    expect((await denied(res))?.error).not.toBe("approver_authority_denied");
  });
});
