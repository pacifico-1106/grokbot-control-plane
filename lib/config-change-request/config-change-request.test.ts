import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import {
  STAFFPASS_MCP_TOOLS,
  callStaffpassMcpTool,
  listStaffpassMcpTools,
} from "@/lib/mcp/tools";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getApprovalById, resolveApproval } from "@/lib/data/approvals";
import { listAuditEvents } from "@/lib/data/audit";
import { getOrgChannel, upsertOrgChannel } from "@/lib/data/directory";
import { fulfillApprovedInvoke, fulfillIfApproved } from "@/lib/approvals/fulfill";
import { runApprovalResolveSideEffects } from "@/lib/approvals/resolve-side-effects";
import { applyChannelClassification } from "@/lib/admin-mcp/channel-classify";
import { buildHireInstructionsSnippet, SELF_CONFIG_CHANGE_RULE } from "@/lib/employees/approval-loop-copy";
import { getEmployee } from "@/lib/data/employees";
import {
  CONFIG_CHANGE_MCP_TOOL,
  CONFIG_CHANGE_TOOL,
  buildApproverMessageJa,
  buildDiff,
  buildRequesterNoticeJa,
  diffLines,
  hashText,
  isBlockedSettingKind,
  parseConfigChangeInput,
} from "@/lib/config-change-request/core";
import {
  createConfigChangeRequest,
  getApprovedInstructions,
  isPendingConfigChange,
  recordConfigChangeResolution,
  type ConfigChangeDeps,
  type CreateConfigChangeResult,
  type PendingConfigChange,
} from "@/lib/config-change-request/service";

function assertPending(result: CreateConfigChangeResult): asserts result is PendingConfigChange {
  if (!isPendingConfigChange(result)) throw new Error(`expected needs_approval, got ${result.code}`);
}

const FLAG = "P1_CONFIG_CHANGE_REQUEST_ENABLED";
const ORG = DEMO_ORG.id;
const flagBackup = process.env[FLAG];
const superAdminBackup = process.env.SUPER_ADMIN_EMAILS;

function flagOn() {
  process.env[FLAG] = "1";
}
function flagOff() {
  delete process.env[FLAG];
}

beforeEach(() => flagOff());
afterEach(() => {
  if (flagBackup === undefined) delete process.env[FLAG];
  else process.env[FLAG] = flagBackup;
  if (superAdminBackup === undefined) delete process.env.SUPER_ADMIN_EMAILS;
  else process.env.SUPER_ADMIN_EMAILS = superAdminBackup;
});

const notified: string[] = [];
const okDeps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: true, surface: "slack_dm", channelId: "nc_test" }),
  notify: async (approval) => {
    notified.push(approval.id);
    return true;
  },
};
const noApproverDeps: Partial<ConfigChangeDeps> = {
  resolveApprover: async () => ({ ok: false, reason: "no_approver_channel" }),
  notify: async () => {
    throw new Error("must_not_notify");
  },
};

let seq = 0;
function uniq(prefix: string) {
  seq += 1;
  return `${prefix}${Date.now().toString(36).toUpperCase()}${seq}`;
}

