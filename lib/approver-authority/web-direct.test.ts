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
    const res = await policyPatch(OWNER, { approvalPolicy: "always_human" }, "emp_not_in_this_org");
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
