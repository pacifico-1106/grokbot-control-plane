import { afterEach, describe, expect, test } from "bun:test";
import {
  validateOrgIssueAdminCredentialInput,
  platformIssueAdminCredential,
} from "@/lib/admin-mcp/orgs-issue-admin-credential";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin, parseAdminFulfillment } from "@/lib/admin-mcp/fulfill-admin";
import { fulfillIfApproved } from "@/lib/approvals/fulfill";
import { getApprovalById, listApprovals, listAuditEvents } from "@/lib/data";
import { DEMO_ORG } from "@/lib/demo-data";
import { getOrgAdminAgent, resetDemoAdminAgent } from "@/lib/data/admin-agents";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import { resolveApproval } from "@/lib/data/approvals";
import { ADMIN_CREDENTIAL_PREFIX } from "@/lib/mcp/admin-public";

const TARGET_ORG_ID = "6d134a38-a0ab-4a8e-aba7-3202650ff523";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_platform_ops" });
  return {
    orgId: DEMO_ORG.id,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

const envBackup = {
  emails: process.env.SUPER_ADMIN_EMAILS,
  platformOrgId: process.env.PLATFORM_OPS_ORG_ID,
};

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = envBackup.emails;
  process.env.PLATFORM_OPS_ORG_ID = envBackup.platformOrgId;
});

function allowPlatformOpsInDemo() {
  process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
  delete process.env.PLATFORM_OPS_ORG_ID;
}

describe("orgs.issueAdminCredential validation", () => {
  test("requires orgId", () => {
    const missing = validateOrgIssueAdminCredentialInput({});
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe("org_id_required");
    }

    const ok = validateOrgIssueAdminCredentialInput({ orgId: TARGET_ORG_ID });
    expect(ok.ok).toBe(true);
  });
});

