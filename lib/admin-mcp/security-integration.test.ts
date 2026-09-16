import { test, expect } from "bun:test";
import { callAdminMcpTool, readApprovedAdminResult } from "@/lib/mcp/admin-tools";
import { getApprovalById, resolveApproval, updateApprovalMetadata } from "@/lib/data/approvals";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getOrgInternalAudienceRule } from "@/lib/data/internal-audience-rule";
import { fulfillApprovedAdmin } from "./fulfill-admin";
import { DEMO_ORG } from "@/lib/demo-data";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
function credential(): ResolvedAdminCredential {
 const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_demo", status: "linked" });
 return { orgId: agent.orgId, actorId: agent.id, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId,
 generation: agent.credentialGeneration, agent, via: "bearer" };
}
test("internal rule applies only after approval and preserves omitted fields", async () => {
 const cred = credential();
 const queue = await callAdminMcpTool("internalAudienceRule.patch", { emailDomains: ["example.com"], orgId: "other" }, cred);
 const id = String((queue.structuredContent as Record<string, unknown>).approvalId);
 expect((await getOrgInternalAudienceRule(cred.orgId)).emailDomains).toEqual([]);
 const approved = await resolveApproval(id, "approved", "reviewer@example.com", cred.orgId, { actorId: "reviewer" });
 expect(approved).toBeTruthy();
 expect((await fulfillApprovedAdmin(approved!))?.ok).toBe(true);
 expect((await getOrgInternalAudienceRule(cred.orgId)).emailDomains).toEqual(["example.com"]);
 expect((await readApprovedAdminResult(cred,id))?.ok).toBe(true);
 expect(await readApprovedAdminResult({ ...cred, generation: cred.generation + 1 },id)).toBeNull();
 expect(await readApprovedAdminResult({ ...cred, actorId: "other" },id)).toBeNull();
 expect(await readApprovedAdminResult({ ...cred, orgId: "other" },id)).toBeNull();
});
test("proxy dispatch is reachable and rejects self approval without changing the ticket", async () => {
 process.env.SUPER_ADMIN_EMAILS = "owner@example.com";
 const cred = credential();
 const queue = await callAdminMcpTool("internalAudienceRule.patch", { slackTeamIds: ["TTEST"] }, cred);
 const id = String((queue.structuredContent as Record<string, unknown>).approvalId);
 const denied = await callAdminMcpTool("approvals.proxyResolve", { orgId: DEMO_ORG.id, approvalId: id, decision: "approved", mandate: "setup" }, cred);
 expect((denied.structuredContent as Record<string, unknown>).code).toBe("self_approval_denied");
 expect((await getApprovalById(id, cred.orgId))?.status).toBe("pending");
 delete process.env.SUPER_ADMIN_EMAILS;
 const platform = await callAdminMcpTool("orgs.create", { approvalId: id }, cred);
 expect((platform.structuredContent as Record<string, unknown>).code).toBe("platform_ops_forbidden");
});
test("one-time result is consumed atomically, including concurrent readers and stale metadata saves", async () => {
 const cred = credential();
 const queue = await callAdminMcpTool("internalAudienceRule.patch", { slackTeamIds: ["TTEST"] }, cred);
 const id = String((queue.structuredContent as Record<string, unknown>).approvalId);
 const approved = await resolveApproval(id, "approved", "reviewer@example.com", cred.orgId, { actorId: "reviewer" });
 const secret = { ok: true, tool: "internalAudienceRule.patch", at: new Date().toISOString(), oneTimeSecret: "fixture-only" };
 const saved = await updateApprovalMetadata(approved!, { fulfillment: secret, adminFulfillment: secret });
 const results = await Promise.all([readApprovedAdminResult(cred,id),readApprovedAdminResult(cred,id)]);
 expect(results.filter(r => r?.oneTimeSecret === "fixture-only").length).toBe(1);
 await updateApprovalMetadata(saved!, saved!.metadata);
 expect((await readApprovedAdminResult(cred,id))?.oneTimeSecret).toBeUndefined();
 expect(JSON.stringify((await getApprovalById(id,cred.orgId))?.metadata).includes("fixture-only")).toBe(false);
});
