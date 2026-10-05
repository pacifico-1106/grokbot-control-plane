/**
 * PR-D approver authority, end to end in demo mode:
 * filing records the kind; W1 approval verifies + stores the approver; a
 * designated admin on an owner ticket leaves it オーナー承認待ち (nothing
 * applied, inbox told); Slack / LINE / Telegram / web reach the same decision;
 * fulfil re-verifies; zero owners stop; self-approval still refused; the
 * owner-only 指定管理者 tools; flag OFF = today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { ApprovalRequest, OrgMember } from "@/lib/types";

const pendingNotices: string[] = [];
const approvedNotices: string[] = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => {},
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async (a: ApprovalRequest) => {
    pendingNotices.push(a.id);
    return { ok: true, provider: "slack" };
  },
  notifyOwnersApproverAuthorityApproved: async (a: ApprovalRequest) => {
    approvedNotices.push(`${a.id}:${a.approverMemberId}`);
    return { owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null };
  },
});

const { createApproval, getApprovalById } = await import("@/lib/data/approvals");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { assertApprovalExecutionAuthority } = await import("@/lib/approvals/execution-authority");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { writeDesignatedAdminMemberIds, getDesignatedAdminMemberIds, resetDemoDesignatedAdminsForTests } = await import(
  "@/lib/approver-authority/designated-admins"
);
const { approverAuthorityReplyJa, approverAuthorityNextStepJa } = await import("@/lib/approver-authority/card");
const { approverFilingStop } = await import("@/lib/approver-authority/filing");
const { getVerifiedApprover } = await import("@/lib/approver-authority");
const { setDemoWorkflowVoterBinding } = await import("@/lib/approval-workflow/data");
const { setOrgApprovalWorkflowPolicy, resetDemoWorkflowData, getWorkflowInstanceByApprovalId, getBallotsByInstanceId } = await import("@/lib/approval-workflow/data");
const { POST: webApprove } = await import("../../app/api/approvals/[id]/approve/route");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1"; // demo owner
const DADMIN = "mem_pd_designated";
const ADMIN = "mem_pd_plain_admin";
const MEMBER = "mem_3";
const REQUESTER = "admin_agent_pd_requester";
const FLAG = "APPROVER_AUTHORITY_ENABLED";
let savedFlag: string | undefined;

function member(id: string, role: OrgMember["role"], status: OrgMember["status"] = "active"): OrgMember {
  return { id, orgId: ORG, email: `${id}@fixture.invalid`, displayName: id, role, status, capabilities: ["approve_actions"] };
}

beforeEach(() => {
  savedFlag = process.env[FLAG];
  process.env[FLAG] = "true";
  resetRuntimeMembers();
  upsertRuntimeMember(member(DADMIN, "admin"), { audit: false });
  upsertRuntimeMember(member(ADMIN, "admin"), { audit: false });
  resetDemoDesignatedAdminsForTests();
  pendingNotices.length = 0;
  approvedNotices.length = 0;
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  resetRuntimeMembers();
  resetDemoDesignatedAdminsForTests();
});

async function file(tool: string, adminMutation: Record<string, unknown>, extraMetadata: Record<string, unknown> = {}) {
  const created = await createApproval({
    orgId: ORG, employeeId: "", credentialId: "", title: tool, purpose: "admin.policy", summary: tool, risk: "high", tool,
    jobId: crypto.randomUUID(),
    metadata: {
      auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: tool, isAdminMcpTool: true, adminMutation,
      adminRequester: { kind: "admin_agent", actorId: REQUESTER, grokBotAgentId: "grok_pd_requester", credentialGeneration: 1 },
      ...extraMetadata,
    },
  });
  return created.approval;
}
const standard = () => file("approvalWorkflow.bindVoter", { memberId: "x", provider: "slack" });
const sensitive = () => file("plan.upgrade", { planKey: "proper" });
const approve = (id: string, memberId: string | null, extra: Record<string, unknown> = {}) =>
  resolveApprovalWithWorkflow(id, "approved", `fixture:${memberId}`, ORG, { memberId, actorId: memberId, ...extra });

describe("filing", () => {
  test("flag ON: target tickets record the required approver kind; others do not", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    expect((await standard()).requiredApproverKind).toBe("owner_or_designated_admin");
    const s = await sensitive();
    expect(s.requiredApproverKind).toBe("owner");
    expect(s.approverAuthority?.reasons).toEqual(["sensitive_target_tool"]);
    expect((await getApprovalById(s.id, ORG))?.requiredApproverKind).toBe("owner");
    expect((await file("parties.upsert", { identifier: "x" })).requiredApproverKind ?? null).toBeNull();
  });

  test("flag OFF: nothing recorded", async () => {
    delete process.env[FLAG];
    expect((await sensitive()).requiredApproverKind ?? null).toBeNull();
  });
});

describe("W1 approval", () => {
  test("standard: only owner or designated admin; the approver is stored", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN, MEMBER]);
    const t = await standard();
    for (const [who, reason] of [[ADMIN, "approver_not_authorized"], [MEMBER, "approver_not_authorized"], [null, "approver_member_required"], ["mem_nobody", "approver_not_found"]] as const) {
      const r = await approve(t.id, who);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
      expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
    }
    const ok = await approve(t.id, DADMIN);
    expect(ok.ok && ok.workflowComplete).toBe(true);
    const stored = (await getApprovalById(t.id, ORG))!;
    expect(stored.status).toBe("approved");
    expect([stored.approverMemberId, stored.approverRole]).toEqual([DADMIN, "designated_admin"]);
    expect(getVerifiedApprover(stored)).toEqual({ memberId: DADMIN, role: "designated_admin" });
    await assertApprovalExecutionAuthority(stored); // re-check passes
  });

  test("sensitive: designated admin first → オーナー承認待ち, nothing applied, inbox told; owner then approves", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    const t = await sensitive();
    const first = await approve(t.id, DADMIN);
    expect(first.ok).toBe(false);
    expect(first.reason).toBe("owner_approval_required");
    expect(first.approval?.status).toBe("pending");
    const pending = (await getApprovalById(t.id, ORG))!;
    expect(pending.status).toBe("pending");
    expect(pending.approverMemberId ?? null).toBeNull();
    expect((pending.approverAuthority?.endorsements as unknown[]).length).toBe(1);
    expect(pendingNotices).toEqual([t.id]);
    expect(await fulfillApprovedAdmin(pending)).toBeNull(); // not approved → nothing runs
    await approve(t.id, DADMIN); // repeat: still one endorsement
    expect(((await getApprovalById(t.id, ORG))!.approverAuthority?.endorsements as unknown[]).length).toBe(1);
    const owner = await approve(t.id, OWNER);
    expect(owner.ok && owner.workflowComplete).toBe(true);
    const done = (await getApprovalById(t.id, ORG))!;
    expect([done.status, done.approverMemberId, done.approverRole]).toEqual(["approved", OWNER, "owner"]);
  });

  test("zero active owners → stop (filing and approval)", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    const t = await standard();
    upsertRuntimeMember({ ...member(OWNER, "owner", "disabled") }, { audit: false });
    const r = await approve(t.id, DADMIN);
    expect([r.ok, r.reason]).toEqual([false, "org_has_no_owner"]);
  });

  test("self-approval is still refused (before any authority check)", async () => {
    const t = await standard();
    await expect(resolveApprovalWithWorkflow(t.id, "approved", "self", ORG, { memberId: OWNER, actorId: REQUESTER })).rejects.toThrow("self_approval_denied");
  });

  test("reject is not gated (nothing is applied)", async () => {
    const t = await sensitive();
    const r = await resolveApprovalWithWorkflow(t.id, "rejected", "fixture", ORG, { memberId: ADMIN, actorId: ADMIN });
    expect(r.ok && r.workflowComplete && r.workflowRejected).toBe(true);
  });

  test("Slack / LINE / Telegram / web reach the same decision and reply", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    const replies = new Set<string>();
    for (const provider of ["slack", "line", "telegram"] as const) {
      const channelKey = `ch_pd_${provider}`;
      for (const [userId, memberId] of [["U_PD_ADMIN", ADMIN], ["U_PD_DADMIN", DADMIN]] as const) {
        setDemoWorkflowVoterBinding({ orgId: ORG, provider, channelKey, userId, memberId, verifiedAt: new Date().toISOString() });
      }
      const t = await sensitive();
      const denied = await approve(t.id, ADMIN, { externalVoter: { provider, channelKey, userId: "U_PD_ADMIN" }, decisionId: `${provider}:1` });
      expect(denied.reason).toBe("approver_not_authorized");
      const endorsed = await approve(t.id, DADMIN, { externalVoter: { provider, channelKey, userId: "U_PD_DADMIN" }, decisionId: `${provider}:2` });
      expect(endorsed.reason).toBe("owner_approval_required");
      // The pressing account must be linked to the member who counts (fail closed).
      const unbound = await approve(t.id, OWNER, { externalVoter: { provider, channelKey, userId: "U_PD_UNBOUND" }, decisionId: `${provider}:3` });
      expect(unbound.reason).toBe("approver_identity_unverified");
      const spoofed = await approve(t.id, OWNER, { externalVoter: { provider, channelKey, userId: "U_PD_ADMIN" }, decisionId: `${provider}:4` });
      expect(spoofed.reason).toBe("approver_identity_unverified");
      expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
      replies.add(`${approverAuthorityReplyJa(denied.reason)}|${approverAuthorityReplyJa(endorsed.reason)}`);
    }
    const t = await sensitive();
    const res = await webApprove(new Request(`http://localhost/api/approvals/${t.id}/approve`, { method: "POST", headers: { "x-member-id": DADMIN } }), { params: Promise.resolve({ id: t.id }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("owner_approval_required");
    replies.add(`${approverAuthorityReplyJa("approver_not_authorized")}|${String(body.messageJa)}`);
    expect(replies.size).toBe(1);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
  });

  test("owner: one tap satisfies the ticket (no second press); other owners get the 事後通知", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    for (const t of [await standard(), await sensitive()]) {
      const r = await approve(t.id, OWNER);
      expect(r.ok && r.workflowComplete).toBe(true);
      expect((await getApprovalById(t.id, ORG))?.status).toBe("approved");
      expect(approvedNotices).toContain(`${t.id}:${OWNER}`);
    }
    delete process.env[FLAG];
    await approve((await sensitive()).id, OWNER);
    expect(approvedNotices.length).toBe(2); // flag OFF: no notice
  });

  test("required approvals: recorded as 1; an unimplemented count fails closed at fulfil", async () => {
    const t = await sensitive();
    expect(t.approverAuthority?.requiredApprovals).toBe(1);
    await approve(t.id, OWNER);
    const done = (await getApprovalById(t.id, ORG))!;
    await assertApprovalExecutionAuthority(done);
    await expect(assertApprovalExecutionAuthority({ ...done, approverAuthority: { ...done.approverAuthority, requiredApprovals: 2 } }))
      .rejects.toThrow("approver_authority_required_approvals_unsupported");
  });
});

describe("fulfil re-check", () => {
  test("designated admin removed from the list after approval → stop before fulfil", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    const t = await standard();
    await approve(t.id, DADMIN);
    await writeDesignatedAdminMemberIds(ORG, []);
    await expect(assertApprovalExecutionAuthority((await getApprovalById(t.id, ORG))!)).rejects.toThrow("approver_not_authorized");
  });

  test("no stored approver / zero owners → stop; flag OFF → today's behaviour", async () => {
    const t = await sensitive();
    await approve(t.id, OWNER);
    const approved = (await getApprovalById(t.id, ORG))!;
    await expect(assertApprovalExecutionAuthority({ ...approved, approverMemberId: null })).rejects.toThrow("approver_unverified");
    upsertRuntimeMember({ ...member(OWNER, "owner", "disabled") }, { audit: false });
    await expect(assertApprovalExecutionAuthority(approved)).rejects.toThrow("approver_authority_org_has_no_owner");
    delete process.env[FLAG];
    await assertApprovalExecutionAuthority({ ...approved, approverMemberId: null });
  });
});

describe("approvers.designatedAdmins.* (owner-only list)", () => {
  function cred() {
    const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_pd_admin_tools", status: "linked" });
    return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer" as const, agent };
  }
  const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

  test("set: validated, owner-required ticket; designated admin cannot apply it; owner can", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    const bad = data(await callAdminMcpTool("approvers.designatedAdmins.set", { memberIds: [MEMBER] }, cred()));
    expect(bad.code).toBe("designated_admins_invalid");
    expect(data(await callAdminMcpTool("approvers.designatedAdmins.set", { memberIds: [ADMIN], orgId: "other" }, cred())).code).toBe("unexpected_argument");
    const queued = data(await callAdminMcpTool("approvers.designatedAdmins.set", { memberIds: [DADMIN, ADMIN] }, cred()));
    expect(queued.needs_approval).toBe(true);
    const id = String(queued.approvalId);
    expect((await getApprovalById(id, ORG))?.requiredApproverKind).toBe("owner");
    expect((await approve(id, DADMIN)).reason).toBe("owner_approval_required");
    expect(await getDesignatedAdminMemberIds(ORG)).toEqual([DADMIN]);
    await approve(id, OWNER);
    const result = await fulfillApprovedAdmin((await getApprovalById(id, ORG))!);
    expect(result?.ok).toBe(true);
    expect(await getDesignatedAdminMemberIds(ORG)).toEqual([DADMIN, ADMIN]);
    const listed = data(await callAdminMcpTool("approvers.designatedAdmins.get", {}, cred()));
    expect((listed.designatedAdmins as Array<{ memberId: string }>).map((m) => m.memberId)).toEqual([DADMIN, ADMIN]);
  });

  test("fulfil refuses when the stored approver is not an owner", async () => {
    const queued = data(await callAdminMcpTool("approvers.designatedAdmins.set", { memberIds: [ADMIN] }, cred()));
    const id = String(queued.approvalId);
    await approve(id, OWNER);
    const approved = (await getApprovalById(id, ORG))!;
    const { fulfillDesignatedAdminsSet } = await import("@/lib/admin-mcp/designated-admins-tool");
    const refused = await fulfillDesignatedAdminsSet({ ...approved, approverRole: "designated_admin" }, { memberIds: [ADMIN] });
    expect(refused.ok).toBe(false);
    expect(await getDesignatedAdminMemberIds(ORG)).toEqual([]);
  });

  test("flag OFF: both tools are disabled", async () => {
    delete process.env[FLAG];
    for (const name of ["approvers.designatedAdmins.get", "approvers.designatedAdmins.set"]) {
      expect(data(await callAdminMcpTool(name, name.endsWith(".set") ? { memberIds: [] } : {}, cred())).code).toBe("feature_disabled");
    }
  });
});

describe("flag OFF parity", () => {
  test("any approver resolves a target ticket as today; nothing stored, no reason leak", async () => {
    delete process.env[FLAG];
    const t = await sensitive();
    const r = await approve(t.id, ADMIN);
    expect(r.ok && r.workflowComplete).toBe(true);
    const done = (await getApprovalById(t.id, ORG))!;
    expect(done.approverMemberId ?? null).toBeNull();
    expect(pendingNotices).toEqual([]);
  });
});

describe("F8 workflow voters", () => {
  afterEach(() => resetDemoWorkflowData());
  async function withPolicy(tool: string) {
    resetDemoWorkflowData();
    await setOrgApprovalWorkflowPolicy(ORG, {
      version: 1, policyId: "pd_fixture", policyName: "PD fixture", match: { tools: [tool] },
      stages: [{ id: "s1", nameJa: "承認", voterUserIds: [ADMIN, DADMIN, OWNER], quorum: { type: "any" }, onReject: "fail_closed" }],
      updatedAt: new Date().toISOString(), updatedBy: "fixture",
    });
  }

  test("standard: a voter who is not owner/designated admin casts no ballot; designated admin completes", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    await withPolicy("approvalWorkflow.bindVoter");
    const t = await standard();
    const denied = await approve(t.id, ADMIN, { voterUserId: ADMIN });
    expect([denied.ok, denied.reason]).toEqual([false, "approver_not_authorized"]);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
    const instance = await getWorkflowInstanceByApprovalId(t.id);
    expect(instance).not.toBeNull();
    expect((await getBallotsByInstanceId(instance!.id)).filter((b) => b.votedAt !== null)).toEqual([]);
    const ok = await approve(t.id, DADMIN, { voterUserId: DADMIN });
    expect(ok.ok && ok.workflowComplete).toBe(true);
    const done = (await getApprovalById(t.id, ORG))!;
    expect([done.status, done.approverMemberId, done.approverRole]).toEqual(["approved", DADMIN, "designated_admin"]);
  });

  test("sensitive: designated admin → オーナー承認待ち; owner completes", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN]);
    await withPolicy("plan.upgrade");
    const t = await sensitive();
    const first = await approve(t.id, DADMIN, { voterUserId: DADMIN });
    expect([first.ok, first.reason]).toEqual([false, "owner_approval_required"]);
    expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
    expect(pendingNotices).toEqual([t.id]);
    const ok = await approve(t.id, OWNER, { voterUserId: OWNER });
    expect(ok.ok && ok.workflowComplete).toBe(true);
    expect((await getApprovalById(t.id, ORG))?.approverRole).toBe("owner");
  });
});

describe("multiple owners (八坂 2026-10-05): any one owner other than the requester", () => {
  const OWNER2 = "mem_pd_owner2";
  const byOwner = { requesterMemberId: OWNER }; // human-filed ticket (PR-K / PR-L shape)

  test("N owners: the requesting owner is refused; any other owner approves", async () => {
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    const t = await file("plan.upgrade", { planKey: "proper" }, byOwner);
    const self = await approve(t.id, OWNER);
    expect([self.ok, self.reason]).toEqual([false, "approver_is_requester"]);
    expect(approverAuthorityNextStepJa(self.reason)).toContain("申請者以外のオーナー");
    expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
    const other = await approve(t.id, OWNER2);
    expect(other.ok && other.workflowComplete).toBe(true);
    const done = (await getApprovalById(t.id, ORG))!;
    expect([done.approverMemberId, done.approverRole]).toEqual([OWNER2, "owner"]);
    await assertApprovalExecutionAuthority(done);
    // OWNER2 later leaves: the stored approver no longer verifies → fulfil stops.
    upsertRuntimeMember(member(OWNER2, "owner", "disabled"), { audit: false });
    await expect(assertApprovalExecutionAuthority(done)).rejects.toThrow("approver_inactive");
  });

  test("sole owner: their own approval counts (one tap, both kinds)", async () => {
    expect(await approverFilingStop({ orgId: ORG, tool: "plan.upgrade", metadata: { adminMutation: { planKey: "proper" }, ...byOwner } })).toBeNull();
    for (const t of [await file("plan.upgrade", { planKey: "proper" }, byOwner), await file("approvalWorkflow.bindVoter", {}, byOwner)]) {
      const r = await approve(t.id, OWNER);
      expect(r.ok && r.workflowComplete).toBe(true);
      const done = (await getApprovalById(t.id, ORG))!;
      expect([done.approverMemberId, done.approverRole]).toEqual([OWNER, "owner"]);
      await assertApprovalExecutionAuthority(done);
    }
    // A second owner appears before fulfil: the requester's own approval no longer counts.
    const t = await file("plan.upgrade", { planKey: "proper" }, byOwner);
    await approve(t.id, OWNER);
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    await expect(assertApprovalExecutionAuthority((await getApprovalById(t.id, ORG))!)).rejects.toThrow("approver_is_requester");
  });

  test("several owners, all requesters → stop with a nextStep (filing, approval, web)", async () => {
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    const both = {
      adminRequester: { kind: "admin_agent", actorId: OWNER2, grokBotAgentId: "grok_pd_requester", credentialGeneration: 1 },
      requesterMemberId: OWNER,
    };
    const stop = await approverFilingStop({ orgId: ORG, tool: "plan.upgrade", metadata: { adminMutation: { planKey: "proper" }, ...both } });
    expect(stop?.reason).toBe("no_owner_other_than_requester");
    expect(stop?.nextStepJa).toContain("申請者以外のオーナー");
    const t = await file("plan.upgrade", { planKey: "proper" }, both);
    const r = await approve(t.id, OWNER);
    expect([r.ok, r.reason]).toEqual([false, "no_owner_other_than_requester"]);
    const res = await webApprove(new Request(`http://localhost/api/approvals/${t.id}/approve`, { method: "POST", headers: { "x-member-id": OWNER } }), { params: Promise.resolve({ id: t.id }) });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reason).toBe("no_owner_other_than_requester");
    expect(String(body.nextStepJa)).toContain("申請者以外のオーナー");
    expect(String(body.messageJa)).toContain("次の手順");
    expect((await getApprovalById(t.id, ORG))?.status).toBe("pending");
  });

  test("admin MCP filing stops up front when no owner could approve; flag OFF files as today", async () => {
    const agent = (await import("@/lib/data/admin-agents")).resetDemoAdminAgent({ grokBotAgentId: "grok_pd_owner_stop", status: "linked" });
    const cred = { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer" as const, agent };
    upsertRuntimeMember(member(OWNER, "owner", "disabled"), { audit: false });
    const stopped = (await callAdminMcpTool("approvers.designatedAdmins.set", { memberIds: [] }, cred)).structuredContent as Record<string, unknown>;
    expect(stopped.code).toBe("org_has_no_owner");
    expect(String(stopped.nextStepJa)).toContain("オーナー");
    expect(stopped.needs_approval).toBeUndefined();
    delete process.env[FLAG];
    expect(await approverFilingStop({ orgId: ORG, tool: "plan.upgrade", metadata: byOwner })).toBeNull();
  });
});