function demoCred(employeeId: string): ResolvedEmployeeCredential {
  return {
    employeeId,
    orgId: ORG,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId,
      orgId: ORG,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}

function demoAdminCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return {
    orgId: ORG,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

const requester = { name: "田中", slackUserId: "U0TANAKA" };

async function auditActions(): Promise<Array<{ action: string; metadata: Record<string, unknown> }>> {
  const events = await listAuditEvents(ORG, 5000);
  return events.map((e) => ({ action: e.action, metadata: (e.metadata || {}) as Record<string, unknown> }));
}

async function approveAndFulfil(approvalId: string) {
  const approved = await resolveApproval(approvalId, "approved", "owner@example.com", ORG, { actorId: "user_owner" });
  expect(approved?.status).toBe("approved");
  const fulfil = await fulfillIfApproved(approved!, "approved");
  return { approved: approved!, fulfil };
}

describe("core (pure)", () => {
  test("blocked kinds and parsing", () => {
    for (const kind of ["approvers", "permissions", "billing", "scopes", "approval.policy", "plan"]) {
      expect(isBlockedSettingKind(kind)).toBe(true);
    }
    expect(isBlockedSettingKind("instructions")).toBe(false);
    const parsed = parseConfigChangeInput({
      kind: "channel_classification",
      jobId: "j1",
      requestedBy: requester,
      channel: { externalId: "C1", classification: "shared_external" },
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.proposal.kind === "channel_classification") {
      expect(parsed.value.proposal.mixed).toBe(true);
      expect(parsed.value.proposal.surface).toBe("slack");
    }
    expect(parseConfigChangeInput({ kind: "instructions", jobId: "j" }).ok).toBe(false);
    expect(parseConfigChangeInput({ kind: "instructions", instructions: { text: "x" } }).ok).toBe(false);
    const unknown = parseConfigChangeInput({ kind: "voice", jobId: "j" });
    expect(!unknown.ok && unknown.code).toBe("unsupported_kind");
  });

  test("diff and copy", () => {
    expect(diffLines("a\nb", "a\nc")).toEqual(["- b", "+ c"]);
    const diff = buildDiff(
      { kind: "channel_classification", surface: "slack", externalId: "C9", classification: "internal", mixed: false, slackTeamId: null },
      { kind: "channel", exists: false, classification: null, mixed: false, channelId: null }
    );
    expect(diff.summaryJa).toContain("未登録");
    expect(diff.summaryJa).toContain("C9");
    const msg = buildApproverMessageJa({ requester: { name: "田中", slackUserId: null, email: null }, employeeDisplayName: "営業AI", diffSummaryJa: diff.summaryJa, reason: null });
    expect(msg.startsWith("田中さんから次の変更依頼が来ています: ")).toBe(true);
    expect(msg).toContain("反映しますか？");
    const notice = buildRequesterNoticeJa({ requester: { name: "田中", slackUserId: null, email: null }, diffSummaryJa: "x", outcome: "rejected" });
    expect(notice).toContain("田中さん");
    expect(notice).toContain("見送");
  });
});

describe("flag OFF → behaviour unchanged", () => {
  test("tool is not listed and calls are refused without side effects", async () => {
    flagOff();
    expect(listStaffpassMcpTools()).toBe(STAFFPASS_MCP_TOOLS);
    expect(listStaffpassMcpTools().some((t) => t.name === CONFIG_CHANGE_MCP_TOOL)).toBe(false);
    const res = await callStaffpassMcpTool(
      CONFIG_CHANGE_MCP_TOOL,
      { kind: "instructions", jobId: "j-off", instructions: { text: "x" } },
      demoCred("emp_ops")
    );
    expect(res.isError).toBe(true);
    expect((res.structuredContent as Record<string, unknown>).code).toBe("feature_disabled");
    const direct = await createConfigChangeRequest(
      { orgId: ORG, employeeId: "emp_ops", credentialId: null, args: { kind: "instructions", jobId: "j", instructions: { text: "x" } } },
      okDeps
    );
    expect(direct.code).toBe("feature_disabled");
    const who = await callStaffpassMcpTool("staffpass_whoami", {}, demoCred("emp_ops"));
    const whoData = who.structuredContent as Record<string, unknown>;
    expect(whoData.approvedInstructions).toBeUndefined();
    expect(whoData.configChangeRuleJa).toBeUndefined();
    const emp = await getEmployee("emp_ops", ORG);
    const snippet = buildHireInstructionsSnippet({ displayName: emp!.displayName, roleLabel: emp!.roleLabel });
    expect(snippet).not.toContain(SELF_CONFIG_CHANGE_RULE);
  });
});

describe("flag ON → pending approval, nothing applied until approved", () => {
  test("instructions: pending → approve applies exactly the proposal + audit", async () => {
    flagOn();
    const empId = "emp_sales";
    expect(listStaffpassMcpTools().some((t) => t.name === CONFIG_CHANGE_MCP_TOOL)).toBe(true);
    const created = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: empId,
        credentialId: `cred_${empId}`,
        args: {
          kind: "instructions",
          jobId: uniq("job-"),
          requestedBy: requester,
          reason: "敬語を統一したい",
          instructions: { mode: "replace", text: "お客様には必ず敬語で返信する。" },
        },
      },
      okDeps
    );
    expect(created.code).toBe("needs_approval");
    assertPending(created);
    expect(created.applied).toBe(false);
    expect(created.summary.startsWith("田中さんから次の変更依頼が来ています: ")).toBe(true);
    expect(created.summary).toContain("反映しますか？");
    expect(notified).toContain(created.approvalId);

    // Not applied while pending.
    expect(await getApprovedInstructions(ORG, empId)).toBeNull();
    const pending = await getApprovalById(created.approvalId, ORG);
    expect(pending?.status).toBe("pending");
    expect(pending?.tool).toBe(CONFIG_CHANGE_TOOL);

    const { fulfil } = await approveAndFulfil(created.approvalId);
    expect(fulfil?.ok).toBe(true);
    const overlay = await getApprovedInstructions(ORG, empId);
    expect(overlay?.text).toBe("お客様には必ず敬語で返信する。");
    expect(overlay?.approvalId).toBe(created.approvalId);

    // Applied exactly once (second fulfil is a no-op).
    const again = await fulfillApprovedInvoke((await getApprovalById(created.approvalId, ORG))!);
    expect(again?.ok).toBe(true);

    const audits = await auditActions();
    expect(audits.some((a) => a.action === "config.change_requested" && a.metadata.approvalId === created.approvalId)).toBe(true);
    expect(audits.filter((a) => a.action === "config.change_applied" && a.metadata.approvalId === created.approvalId).length).toBe(1);

    // whoami delivers the approved overlay + rule; poll says applied.
    const who = await callStaffpassMcpTool("staffpass_whoami", {}, demoCred(empId));
    const whoData = who.structuredContent as Record<string, unknown>;
    expect((whoData.approvedInstructions as Record<string, unknown>).text).toBe("お客様には必ず敬語で返信する。");
    expect(typeof whoData.configChangeRuleJa).toBe("string");
    const poll = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approvalId, statusToken: created.statusToken },
      demoCred(empId)
    );
    const pollData = poll.structuredContent as Record<string, unknown>;
    expect(pollData.status).toBe("approved");
    expect(pollData.pollHint).toBe("fulfilled");
    expect((pollData.configChange as Record<string, unknown>).applied).toBe(true);
    expect(String(pollData.requesterNoticeJa)).toContain("反映しました");

    // Append on top of the approved base, then a stale ticket is not applied.
    const append = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "instructions", jobId: uniq("job-"), requestedBy: requester, instructions: { mode: "append", text: "絵文字は使わない。" } } },
      okDeps
    );
    const stale = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "instructions", jobId: uniq("job-"), requestedBy: requester, instructions: { mode: "append", text: "署名を付ける。" } } },
      okDeps
    );
    assertPending(append);
    assertPending(stale);
    expect((await approveAndFulfil(append.approvalId)).fulfil?.ok).toBe(true);
    expect((await getApprovedInstructions(ORG, empId))?.text).toBe("お客様には必ず敬語で返信する。\n絵文字は使わない。");
    const staleResult = await approveAndFulfil(stale.approvalId);
    expect(staleResult.fulfil?.ok).toBe(false);
    expect(staleResult.fulfil?.error).toBe("stale_base");
    expect((await getApprovedInstructions(ORG, empId))?.text).toBe("お客様には必ず敬語で返信する。\n絵文字は使わない。");
    expect((await auditActions()).some((a) => a.action === "config.change_apply_failed" && a.metadata.approvalId === stale.approvalId)).toBe(true);
  });

  test("channel classification via MCP: pending → approve applies", async () => {
    flagOn();
    const empId = "emp_comm";
    const channelId = uniq("C");
    const res = await callStaffpassMcpTool(
      CONFIG_CHANGE_MCP_TOOL,
      {
        kind: "channel_classification",
        jobId: uniq("job-"),
        requestedBy: requester,
        channel: { surface: "slack", externalId: channelId, classification: "internal" },
        conversation: { surface: "slack", slackChannelId: channelId, threadTs: "1700000000.0001" },
      },
      demoCred(empId)
    );
    // Default deps: demo org must resolve an approver or refuse — either way nothing is applied.
    const data = res.structuredContent as Record<string, unknown>;
    expect(data.applied).toBe(false);
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();

    const created = await createConfigChangeRequest(
      {
        orgId: ORG,
        employeeId: empId,
        credentialId: null,
        args: { kind: "channel_classification", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId, classification: "internal" } },
      },
      okDeps
    );
    assertPending(created);
    expect(created.diffSummaryJa).toContain("未登録 → 社内");
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();

    const { fulfil } = await approveAndFulfil(created.approvalId);
    expect(fulfil?.ok).toBe(true);
    const channel = await getOrgChannel(ORG, "slack", channelId);
    expect(channel?.classification).toBe("internal");
    expect((await auditActions()).some((a) => a.action === "config.change_applied" && a.metadata.approvalId === created.approvalId)).toBe(true);

    // Remove → pending → approve removes.
    const removal = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "channel_remove", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId } } },
      okDeps
    );
    assertPending(removal);
    expect(await getOrgChannel(ORG, "slack", channelId)).not.toBeNull();
    expect((await approveAndFulfil(removal.approvalId)).fulfil?.ok).toBe(true);
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();
  });

  test("Connect/shared channel cannot be requested as internal", async () => {
    flagOn();
    const channelId = uniq("C");
    await upsertOrgChannel({ orgId: ORG, surface: "slack", externalId: channelId, classification: "shared_external", mixed: true });
    const res = await createConfigChangeRequest(
      { orgId: ORG, employeeId: "emp_comm", credentialId: null, args: { kind: "channel_classification", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId, classification: "internal" } } },
      okDeps
    );
    expect(res.code).toBe("connect_cannot_be_internal");
    expect((await getOrgChannel(ORG, "slack", channelId))?.classification).toBe("shared_external");
  });

  test("reject → not applied, audited, polite requester notice", async () => {
    flagOn();
    const empId = "emp_sns";
    const channelId = uniq("C");
    const created = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "channel_classification", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId, classification: "internal" } } },
      okDeps
    );
    const instr = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "instructions", jobId: uniq("job-"), requestedBy: requester, instructions: { text: "勝手な指示" } } },
      okDeps
    );
    assertPending(created);
    assertPending(instr);

    const rejected = await resolveApproval(created.approvalId, "rejected", "owner@example.com", ORG, { actorId: "user_owner" });
    expect(rejected?.status).toBe("rejected");
    expect(await fulfillIfApproved(rejected!, "rejected")).toBeNull();
    expect(await fulfillApprovedInvoke(rejected!)).toBeNull();
    const employee = await getEmployee(empId, ORG);
    await runApprovalResolveSideEffects({ approval: rejected!, decision: "rejected", actorEmail: "owner@example.com", employee });
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();

    const rejectedInstr = await resolveApproval(instr.approvalId, "rejected", "owner@example.com", ORG, { actorId: "user_owner" });
    const resolution = await recordConfigChangeResolution({ approval: rejectedInstr!, decision: "rejected", actorEmail: "owner@example.com" });
    expect(resolution.requesterNoticeJa).toContain("田中さん");
    expect(await getApprovedInstructions(ORG, empId)).toBeNull();

    const audits = await auditActions();
    const rej = audits.find((a) => a.action === "config.change_rejected" && a.metadata.approvalId === created.approvalId);
    expect(rej?.metadata.applied).toBe(false);
    expect(audits.some((a) => a.action === "config.change_applied" && a.metadata.approvalId === created.approvalId)).toBe(false);

    const poll = await callStaffpassMcpTool(
      "staffpass_get_approval_status",
      { approvalId: created.approvalId, statusToken: created.statusToken },
      demoCred(empId)
    );
    const pollData = poll.structuredContent as Record<string, unknown>;
    expect(pollData.status).toBe("rejected");
    expect(pollData.pollHint).toBe("abort_job");
    expect(String(pollData.requesterNoticeJa)).toContain("見送");
    expect((pollData.configChange as Record<string, unknown>).applied).toBe(false);
  });

  test("no resolvable approver → refused (fail-closed), nothing created", async () => {
    flagOn();
    const empId = "emp_ops";
    const channelId = uniq("C");
    const res = await createConfigChangeRequest(
      { orgId: ORG, employeeId: empId, credentialId: null, args: { kind: "channel_classification", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId, classification: "internal" } } },
      noApproverDeps
    );
    expect(res.ok).toBe(false);
    expect(res.code).toBe("no_approver_resolvable");
    expect(res.applied).toBe(false);
    expect("approvalId" in res).toBe(false);
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();
    expect((await auditActions()).some((a) => a.action === "config.change_refused" && a.metadata.code === "no_approver_resolvable")).toBe(true);
  });

  test("blocked settings stay blocked (approvers / permissions / billing)", async () => {
    flagOn();
    for (const kind of ["approvers", "permissions", "billing"]) {
      const res = await createConfigChangeRequest(
        { orgId: ORG, employeeId: "emp_ops", credentialId: null, args: { kind, jobId: uniq("job-"), requestedBy: requester } },
        okDeps
      );
      expect(res.code).toBe("blocked_setting");
      expect(res.applied).toBe(false);
    }
  });

  test("flag turned OFF after approval → not applied (rollback)", async () => {
    flagOn();
    const channelId = uniq("C");
    const created = await createConfigChangeRequest(
      { orgId: ORG, employeeId: "emp_ops", credentialId: null, args: { kind: "channel_classification", jobId: uniq("job-"), requestedBy: requester, channel: { externalId: channelId, classification: "internal" } } },
      okDeps
    );
    assertPending(created);
    flagOff();
    const { fulfil } = await approveAndFulfil(created.approvalId);
    expect(fulfil?.ok).toBe(false);
    expect(fulfil?.error).toBe("feature_disabled");
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();
  });
});

