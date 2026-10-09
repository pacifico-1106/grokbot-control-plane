/**
 * members.promoteOwner (八坂 2026-10-05 10:11): admin MCP files "make an
 * existing active member an owner"; always_human; one existing owner approves
 * (not the requester, not the target); fulfil sets role=owner + the standard
 * owner capabilities through evaluateMemberChange, notifies every owner and the
 * target, and audits. No invite, no removal / transfer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, getRuntimeApprovals, getRuntimeAudit, getRuntimeMemberById, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { ApprovalRequest, OrgMember } from "@/lib/types";

const promotedNotices: Array<{ approvalId: string; target: string }> = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => {},
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async () => ({ ok: true, provider: "slack" }),
  notifyOwnersApproverAuthorityApproved: async () => ({ owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null }),
  notifyOwnerPromoted: async (a: ApprovalRequest, input: { targetMemberId: string }) => {
    promotedNotices.push({ approvalId: a.id, target: input.targetMemberId });
    return { recipients: 0, slackDmSent: 0, slackDmFailed: 0, withoutSlack: 0, channelPost: null };
  },
});

const { callAdminMcpTool } = await import("@/lib/mcp/admin-tools");
const { resetDemoAdminAgent } = await import("@/lib/data/admin-agents");
const { getApprovalById } = await import("@/lib/data/approvals");
const { resolveApprovalWithWorkflow } = await import("@/lib/approvals/workflow-integration");
const { fulfillApprovedAdmin } = await import("@/lib/admin-mcp/fulfill-admin");
const { writeDesignatedAdminMemberIds, resetDemoDesignatedAdminsForTests } = await import("@/lib/approver-authority/designated-admins");
const { JOB_ROLE_CAPABILITY_PACKS } = await import("@/lib/team/rbac");
const { fulfillPromoteOwner } = await import("@/lib/admin-mcp/promote-owner-tool");

const ORG = DEMO_ORG.id;
const OWNER = "mem_1";
const TARGET = "mem_po_target";
const DADMIN = "mem_po_dadmin";
const FLAGS = ["APPROVER_AUTHORITY_ENABLED", "OWNER_PROMOTION_ENABLED"];
const saved = Object.fromEntries(FLAGS.map((k) => [k, process.env[k]]));

function member(id: string, role: OrgMember["role"], status: OrgMember["status"] = "active", orgId = ORG): OrgMember {
  return { id, orgId, email: `${id}@fixture.invalid`, displayName: id, role, status, capabilities: ["view_dashboard", "manage_team"] };
}
function cred() {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_po_admin", status: "linked" });
  return { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer" as const, agent };
}
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;
const promote = (args: Record<string, unknown>) => callAdminMcpTool("members.promoteOwner", args, cred()).then(data);
const approve = (id: string, memberId: string) => resolveApprovalWithWorkflow(id, "approved", `fixture:${memberId}`, ORG, { memberId, actorId: memberId });

beforeEach(() => {
  for (const k of FLAGS) process.env[k] = "true";
  resetRuntimeMembers();
  upsertRuntimeMember(member(TARGET, "admin"), { audit: false });
  upsertRuntimeMember(member(DADMIN, "admin"), { audit: false });
  upsertRuntimeMember(member("mem_po_invited", "member", "invited"), { audit: false });
  upsertRuntimeMember(member("mem_po_other_org", "member", "active", "org_other"), { audit: false });
  resetDemoDesignatedAdminsForTests();
  promotedNotices.length = 0;
});
afterEach(() => {
  for (const k of FLAGS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetRuntimeMembers();
  resetDemoDesignatedAdminsForTests();
});

describe("filing", () => {
  test("flag OFF (either flag) → feature_disabled, nothing filed", async () => {
    for (const k of FLAGS) {
      const before = process.env[k];
      delete process.env[k];
      expect((await promote({ memberId: TARGET })).code).toBe("feature_disabled");
      process.env[k] = before;
    }
  });

  test("only memberId; no invite / role / capabilities / orgId; secrets refused", async () => {
    for (const extra of [{ email: "new@fixture.invalid" }, { invite: true }, { role: "owner" }, { capabilities: ["manage_billing"] }, { orgId: "org_other" }]) {
      expect((await promote({ memberId: TARGET, ...extra })).code).toBe("unexpected_argument");
    }
    expect((await promote({})).code).toBe("member_id_required");
  });

  test("target must be an existing active non-owner member of this org", async () => {
    expect((await promote({ memberId: "mem_po_missing" })).code).toBe("member_not_found");
    expect((await promote({ memberId: "mem_po_other_org" })).code).toBe("member_not_found");
    expect((await promote({ memberId: "mem_po_invited" })).code).toBe("member_not_active");
    expect((await promote({ memberId: OWNER })).code).toBe("already_owner");
  });

  test("files an always_human ticket that needs an owner", async () => {
    const queued = await promote({ memberId: TARGET });
    expect(queued.needs_approval).toBe(true);
    const ticket = (await getApprovalById(String(queued.approvalId), ORG))!;
    expect(ticket.requiredApproverKind).toBe("owner");
    expect(ticket.metadata.always_human).toBe(true);
    expect(ticket.metadata.adminMutation).toEqual({ memberId: TARGET, beforeRole: "admin", beforeCapabilities: ["view_dashboard", "manage_team"] });
  });
});

describe("approval and fulfil", () => {
  test("designated admin / target cannot approve; one existing owner can → owner + owner caps, all notified, audited", async () => {
    await writeDesignatedAdminMemberIds(ORG, [DADMIN, TARGET]);
    const id = String((await promote({ memberId: TARGET })).approvalId);
    expect((await approve(id, DADMIN)).reason).toBe("owner_approval_required");
    // the target is refused before any endorsement is recorded
    expect((await approve(id, TARGET)).reason).toBe("approver_is_target");
    expect(await fulfillApprovedAdmin((await getApprovalById(id, ORG))!)).toBeNull();
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
    const ok = await approve(id, OWNER);
    expect(ok.ok && ok.workflowComplete).toBe(true);
    const result = await fulfillApprovedAdmin((await getApprovalById(id, ORG))!);
    expect(result?.ok).toBe(true);
    const promoted = getRuntimeMemberById(TARGET)!;
    expect(promoted.role).toBe("owner");
    expect([...(promoted.capabilities ?? [])].sort()).toEqual([...JOB_ROLE_CAPABILITY_PACKS.owner].sort());
    expect(promotedNotices).toEqual([{ approvalId: id, target: TARGET }]);
    const audit = getRuntimeAudit().find((e) => e.action === "member.updated" && e.metadata?.source === "admin_mcp_promote_owner");
    expect(audit?.metadata).toMatchObject({ memberId: TARGET, roleBefore: "admin", roleAfter: "owner", approvalId: id, actorMemberId: OWNER });
    // idempotent: a second fulfil does not re-apply or re-notify
    await fulfillApprovedAdmin((await getApprovalById(id, ORG))!);
    expect(promotedNotices.length).toBe(1);
  });

  test("fulfil refuses: approver not an owner, approver is the target or the requester, target changed or disabled", async () => {
    const id = String((await promote({ memberId: TARGET })).approvalId);
    await approve(id, OWNER);
    const approved = (await getApprovalById(id, ORG))!;
    const args = approved.metadata.adminMutation as Record<string, unknown>;
    expect(codeOf(await fulfillPromoteOwner({ ...approved, approverRole: "designated_admin" }, args))).toBe("owner_approval_required");
    expect(codeOf(await fulfillPromoteOwner({ ...approved, approverMemberId: TARGET }, args))).toBe("approver_is_target");
    expect(codeOf(await fulfillPromoteOwner({ ...approved, metadata: { ...approved.metadata, requesterMemberId: OWNER } }, args))).toBe("approver_is_requester");
    upsertRuntimeMember({ ...member(TARGET, "member") }, { audit: false });
    expect(codeOf(await fulfillPromoteOwner(approved, args))).toBe("concurrent_modification");
    upsertRuntimeMember({ ...member(TARGET, "admin", "disabled") }, { audit: false });
    expect(codeOf(await fulfillPromoteOwner(approved, args))).toBe("member_not_active");
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
    delete process.env.OWNER_PROMOTION_ENABLED;
    expect(codeOf(await fulfillPromoteOwner(approved, args))).toBe("feature_disabled");
    expect(promotedNotices).toEqual([]);
  });
});

describe("requester may never approve (no sole-owner exception)", () => {
  test("sole owner who is the requesting member cannot approve; ticket stays pending, nothing applied", async () => {
    const id = String((await promote({ memberId: TARGET })).approvalId);
    const row = getRuntimeApprovals().find((a) => a.id === id)!;
    row.metadata = { ...row.metadata, requesterMemberId: OWNER };
    const r = await approve(id, OWNER);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("approver_is_requester");
    expect((await getApprovalById(id, ORG))?.status).toBe("pending");
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
  });

  test("conflict helper: only for members.promoteOwner; target and requester ids", async () => {
    const { promoteOwnerApproverConflict } = await import("@/lib/approver-authority/decide");
    const meta = { adminMutation: { memberId: TARGET }, requesterMemberId: "mem_req", adminRequester: { actorId: "agent_x" } };
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, TARGET)).toBe("approver_is_target");
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, "mem_req")).toBe("approver_is_requester");
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, "agent_x")).toBe("approver_is_requester");
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, OWNER)).toBeNull();
    expect(promoteOwnerApproverConflict({ tool: "plan.upgrade", metadata: meta }, TARGET)).toBeNull();
  });

  test("notice text: names + short ticket id only", async () => {
    const { ownerPromotedNoticeJa } = await import("@/lib/approver-authority/reply");
    const text = ownerPromotedNoticeJa({ approvalId: "12345678-aaaa-bbbb", targetDisplayName: "山田\n太郎", approverDisplayName: "佐藤" });
    expect(text).toContain("新しいオーナー: 山田 太郎");
    expect(text).toContain("佐藤（オーナー）");
    expect(text).toContain("#12345678");
    expect(text).not.toContain("aaaa");
  });
});
