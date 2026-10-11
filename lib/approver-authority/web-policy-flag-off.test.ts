/**
 * 木村 2026-10-10 (condition 1 for the Web PATCH change): with
 * APPROVER_AUTHORITY_ENABLED OFF, PATCH /api/employees/[id]/policy behaves
 * exactly as before PR-D — the approver-authority gate is never consulted,
 * a plain admin (not designated) saves every field it could save before, and
 * the only refusal is the pre-existing dashboard lock (scopes / purposes /
 * actionLimits → admin_mcp_required). With the flag ON, the accepted rule:
 * money keys need an owner; non-money keys only can be saved by a designated admin.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, getRuntimeEmployees, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { Employee, OrgMember } from "@/lib/types";

let gateCalls = 0;
const realWebDirect = { ...(await import("@/lib/approver-authority/web-direct")) };
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/approver-authority/web-direct", {
  assertWebActorApproverAuthority: (...args: unknown[]) => {
    gateCalls += 1;
    return (realWebDirect.assertWebActorApproverAuthority as (...a: unknown[]) => unknown)(...args);
  },
});

const { PATCH: patchPolicy } = await import("@/app/api/employees/[id]/policy/route");
const { getEmployee } = await import("@/lib/data");
const { writeDesignatedAdminMemberIds, resetDemoDesignatedAdminsForTests } = await import("@/lib/approver-authority/designated-admins");
const { DASHBOARD_POLICY_LOCKED } = await import("@/lib/dashboard/policy-lock");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const DADMIN = "mem_wpo_designated";
const ADMIN = "mem_wpo_plain_admin";
const EMP = "emp_sales";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
const caps = ["view_dashboard", "view_employees", "hire_issue_credentials", "manage_team"] as OrgMember["capabilities"];
let savedFlag: string | undefined;
let savedEmployee: Employee;

beforeEach(async () => {
  savedFlag = process.env[FLAG];
  delete process.env[FLAG];
  gateCalls = 0;
  resetRuntimeMembers();
  for (const id of [DADMIN, ADMIN]) {
    upsertRuntimeMember({ id, orgId: ORG, email: `${id}@fixture.invalid`, displayName: id, role: "admin", status: "active", capabilities: caps }, { audit: false });
  }
  resetDemoDesignatedAdminsForTests();
  await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
  savedEmployee = structuredClone(getRuntimeEmployees().find((e) => e.id === EMP)!) as Employee;
});
afterEach(() => {
  const emp = getRuntimeEmployees().find((e) => e.id === EMP)!;
  for (const key of Object.keys(emp)) delete (emp as unknown as Record<string, unknown>)[key];
  Object.assign(emp, structuredClone(savedEmployee));
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
  resetDemoDesignatedAdminsForTests();
});

async function policyPatch(actor: string, change: Record<string, unknown>) {
  const existing = (await getEmployee(EMP, ORG))!;
  const body = {
    scopes: existing.scopes, allowedPurposes: existing.allowedPurposes, approvalPolicy: existing.approvalPolicy,
    actionLimits: existing.actionLimits, actorMemberId: actor, sodOverrideAcknowledged: true, ...change,
  };
  const res = await patchPolicy(new Request(`http://localhost/api/employees/${EMP}/policy`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: EMP }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const flipped = (v: string | undefined) => (v === "deny" ? "always_human" : "deny");

describe("flag OFF: the Web policy PATCH is exactly today's", () => {
  test("a plain (not designated) admin saves approvalPolicy, money and non-money toolApprovalDefaults, spend and the approver inbox; the gate is never called", async () => {
    const before = (await getEmployee(EMP, ORG))!;
    const nextPolicy = before.approvalPolicy === "always_human" ? "risk_based" : "always_human";
    const r1 = await policyPatch(ADMIN, { approvalPolicy: nextPolicy });
    expect(r1.status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.approvalPolicy).toBe(nextPolicy);

    const money = { ...before.toolApprovalDefaults, "commerce.order": flipped(before.toolApprovalDefaults?.["commerce.order"]) };
    const r2 = await policyPatch(ADMIN, { toolApprovalDefaults: money });
    expect(r2.status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.toolApprovalDefaults?.["commerce.order"]).toBe(money["commerce.order"]);

    const nonMoney = { ...(await getEmployee(EMP, ORG))!.toolApprovalDefaults, "mail.send": flipped(before.toolApprovalDefaults?.["mail.send"]) };
    expect((await policyPatch(ADMIN, { toolApprovalDefaults: nonMoney })).status).toBe(200);

    const r4 = await policyPatch(ADMIN, { spend: { maxPerOrderJpy: 12345 } });
    expect(r4.status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.spend?.maxPerOrderJpy).toBe(12345);

    expect((await policyPatch(ADMIN, { approverUserIds: ["U_WPO_NEW"] })).status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.approverUserIds).toEqual(["U_WPO_NEW"]);

    expect(gateCalls).toBe(0);
  });

  test("the only refusal is the pre-existing dashboard lock (actionLimits / scopes); same code as before PR-D", async () => {
    const r = await policyPatch(ADMIN, { actionLimits: {} });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(DASHBOARD_POLICY_LOCKED);
    expect(gateCalls).toBe(0);
  });
});

describe("flag ON (accepted rule): money keys → owner; non-money keys only → a designated admin may save", () => {
  test("non-money toolApprovalDefaults key: designated admin saves, plain admin refused", async () => {
    process.env[FLAG] = "true";
    const before = (await getEmployee(EMP, ORG))!;
    const nonMoney = { ...before.toolApprovalDefaults, "mail.send": flipped(before.toolApprovalDefaults?.["mail.send"]) };
    expect((await policyPatch(ADMIN, { toolApprovalDefaults: nonMoney })).body.reason).toBe("approver_not_authorized");
    const ok = await policyPatch(DADMIN, { toolApprovalDefaults: nonMoney });
    expect(ok.status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.toolApprovalDefaults?.["mail.send"]).toBe(nonMoney["mail.send"]);
  });

  test("money key (commerce.order): designated admin → owner_approval_required (nothing saved); owner saves", async () => {
    process.env[FLAG] = "true";
    const before = (await getEmployee(EMP, ORG))!;
    const money = { ...before.toolApprovalDefaults, "commerce.order": flipped(before.toolApprovalDefaults?.["commerce.order"]) };
    const d = await policyPatch(DADMIN, { toolApprovalDefaults: money });
    expect(d.status).toBe(403);
    expect(d.body.reason).toBe("owner_approval_required");
    expect((await getEmployee(EMP, ORG))!.toolApprovalDefaults?.["commerce.order"]).toBe(before.toolApprovalDefaults?.["commerce.order"]);
    expect((await policyPatch(OWNER, { toolApprovalDefaults: money })).status).toBe(200);
    expect((await getEmployee(EMP, ORG))!.toolApprovalDefaults?.["commerce.order"]).toBe(money["commerce.order"]);
  });
});