describe("human / admin paths are not gated by this feature", () => {
  test("direct (human-approved) classification helper applies immediately with flag ON", async () => {
    flagOn();
    const channelId = uniq("C");
    const { channel } = await applyChannelClassification({ orgId: ORG, surface: "slack", externalId: channelId, classification: "internal", mixed: false });
    expect(channel.classification).toBe("internal");
    expect((await getOrgChannel(ORG, "slack", channelId))?.classification).toBe("internal");
  });

  test("admin MCP channels.classify keeps its existing always_human queue (with a diff summary when ON)", async () => {
    flagOn();
    process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
    const channelId = uniq("C");
    const queued = await callAdminMcpTool(
      "channels.classify",
      { surface: "slack", externalId: channelId, classification: "internal" },
      demoAdminCred()
    );
    const data = queued.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(String(data.summary || "")).toContain("反映しますか？");
    expect(await getOrgChannel(ORG, "slack", channelId)).toBeNull();
  });

  test("hire snippet carries the self-config rule only when ON", async () => {
    flagOn();
    const snippet = buildHireInstructionsSnippet({ displayName: "x", roleLabel: "y" });
    expect(snippet).toContain(SELF_CONFIG_CHANGE_RULE);
    expect(hashText("a")).toHaveLength(64);
  });
});