describe("orgs.issueAdminCredential admin MCP", () => {
  test("rejects normal tenant without platform allowlist", async () => {
    process.env.SUPER_ADMIN_EMAILS = "ops@other-company.example";
    const result = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID },
      demoCred()
    );
    expect(result.isError).toBe(true);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.code).toBe("platform_ops_forbidden");
  });

  test("queues always_human when platform ops allowed", async () => {
    allowPlatformOpsInDemo();
    const before = (await listApprovals(DEMO_ORG.id)).length;
    const result = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID, jobId: "space-tree-adm" },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.needs_approval).toBe(true);
    expect(data.always_human).toBe(true);
    expect(data.auditAction).toBe("admin.issue_admin_credential");
    expect(data.approvalId).toBeTruthy();
    expect((await listApprovals(DEMO_ORG.id)).length).toBe(before + 1);
  });

  test("reinvoke with approvalId fulfills and mints for target org", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    await resolveApproval(
      approvalId,
      "approved",
      "human-approver@example.com",
      DEMO_ORG.id
    );

    const result = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { approvalId },
      demoCred()
    );
    expect(Boolean(result.isError)).toBe(false);
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.orgId).toBe(TARGET_ORG_ID);
    expect(data.secretPrefix).toBeTruthy();
    expect(String(data.oneTimeSecret || "")).toMatch(/^gb_adm_/);
    expect(data.nextStepJa).toBeTruthy();
    expect(data.needs_approval).toBeUndefined();

    const agent = await getOrgAdminAgent(TARGET_ORG_ID);
    expect(agent?.orgId).toBe(TARGET_ORG_ID);
    expect(agent?.secretPrefix).toBe(data.secretPrefix);
  });

  test("fulfillment never stores raw secret in audit metadata", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    const pending = await getApprovalById(approvalId, DEMO_ORG.id);
    expect(pending).toBeTruthy();
    const mutation = (pending?.metadata?.adminMutation || {}) as Record<string, unknown>;
    expect(mutation.targetOrgId).toBe(TARGET_ORG_ID);
    expect(mutation.oneTimeSecret).toBeUndefined();

    const approved = await resolveApproval(
      approvalId,
      "approved",
      "human-approver@example.com",
      DEMO_ORG.id
    );
    const fulfillment = await fulfillApprovedAdmin(approved!);
    expect(fulfillment?.ok).toBe(true);
    expect(fulfillment?.orgId).toBe(TARGET_ORG_ID);
    expect(fulfillment?.oneTimeSecret).toMatch(/^gb_adm_/);

    const audits = await listAuditEvents(DEMO_ORG.id, 20);
    const fulfillAudit = audits.find((event) => event.action === "admin.issue_admin_credential");
    expect(fulfillAudit).toBeTruthy();
    expect(JSON.stringify(fulfillAudit?.metadata || {})).not.toMatch(
      /gb_adm_[a-f0-9]{16}_[a-f0-9]{32}/
    );
    expect(fulfillAudit?.metadata).toMatchObject({
      auditClass: "admin",
      targetOrgId: TARGET_ORG_ID,
      secretPrefix: fulfillment?.secretPrefix,
    });
  });

  test("platformIssueAdminCredential mints for target org not caller org", async () => {
    const issued = await platformIssueAdminCredential(TARGET_ORG_ID, {
      email: "owner@example.com",
      userId: null,
      orgId: DEMO_ORG.id,
    });
    expect(issued.targetOrgId).toBe(TARGET_ORG_ID);
    expect(issued.oneTimeSecret.startsWith(ADMIN_CREDENTIAL_PREFIX)).toBe(true);
    expect(issued.secretPrefix.startsWith(ADMIN_CREDENTIAL_PREFIX)).toBe(true);

    const agent = await getOrgAdminAgent(TARGET_ORG_ID);
    expect(agent?.orgId).toBe(TARGET_ORG_ID);
    expect(agent?.orgId).not.toBe(DEMO_ORG.id);
  });

  test("fulfillIfApproved auto-fulfills Admin MCP on approve (webhook path)", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );
    expect(approvalId).toBeTruthy();

    const approved = await resolveApproval(
      approvalId,
      "approved",
      "telegram:123456",
      DEMO_ORG.id
    );
    expect(approved).toBeTruthy();
    expect(approved!.status).toBe("approved");

    const fulfillment = await fulfillIfApproved(approved!, "approved");
    expect(fulfillment).toBeTruthy();
    expect(fulfillment!.ok).toBe(true);
    expect(fulfillment!.delivery).toBe("stub");

    const stored = await getApprovalById(approvalId, DEMO_ORG.id);
    const adminFulfillment = parseAdminFulfillment(stored?.metadata);
    expect(adminFulfillment).toBeTruthy();
    expect(adminFulfillment!.ok).toBe(true);
    expect(adminFulfillment!.orgId).toBe(TARGET_ORG_ID);
    expect(adminFulfillment!.oneTimeSecret).toMatch(/^gb_adm_/);

    const agent = await getOrgAdminAgent(TARGET_ORG_ID);
    expect(agent?.orgId).toBe(TARGET_ORG_ID);
  });

  test("fulfillIfApproved does not re-fulfill already fulfilled Admin MCP", async () => {
    allowPlatformOpsInDemo();
    const queued = await callAdminMcpTool(
      "orgs.issueAdminCredential",
      { orgId: TARGET_ORG_ID },
      demoCred()
    );
    const approvalId = String(
      (queued.structuredContent as Record<string, unknown>).approvalId || ""
    );

    const approved = await resolveApproval(
      approvalId,
      "approved",
      "telegram:123456",
      DEMO_ORG.id
    );

    const first = await fulfillIfApproved(approved!, "approved");
    expect(first!.ok).toBe(true);

    const storedFirst = await getApprovalById(approvalId, DEMO_ORG.id);
    const firstSecret = parseAdminFulfillment(storedFirst?.metadata)?.oneTimeSecret;
    expect(firstSecret).toMatch(/^gb_adm_/);

    const second = await fulfillIfApproved(approved!, "approved");
    expect(second!.ok).toBe(true);

    const storedSecond = await getApprovalById(approvalId, DEMO_ORG.id);
    const secondSecret = parseAdminFulfillment(storedSecond?.metadata)?.oneTimeSecret;
    expect(secondSecret).toBe(firstSecret);
  });
});
