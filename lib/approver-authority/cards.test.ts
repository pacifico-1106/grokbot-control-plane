/**
 * PR-D cards and notices: Slack / LINE / Telegram cards show オーナー承認が必要
 * and whose approval is pending (flag ON, pending target tickets only); the
 * 事後通知 to other owners carries no title / summary / arguments and goes by
 * Slack DM (verified binding) + the LINE / Telegram inbox. Fetch is stubbed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { scopedModuleMocks } from "../../tests/helpers/scoped-module-mock";
import { DEMO_ORG, resetRuntimeMembers, upsertRuntimeMember } from "@/lib/demo-data";
import type { ApprovalRequest } from "@/lib/types";
import type { NotificationChannelRuntime } from "@/lib/data/notification-channels";

let channels: NotificationChannelRuntime[] = [];
const mocks = scopedModuleMocks();
await mocks.mock("@/lib/data", { getEnabledNotificationChannels: async () => channels });

const { buildApprovalTelegramMessage } = await import("@/lib/notify/telegram");
const { sendApprovalToSlackChannel } = await import("@/lib/notify/slack");
const { sendApprovalToLineChannel } = await import("@/lib/notify/line");
const { notifyOwnersApproverAuthorityApproved, notifyOwnerPromoted } = await import("@/lib/notify/channels");
const { approverRequirementCardLinesJa, approverAuthorityApprovedNoticeJa } = await import("@/lib/approver-authority/card");
const { createPendingVoterBinding, verifyVoterBinding, resetDemoVoterBindings } = await import("@/lib/approval-workflow/voter-binding");

const FLAG = "APPROVER_AUTHORITY_ENABLED";
const saved = process.env[FLAG];
const originalFetch = globalThis.fetch;
let posted: Array<{ url: string; body: Record<string, unknown> }> = [];
beforeEach(() => {
  process.env[FLAG] = "true";
  posted = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    posted.push({ url: String(url), body });
    const json = String(url).includes("conversations.open") ? { ok: true, channel: { id: "D_PD_DM" } } : { ok: true, ts: "1.2", channel: "C_PD" };
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
  resetRuntimeMembers();
  resetDemoVoterBindings();
  channels = [];
});
afterAll(() => { globalThis.fetch = originalFetch; });

const SECRET_TITLE = "社外秘タイトル";
const SECRET_SUMMARY = "本文: 振込先 1234-5678";
function ticket(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "00000000-0000-4000-8000-00000000c0a1", orgId: DEMO_ORG.id, employeeId: "", credentialId: "", title: SECRET_TITLE,
    purpose: "admin.policy", summary: SECRET_SUMMARY, risk: "high", status: "pending", tool: "plan.upgrade", jobId: "job_pd",
    metadata: {}, createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null, revisionNote: null, revisionCount: 0,
    parentApprovalId: null, telegramRef: "ref_pd_card", requiredApproverKind: "owner", approverAuthority: { reasons: ["sensitive_target_tool"] },
    ...over,
  } as ApprovalRequest;
}
const slackChannel = { id: "nc_pd_slack", orgId: DEMO_ORG.id, provider: "slack", label: "s", enabled: true, isDefault: true,
  config: { channelId: "C_PD" }, secrets: { botToken: "xoxb-fixture-not-real" } } as unknown as NotificationChannelRuntime;
const lineChannel = { id: "nc_pd_line", orgId: DEMO_ORG.id, provider: "line", label: "l", enabled: true, isDefault: true,
  config: { destinationId: "C_LINE_PD" }, secrets: { channelAccessToken: "line-fixture-not-real" } } as unknown as NotificationChannelRuntime;

describe("cards", () => {
  test("owner ticket: required + pending lines on Telegram, Slack and LINE", async () => {
    expect(buildApprovalTelegramMessage(ticket(), null)).toContain("オーナー承認が必要");
    expect(buildApprovalTelegramMessage(ticket(), null)).toContain("承認待ち: オーナー");
    await sendApprovalToSlackChannel(ticket(), null, slackChannel);
    expect(JSON.stringify(posted[0].body.blocks)).toContain("オーナー承認が必要");
    await sendApprovalToLineChannel(ticket(), null, lineChannel);
    expect(JSON.stringify(posted[1].body)).toContain("オーナー承認が必要");
  });

  test("endorsed ticket shows the designated-admin count; standard ticket shows owner or designated admin", () => {
    const endorsed = approverRequirementCardLinesJa(ticket({ approverAuthority: { endorsements: [{ memberId: "x" }] } }));
    expect(endorsed[1]).toContain("指定管理者 1 人は承認済み");
    expect(approverRequirementCardLinesJa(ticket({ requiredApproverKind: "owner_or_designated_admin" }))[0]).toContain("オーナーまたは指定管理者");
  });

  test("flag OFF / resolved / non-target: cards unchanged", () => {
    expect(approverRequirementCardLinesJa(ticket({ status: "approved" }))).toEqual([]);
    expect(approverRequirementCardLinesJa(ticket({ requiredApproverKind: null }))).toEqual([]);
    delete process.env[FLAG];
    expect(buildApprovalTelegramMessage(ticket(), null)).not.toContain("オーナー承認");
  });
});

describe("事後通知 to other owners", () => {
  test("text carries no title / summary / arguments", () => {
    const text = approverAuthorityApprovedNoticeJa({ tool: "plan.upgrade\n<b>", approvalId: ticket().id, approverRole: "owner", approverDisplayName: "Owner\nOne" });
    expect(text).toContain("plan.upgradeb");
    expect(text).toContain("Owner One（オーナー）");
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain(SECRET_SUMMARY);
  });

  test("Slack DM to every other active owner with a verified binding; LINE inbox gets the same text", async () => {
    const base = { orgId: DEMO_ORG.id, email: "x@fixture.invalid", role: "owner" as const, status: "active" as const, capabilities: [] };
    upsertRuntimeMember({ ...base, id: "mem_pd_o2", displayName: "O2" }, { audit: false });
    upsertRuntimeMember({ ...base, id: "mem_pd_o3", displayName: "O3" }, { audit: false }); // no Slack binding
    upsertRuntimeMember({ ...base, id: "mem_pd_o4", displayName: "O4", status: "disabled" }, { audit: false });
    for (const [memberId, user] of [["mem_pd_o2", "UPDO2"], ["mem_pd_o4", "UPDO4"], ["mem_1", "UPDAPPROVER"]] as const) {
      const created = await createPendingVoterBinding({ orgId: DEMO_ORG.id, provider: "slack", channelKey: slackChannel.id, externalUserId: user, memberId });
      if (created.ok) await verifyVoterBinding({ orgId: DEMO_ORG.id, provider: "slack", channelKey: slackChannel.id, externalUserId: user, verificationCode: created.verificationCode });
    }
    channels = [lineChannel, slackChannel];
    const approved = ticket({ status: "approved", approverMemberId: "mem_1", approverRole: "owner",
      metadata: { auditClass: "admin", approvalClass: "admin", isAdminMcpTool: true } });
    const result = await notifyOwnersApproverAuthorityApproved(approved);
    expect(result.owners).toBe(2); // O2 + O3; approver (mem_1) and disabled O4 excluded
    expect(result.slackDmSent).toBe(1);
    expect(result.ownersWithoutSlack).toBe(1);
    expect(result.channelPost).toEqual({ provider: "line", ok: true });
    const opened = posted.filter((p) => p.url.endsWith("conversations.open")).map((p) => p.body.users);
    expect(opened).toEqual(["UPDO2"]);
    const all = JSON.stringify(posted.map((p) => p.body));
    expect(all).toContain("事後通知");
    expect(all).not.toContain(SECRET_TITLE);
    expect(all).not.toContain(SECRET_SUMMARY);
    expect(all).not.toContain("xoxb-fixture-not-real");
  });
});

describe("オーナー追加の通知 (members.promoteOwner)", () => {
  test("every active owner (approver and new owner included) and the target; Slack DM via verified binding + LINE inbox; no title / summary", async () => {
    const base = { orgId: DEMO_ORG.id, email: "x@fixture.invalid", status: "active" as const, capabilities: [] };
    upsertRuntimeMember({ ...base, id: "mem_po_new", displayName: "NewOwner", role: "owner" }, { audit: false });
    upsertRuntimeMember({ ...base, id: "mem_po_o2", displayName: "O2", role: "owner" }, { audit: false }); // no Slack binding
    upsertRuntimeMember({ ...base, id: "mem_po_off", displayName: "Off", role: "owner", status: "disabled" }, { audit: false });
    for (const [memberId, user] of [["mem_po_new", "UPONEW"], ["mem_1", "UPOAPPROVER"], ["mem_po_off", "UPOOFF"]] as const) {
      const created = await createPendingVoterBinding({ orgId: DEMO_ORG.id, provider: "slack", channelKey: slackChannel.id, externalUserId: user, memberId });
      if (created.ok) await verifyVoterBinding({ orgId: DEMO_ORG.id, provider: "slack", channelKey: slackChannel.id, externalUserId: user, verificationCode: created.verificationCode });
    }
    channels = [lineChannel, slackChannel];
    const approved = ticket({ status: "approved", tool: "members.promoteOwner", approverMemberId: "mem_1", approverRole: "owner" });
    const result = await notifyOwnerPromoted(approved, { targetMemberId: "mem_po_new", approverMemberId: "mem_1" });
    expect(result.recipients).toBe(3); // mem_1 + mem_po_new + mem_po_o2; disabled owner excluded
    expect(result.slackDmSent).toBe(2);
    expect(result.withoutSlack).toBe(1);
    expect(result.channelPost).toEqual({ provider: "line", ok: true });
    const opened = posted.filter((p) => p.url.endsWith("conversations.open")).map((p) => p.body.users).sort();
    expect(opened).toEqual(["UPOAPPROVER", "UPONEW"]);
    const all = JSON.stringify(posted.map((p) => p.body));
    expect(all).toContain("オーナーを追加しました");
    expect(all).toContain("NewOwner");
    expect(all).not.toContain(SECRET_TITLE);
    expect(all).not.toContain(SECRET_SUMMARY);
    expect(all).not.toContain("xoxb-fixture-not-real");
  });
});
