/**
 * members.promoteOwner (八坂 2026-10-05 10:11): admin MCP files "make an
 * existing active member an owner"; always_human; one existing owner approves
 * (not the requester, not the target); fulfil sets role=owner + the standard
 * owner capabilities through evaluateMemberChange, notifies every owner and the
 * target, and audits. No invite, no removal / transfer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, getRuntimeApprovals, getRuntimeAudit, getRuntimeMemberById, resetRuntimeMembers, setRuntimeMember, upsertRuntimeMember } from "@/lib/demo-data";
import type { ApprovalRequest, OrgMember } from "@/lib/types";

const promotedNotices: Array<{ approvalId: string; target: string }> = [];
const approvedNotices: string[] = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/notify/channels", {
  sendApprovalNotifications: async () => [{ ok: true, provider: "slack" }],
  refreshWorkflowNotification: async () => {},
  updateApprovalNotificationMessages: async () => [],
  notifyOwnerApprovalPending: async () => ({ ok: true, provider: "slack" }),
  notifyOwnersApproverAuthorityApproved: async (a: ApprovalRequest) => {
    approvedNotices.push(a.id);
    return { owners: 0, slackDmSent: 0, slackDmFailed: 0, ownersWithoutSlack: 0, channelPost: null };
  },
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
const { writeMemberRow, MemberConcurrentModificationError } = await import("@/lib/data/members");
const { createPendingVoterBinding, verifyVoterBinding, revokeVoterBinding, resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");

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
const REQ_SLACK = "U0POREQ01";
/** Real approver registration: pending → verified voter binding (approvalWorkflow.bindVoter path). */
async function bindSlack(memberId: string, slackUserId: string, opts: { verify?: boolean; orgId?: string } = {}) {
  const orgId = opts.orgId ?? ORG;
  const input = { orgId, provider: "slack" as const, channelKey: "C0POAPPROVE", externalUserId: slackUserId, memberId };
  const created = await createPendingVoterBinding(input);
  if (!created.ok) throw new Error(created.reason);
  if (opts.verify !== false) {
    const verified = await verifyVoterBinding({ ...input, verificationCode: created.verificationCode });
    if (!verified.ok) throw new Error(verified.reason);
  }
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
  resetDemoVoterBindings();
  promotedNotices.length = 0;
  approvedNotices.length = 0;
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
    expect(ticket.metadata.adminMutation).toEqual({ memberId: TARGET, beforeRole: "admin", beforeCapabilities: ["view_dashboard", "manage_team"], beforeStatus: "active" });
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
    // ONE owner notice, on promotion only (the after-approval notice is merged into it)
    expect(approvedNotices).toEqual([]);
    const audit = getRuntimeAudit().find((e) => e.action === "member.updated" && e.metadata?.source === "admin_mcp_promote_owner");
    expect(audit?.metadata).toMatchObject({ memberId: TARGET, roleBefore: "admin", roleAfter: "owner", approvalId: id, actorMemberId: OWNER });
    // idempotent: a second fulfil does not re-apply or re-notify
    await fulfillApprovedAdmin((await getApprovalById(id, ORG))!);
    expect(promotedNotices.length).toBe(1);
  });

  test("fulfil refuses: approver not an owner, approver is the target or the requester, target changed or disabled", async () => {
    // requester recorded through the real filing path (verified Slack binding of OWNER)
    upsertRuntimeMember(member("mem_po_owner2", "owner"), { audit: false });
    await bindSlack(OWNER, REQ_SLACK);
    const id = String((await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK })).approvalId);
    await approve(id, "mem_po_owner2");
    const approved = (await getApprovalById(id, ORG))!;
    const args = approved.metadata.adminMutation as Record<string, unknown>;
    expect(codeOf(await fulfillPromoteOwner({ ...approved, approverRole: "designated_admin" }, args))).toBe("owner_approval_required");
    expect(codeOf(await fulfillPromoteOwner({ ...approved, approverMemberId: TARGET }, args))).toBe("approver_is_target");
    // 2 owners: the recorded requester as approver is refused at fulfil too
    expect(codeOf(await fulfillPromoteOwner({ ...approved, approverMemberId: OWNER }, args))).toBe("approver_is_requester");
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

