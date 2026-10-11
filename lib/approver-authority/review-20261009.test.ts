/**
 * 木村 2026-10-09 review of #279, items 4–6.
 *  4. A pending ticket for a target tool filed BEFORE the flag was ON has no
 *     approver class; after ON it is refused at execution and the reply says
 *     to file it again.
 *  5. F8: if only the final-approver record write fails, the ticket is
 *     approved-but-unrecorded and fulfil refuses it forever. Recovery: an owner
 *     of that org (dashboard) or the operator can revoke it.
 *  6. Board resolutions (decision.request — e.g. directors who are not owners)
 *     are NOT subject to this guard; only admin / permission tickets are.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG, getRuntimeAudit, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { ApprovalRequest, OrgMember } from "@/lib/types";

const { createApproval, getApprovalById } = await import("@/lib/data");
const { demoUpdateApproval } = await import("@/lib/data/demo-approvals-store");
const { assertApproverAuthorityForExecution } = await import("@/lib/approver-authority/verify");
const { approverAuthorityReplyJa } = await import("@/lib/approver-authority/reply");
const { classifyApproverRequirement } = await import("@/lib/approver-authority/targets");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { revokeUnrecordedApproval } = await import("@/lib/approver-authority/recovery");
const { POST: ownerRevokePost } = await import("@/app/api/approvals/[id]/revoke-unrecorded/route");
const { POST: operatorRevokePost } = await import("@/app/api/admin/organizations/[orgId]/approvals/[approvalId]/revoke-unrecorded/route");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const ADMIN = "mem_rv_admin";
const DIRECTOR_A = "mem_rv_director_a";
const DIRECTOR_B = "mem_rv_director_b";
const FLAGS = ["APPROVER_AUTHORITY_ENABLED", "DECISION_WORKFLOW_ENABLED"];
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));

function member(id: string, role: OrgMember["role"]): OrgMember {
  return { id, orgId: ORG, email: `${id}@fixture.invalid`, displayName: id, role, status: "active",
    capabilities: ["view_dashboard", "approve_actions", "manage_team", "hire_issue_credentials"] } as OrgMember;
}

beforeEach(() => {
  for (const k of FLAGS) process.env[k] = "true";
  resetRuntimeMembers();
  for (const m of [member(ADMIN, "admin"), member(DIRECTOR_A, "member"), member(DIRECTOR_B, "member")]) upsertRuntimeMember(m, { audit: false });
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeMembers();
});

async function ticket(tool: string, patch: Partial<ApprovalRequest>, metadata: Record<string, unknown> = {}): Promise<ApprovalRequest> {
  const created = await createApproval({
    orgId: ORG, employeeId: "emp_ops", credentialId: null, title: tool, summary: tool, purpose: `admin.${tool}`,
    risk: "high", tool, metadata: { approvalClass: "admin", adminTool: tool, adminMutation: {}, ...metadata },
  } as never) as unknown as { approval: ApprovalRequest };
  const updated = await demoUpdateApproval(created.approval.id, patch);
  return updated!;
}

describe("4. pre-ON pending tickets with no approver class", () => {
  test("target tool + empty class → refused at execution after ON; the reply guides to re-file", async () => {
    const t = await ticket("setup.slackApprover.set", { status: "approved", requiredApproverKind: null, approverMemberId: null });
    await expect(assertApproverAuthorityForExecution(t)).rejects.toMatchObject({ reason: "approver_class_missing" });
    expect(approverAuthorityReplyJa("approver_class_missing")).toContain("もう一度申請");
  });

  test("non-target tool with empty class is unchanged; flag OFF is unchanged", async () => {
    const t = await ticket("mail.send", { status: "approved", requiredApproverKind: null });
    await expect(assertApproverAuthorityForExecution(t)).resolves.toBeUndefined();
    const target = await ticket("policy.patch", { status: "approved", requiredApproverKind: null });
    delete process.env.APPROVER_AUTHORITY_ENABLED;
    await expect(assertApproverAuthorityForExecution(target)).resolves.toBeUndefined();
  });
});

describe("5. F8 final-approver record failed → owner / operator can revoke", () => {
  const stuck = () => ticket("policy.patch", { status: "approved", requiredApproverKind: "owner_or_designated_admin", approverMemberId: null });
  const ownerReq = (id: string, actor: string) => ownerRevokePost(
    new Request(`http://localhost/api/approvals/${id}/revoke-unrecorded`, {
      method: "POST", headers: { "content-type": "application/json", "x-member-id": actor }, body: JSON.stringify({ actorMemberId: actor }),
    }),
    { params: Promise.resolve({ id }) }
  );

  test("the stuck ticket is refused at fulfil (that is why a recovery is needed)", async () => {
    await expect(assertApproverAuthorityForExecution(await stuck())).rejects.toMatchObject({ reason: "approver_unverified" });
  });

  test("owner revokes from the dashboard → rejected, audited with IDs only; cannot be fulfilled", async () => {
    const t = await stuck();
    const res = await ownerReq(t.id, OWNER);
    expect(res.status).toBe(200);
    const after = (await getApprovalById(t.id, ORG))!;
    expect(after.status).toBe("rejected");
    const row = getRuntimeAudit().find((e) => e.purpose === "approver_authority.unrecorded_revoked" && e.metadata?.approvalId === t.id);
    expect(row?.metadata).toMatchObject({ approvalId: t.id, revokedBy: "owner", actorMemberId: OWNER });
  });

  test("a plain admin / member cannot revoke (403); the ticket is untouched", async () => {
    const t = await stuck();
    expect((await ownerReq(t.id, ADMIN)).status).toBe(403);
    expect((await ownerReq(t.id, DIRECTOR_A)).status).toBe(403);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("approved");
  });

  test("only that exact state is revocable: recorded approver, pending, fulfilled, non-target → not_recoverable", async () => {
    const recorded = await ticket("policy.patch", { status: "approved", requiredApproverKind: "owner_or_designated_admin", approverMemberId: OWNER });
    const pending = await ticket("policy.patch", { status: "pending", requiredApproverKind: "owner_or_designated_admin" });
    const fulfilled = await ticket("policy.patch", { status: "approved", requiredApproverKind: "owner_or_designated_admin", approverMemberId: null }, { adminFulfillment: { ok: true } });
    const plain = await ticket("mail.send", { status: "approved", requiredApproverKind: null });
    for (const t of [recorded, pending, fulfilled, plain]) {
      const r = await revokeUnrecordedApproval({ orgId: ORG, approvalId: t.id, actor: { kind: "owner", memberId: OWNER } });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("not_recoverable");
    }
  });

  test("BOLA: another org's approval id → not found", async () => {
    const t = await stuck();
    const r = await revokeUnrecordedApproval({ orgId: "org_other_rv", approvalId: t.id, actor: { kind: "operator", email: "ops@platform.example" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("approval_not_found");
  });

  test("operator path (core): revokes with revokedBy operator", async () => {
    const t = await stuck();
    const r = await revokeUnrecordedApproval({ orgId: ORG, approvalId: t.id, actor: { kind: "operator", email: "ops@platform.example" } });
    expect(r.ok).toBe(true);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("rejected");
  });

  test("operator web route refuses a tenant (non-super-admin) session", async () => {
    const t = await stuck();
    const res = await operatorRevokePost(
      new Request(`http://localhost/api/admin/organizations/${ORG}/approvals/${t.id}/revoke-unrecorded`, { method: "POST", headers: { "x-member-id": OWNER } }),
      { params: Promise.resolve({ orgId: ORG, approvalId: t.id }) }
    );
    expect([401, 403]).toContain(res.status);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("approved");
  });
});

describe("6. board resolutions are out of scope", () => {
  test("decision.request is not a target; directors who are not owners approve; execution check is a no-op", async () => {
    const created = await createApproval({
      orgId: ORG, employeeId: "emp_ops", credentialId: null, title: "取締役会決議", summary: "決議", purpose: "board",
      risk: "high", tool: "decision.request", metadata: { type: "decision_request", tier: "T3" },
    } as never) as unknown as { approval: ApprovalRequest };
    const t = created.approval;
    expect(classifyApproverRequirement({ tool: t.tool, metadata: t.metadata })).toBeNull();
    expect(t.requiredApproverKind ?? null).toBeNull();
    const r = await resolveApprovalWithWorkflow(t.id, "approved", `web:${DIRECTOR_A}`, ORG, { memberId: DIRECTOR_A, actorId: DIRECTOR_A });
    expect(r.ok).toBe(true);
    const after = (await getApprovalById(t.id, ORG))!;
    expect(after.status).toBe("approved");
    await expect(assertApproverAuthorityForExecution(after)).resolves.toBeUndefined();
  });
});
