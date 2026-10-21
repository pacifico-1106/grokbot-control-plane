/**
 * admin.policy (and other admin fulfill audits) must record the human
 * approver's email on actor_email. The requester is an admin_agent, so
 * without an explicit approver email the column stays empty.
 */
import { describe, expect, test } from "bun:test";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { listEmployees, resolveApproval } from "@/lib/data";
import { listAuditEvents } from "@/lib/data/audit";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { AuditAction } from "@/lib/types";

function demoCred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({
    grokBotAgentId: "grok_admin_demo",
    status: "linked",
  });
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

const APPROVER = "reviewer@example.com";

async function queueApproveFulfill(
  tool: string,
  args: Record<string, unknown>
): Promise<{ approvalId: string; audits: Awaited<ReturnType<typeof listAuditEvents>> }> {
  const cred = demoCred();
  const queued = await callAdminMcpTool(tool, args, cred);
  const approvalId = String((queued.structuredContent as Record<string, unknown>).approvalId || "");
  expect(approvalId).toBeTruthy();
  const approved = await resolveApproval(approvalId, "approved", APPROVER, cred.orgId, {
    actorId: "mem_reviewer",
  });
  expect(approved).toBeTruthy();
  const fulfillment = await fulfillApprovedAdmin(approved!);
  expect(fulfillment?.ok).toBe(true);
  return { approvalId, audits: await listAuditEvents(DEMO_ORG.id, 80) };
}

function fulfillRows(
  audits: Awaited<ReturnType<typeof listAuditEvents>>,
  approvalId: string,
  action: AuditAction
) {
  return audits.filter(
    (row) =>
      row.action === action &&
      row.metadata?.approvalId === approvalId &&
      !String(row.summary || "").startsWith("承認待ち")
  );
}

describe("admin.policy fulfill audit records actor_email", () => {
  test("policy.patch writes the human approver email", async () => {
    const [employee] = await listEmployees(DEMO_ORG.id);
    const { approvalId, audits } = await queueApproveFulfill("policy.patch", {
      employeeId: employee.id,
      scopes: employee.scopes,
      allowedPurposes: employee.allowedPurposes,
      approvalPolicy: employee.approvalPolicy,
    });
    const rows = fulfillRows(audits, approvalId, "admin.policy");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.actorEmail === APPROVER)).toBe(true);
  });

  test("internalAudienceRule.patch writes the same approver email", async () => {
    const { approvalId, audits } = await queueApproveFulfill("internalAudienceRule.patch", {
      emailDomains: ["actor-email.example"],
    });
    const rows = fulfillRows(audits, approvalId, "admin.policy");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.actorEmail === APPROVER)).toBe(true);
  });

  test("other admin fulfill audits have the same actor_email", async () => {
    const { approvalId, audits } = await queueApproveFulfill("employees.issue", {
      displayName: "監査メール確認",
      roleLabel: "事務",
      scopes: ["tools:read", "audit:append"],
    });
    const rows = fulfillRows(audits, approvalId, "admin.hire");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.actorEmail === APPROVER)).toBe(true);
  });
});