describe("who may approve (木村 2026-10-09) — requester recorded through the real filing path", () => {
  const promotionAudit = (id: string) => getRuntimeAudit().find(
    (e) => e.action === "member.updated" && e.metadata?.source === "admin_mcp_promote_owner" && e.metadata?.approvalId === id
  );
  const ticketOf = async (queued: Record<string, unknown>) => (await getApprovalById(String(queued.approvalId), ORG))!;

  test("single owner MAY approve even as the requester → promoted; audit carries singleOwnerApproval: true", async () => {
    await bindSlack(OWNER, REQ_SLACK);
    const queued = await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK });
    const ticket = await ticketOf(queued);
    expect(ticket.metadata.requesterMemberId).toBe(OWNER);
    const r = await approve(ticket.id, OWNER);
    expect(r.ok && r.workflowComplete).toBe(true);
    expect((await fulfillApprovedAdmin((await getApprovalById(ticket.id, ORG))!))?.ok).toBe(true);
    expect(getRuntimeMemberById(TARGET)?.role).toBe("owner");
    expect(promotionAudit(ticket.id)?.metadata?.singleOwnerApproval).toBe(true);
    expect(promotedNotices).toEqual([{ approvalId: ticket.id, target: TARGET }]);
    expect(approvedNotices).toEqual([]);
  });

  test("2+ owners: the requesting owner (identified from the verified Slack binding) is refused; another owner approves; singleOwnerApproval: false", async () => {
    upsertRuntimeMember(member("mem_po_owner2", "owner"), { audit: false });
    await bindSlack(OWNER, REQ_SLACK);
    const ticket = await ticketOf(await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK }));
    expect(ticket.metadata.requesterMemberId).toBe(OWNER);
    expect(ticket.metadata.requesterIdentity).toMatchObject({ source: "admin_agent_declared_slack_user", matchedBy: "verified_voter_binding", memberId: OWNER });
    expect(ticket.summary).toContain("依頼者: 山田 太郎");
    const refused = await approve(ticket.id, OWNER);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("approver_is_requester");
    expect((await getApprovalById(ticket.id, ORG))?.status).toBe("pending");
    const ok = await approve(ticket.id, "mem_po_owner2");
    expect(ok.ok && ok.workflowComplete).toBe(true);
    expect((await fulfillApprovedAdmin((await getApprovalById(ticket.id, ORG))!))?.ok).toBe(true);
    expect(promotionAudit(ticket.id)?.metadata?.singleOwnerApproval).toBe(false);
  });

  test("requester cannot be identified → the card says so honestly; no requester recorded", async () => {
    upsertRuntimeMember(member("mem_po_later_off", "member"), { audit: false });
    await bindSlack("mem_po_later_off", "U0POOFF01");
    setRuntimeMember({ ...member("mem_po_later_off", "member"), status: "disabled" }); // bound, then disabled
    await bindSlack(OWNER, "U0POPEND1", { verify: false }); // pending binding
    await bindSlack(OWNER, "U0POREVK1");
    await revokeVoterBinding(ORG, "slack", "C0POAPPROVE", "U0POREVK1");
    await bindSlack("mem_po_other_org", "U0POOTHR1", { orgId: "org_other" }); // another org's binding
    for (const args of [{}, { requesterSlackUserId: "U0PONONE1" }, { requesterSlackUserId: "U0POPEND1" }, { requesterSlackUserId: "U0POREVK1" }, { requesterSlackUserId: "U0POOTHR1" }, { requesterSlackUserId: "U0POOFF01" }]) {
      const ticket = await ticketOf(await promote({ memberId: TARGET, ...args }));
      expect(ticket.summary).toContain("依頼者は特定できません");
      expect(ticket.metadata.requesterMemberId ?? null).toBeNull();
      expect((ticket.metadata.requesterIdentity as { identified?: boolean } | undefined)?.identified ?? false).toBe(false);
    }
  });

  test("option (c), 木村 2026-10-09 22:48: 2+ owners and the requester is not a verified approver identity → refused at filing; nothing queued", async () => {
    upsertRuntimeMember(member("mem_po_owner2", "owner"), { audit: false });
    await bindSlack(OWNER, "U0POPEND1", { verify: false }); // pending binding
    await bindSlack(OWNER, "U0POREVK1");
    await revokeVoterBinding(ORG, "slack", "C0POAPPROVE", "U0POREVK1");
    await bindSlack("mem_po_other_org", "U0POOTHR1", { orgId: "org_other" });
    const before = getRuntimeApprovals().length;
    for (const args of [{}, { requesterSlackUserId: "U0PONONE1" }, { requesterSlackUserId: "U0POPEND1" }, { requesterSlackUserId: "U0POREVK1" }, { requesterSlackUserId: "U0POOTHR1" }]) {
      const r = await promote({ memberId: TARGET, ...args });
      expect(r.ok).toBe(false);
      expect(r.code).toBe("requester_not_identified");
      expect(r.nextStepJa).toBe("依頼した人の Slack ID を requesterSlackUserId に入れて申請し直してください");
    }
    expect(getRuntimeApprovals().length).toBe(before);
    // identified requester with 2+ owners still files
    await bindSlack(OWNER, REQ_SLACK);
    const ok = await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK });
    expect(ok.needs_approval).toBe(true);
    expect(getRuntimeApprovals().length).toBe(before + 1);
  });

  test("option (c): single owner keeps the exception — files without an identified requester", async () => {
    const r = await promote({ memberId: TARGET });
    expect(r.needs_approval).toBe(true);
    expect(r.code).not.toBe("requester_not_identified");
  });

  test("the agent cannot name the requester member directly; a malformed Slack id is refused", async () => {
    expect((await promote({ memberId: TARGET, requesterMemberId: "mem_po_owner2" })).code).toBe("unexpected_argument");
    expect((await promote({ memberId: TARGET, requesterSlackUserId: "not-a-slack-id" })).code).toBe("invalid_requester_slack_user_id");
  });

  test("the member being promoted can NEVER approve (even as a designated admin, even as the identified requester with one owner)", async () => {
    await writeDesignatedAdminMemberIds(ORG, [TARGET]);
    await bindSlack(TARGET, REQ_SLACK);
    const ticket = await ticketOf(await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK }));
    expect(ticket.metadata.requesterMemberId).toBe(TARGET);
    const r = await approve(ticket.id, TARGET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("approver_is_target");
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
  });

  test("nobody can approve (no active owner) → refused at filing with a next step; nothing queued", async () => {
    setRuntimeMember({ ...getRuntimeMemberById(OWNER)!, status: "disabled" });
    const before = getRuntimeApprovals().length;
    const r = await promote({ memberId: TARGET });
    expect(r.ok).toBe(false);
    expect(String(r.code)).toMatch(/owner/);
    expect(String(r.nextStepJa || "")).not.toBe("");
    expect(getRuntimeApprovals().length).toBe(before);
  });

  test("conflict helper: only the target is a promoteOwner-specific conflict (requester follows the general single-owner rule)", async () => {
    const { promoteOwnerApproverConflict } = await import("@/lib/approver-authority/decide");
    const meta = { adminMutation: { memberId: TARGET }, requesterMemberId: "mem_req", adminRequester: { actorId: "agent_x" } };
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, TARGET)).toBe("approver_is_target");
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, "mem_req")).toBeNull();
    expect(promoteOwnerApproverConflict({ tool: "members.promoteOwner", metadata: meta }, OWNER)).toBeNull();
    expect(promoteOwnerApproverConflict({ tool: "plan.upgrade", metadata: meta }, TARGET)).toBeNull();
  });

  test("'unchanged since filing' includes status: the conditional write refuses a member whose status changed", async () => {
    const current = getRuntimeMemberById(TARGET)!;
    setRuntimeMember({ ...current, status: "disabled" });
    const thrown = await writeMemberRow(
      { ...current, role: "owner", capabilities: [...JOB_ROLE_CAPABILITY_PACKS.owner] },
      ORG,
      { role: "admin", capabilities: [...(current.capabilities ?? [])], status: "active" } as never
    ).then(() => null, (error: unknown) => error);
    expect(thrown instanceof MemberConcurrentModificationError).toBe(true);
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
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

// 木村 2026-10-09 round 3 G1: filed with ONE owner (requester unidentified is
// allowed then), a 2nd owner is added before approval / execution → the
// requesting owner could otherwise self-approve. Re-checked at both points.
describe("G1: 2+ owners by approval / execution time and the requester is not identified → requester_not_identified", () => {
  const OWNER2 = "mem_po_owner2_late";
  const ticketOf = async (queued: Record<string, unknown>) => (await getApprovalById(String(queued.approvalId), ORG))!;

  test("approval time: a 2nd owner added after filing → refused (whoever presses); nothing applied", async () => {
    const ticket = await ticketOf(await promote({ memberId: TARGET }));
    expect((ticket.metadata.requesterIdentity as { identified?: boolean }).identified).toBe(false);
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    for (const who of [OWNER, OWNER2]) {
      const r = await approve(ticket.id, who);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("requester_not_identified");
    }
    expect((await getApprovalById(ticket.id, ORG))?.status).toBe("pending");
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
    const { approverAuthorityReplyJa } = await import("@/lib/approver-authority/reply");
    expect(approverAuthorityReplyJa("requester_not_identified")).toContain("requesterSlackUserId");
  });

  test("execution time: approved while sole owner, a 2nd owner added before fulfil → refused; nothing applied", async () => {
    const ticket = await ticketOf(await promote({ memberId: TARGET }));
    expect((await approve(ticket.id, OWNER)).ok).toBe(true);
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    const approved = (await getApprovalById(ticket.id, ORG))!;
    const direct = await fulfillPromoteOwner(approved, approved.metadata.adminMutation as Record<string, unknown>);
    expect(codeOf(direct)).toBe("requester_not_identified");
    const viaFulfil = await fulfillApprovedAdmin(approved);
    expect(viaFulfil?.ok).toBe(false);
    expect(getRuntimeMemberById(TARGET)?.role).toBe("admin");
  });

  test("identified requester: a 2nd owner added later → the other owner can still approve and it runs", async () => {
    await bindSlack(OWNER, REQ_SLACK);
    const ticket = await ticketOf(await promote({ memberId: TARGET, requesterSlackUserId: REQ_SLACK }));
    upsertRuntimeMember(member(OWNER2, "owner"), { audit: false });
    expect((await approve(ticket.id, OWNER2)).ok).toBe(true);
    const result = await fulfillApprovedAdmin((await getApprovalById(ticket.id, ORG))!);
    expect(result?.ok).toBe(true);
    expect(getRuntimeMemberById(TARGET)?.role).toBe("owner");
  });
});
