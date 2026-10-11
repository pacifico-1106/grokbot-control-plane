/**
 * #332 follow-up (木村 2026-10-12): the reissue pickup claim is atomic.
 * - claimCredentialReissueTicket: conditional "set the mark only if unclaimed"
 *   (DB: public.claim_credential_reissue, migration 20261012200000; demo: the
 *   same compare-and-set in process). Two concurrent pickups → one rotate.
 * - releaseCredentialReissueTicket releases only the mark set with the same
 *   claim token (and org). A failed rotate releases its own mark only.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { rotateCredential as demoRotate, getBinding } from "@/lib/bindings";
import { getApprovalById, resolveApproval } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { claimCredentialReissueTicket, releaseCredentialReissueTicket } from "@/lib/data/credential-reissue-claims";
import { DEMO_ORG, getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { redeemCredentialReissue } from "@/lib/employees/credential-reissue";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { Employee } from "@/lib/types";

const TOOL = "employees.credential.reissue";
const FLAG = "ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED";
const ORG_A = DEMO_ORG.id;
const ORG_B = "org_reissue_atomic_other";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_atomic" };
const actor = { memberId: HUMAN.memberId, email: HUMAN.email };
let seq = 0;

function cred(): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_atomic", status: "linked" });
  return { orgId: ORG_A, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer", agent };
}
function newEmployee(): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = { ...base, id: `emp_at_${Date.now().toString(36)}_${seq}`, orgId: ORG_A, status: "active", scopes: ["tools:read"], credentialId: `cred_at_${seq}`, credentialExpiresAt: "2026-09-23T00:00:00.000Z" };
  getRuntimeEmployees().push(employee);
  demoRotate(employee.id, ORG_A, `fp_at_old_${seq}`);
  return employee;
}
async function approvedTicket(emp: Employee): Promise<string> {
  const q = (await callAdminMcpTool(TOOL, { employeeId: emp.id, reason: "expired" }, cred())).structuredContent as Record<string, unknown>;
  expect(q.code).toBe("needs_approval");
  const approved = await resolveApproval(String(q.approvalId), "approved", HUMAN.email, ORG_A, { actorId: HUMAN.memberId });
  expect((await fulfillApprovedAdmin(approved!))?.ok).toBe(true);
  return String(q.approvalId);
}

beforeEach(() => {
  process.env[FLAG] = "1";
});
afterEach(() => {
  delete process.env[FLAG];
});

describe("redeem: concurrent pickups", () => {
  test("two concurrent pickups → exactly one rotate (generation +1 once, one credential.rotated row), the other reissue_approval_used", async () => {
    const emp = newEmployee();
    const approvalId = await approvedTicket(emp);
    const gen = getBinding(emp.id)!.credentialGeneration;
    const results = await Promise.all([
      redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor }),
      redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor: { memberId: "mem_other", email: "other@example.com" } }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, code: "reissue_approval_used" });
    expect(getBinding(emp.id)!.credentialGeneration).toBe(gen + 1);
    expect(getRuntimeAudit().filter((e) => e.action === "credential.rotated" && e.metadata?.reissueApprovalId === approvalId)).toHaveLength(1);
  });
  test("five concurrent pickups → one rotate", async () => {
    const emp = newEmployee();
    const approvalId = await approvedTicket(emp);
    const gen = getBinding(emp.id)!.credentialGeneration;
    const results = await Promise.all(Array.from({ length: 5 }, () => redeemCredentialReissue({ orgId: ORG_A, employeeId: emp.id, approvalId, actor })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(getBinding(emp.id)!.credentialGeneration).toBe(gen + 1);
  });
});

describe("claim / release primitives", () => {
  test("claim once; second claim false; release with the wrong token refused (mark kept); own token releases", async () => {
    const emp = newEmployee();
    const approvalId = await approvedTicket(emp);
    const at = new Date().toISOString();
    expect(await claimCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_a_0123456789abcdef", memberId: "m1", at })).toBe(true);
    expect(await claimCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_b_0123456789abcdef", memberId: "m2", at })).toBe(false);
    expect(await releaseCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_b_0123456789abcdef" })).toBe(false);
    const kept = (await getApprovalById(approvalId, ORG_A))!.metadata.credentialReissue as Record<string, unknown>;
    expect(kept).toMatchObject({ redeemedByMemberId: "m1", redeemedAt: at });
    expect(await releaseCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_a_0123456789abcdef" })).toBe(true);
    expect(await claimCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_c_0123456789abcdef", memberId: "m3", at })).toBe(true);
  });
  test("another org: claim and release refused", async () => {
    const emp = newEmployee();
    const approvalId = await approvedTicket(emp);
    const at = new Date().toISOString();
    expect(await claimCredentialReissueTicket({ approvalId, orgId: ORG_B, token: "tok_x_0123456789abcdef", memberId: "m", at })).toBe(false);
    expect(await claimCredentialReissueTicket({ approvalId, orgId: ORG_A, token: "tok_y_0123456789abcdef", memberId: "m", at })).toBe(true);
    expect(await releaseCredentialReissueTicket({ approvalId, orgId: ORG_B, token: "tok_y_0123456789abcdef" })).toBe(false);
  });
});

describe("production path uses the DB functions", () => {
  test("claim → rpc claim_credential_reissue (boolean), release → rpc release_credential_reissue with the same token; never merge_approval_metadata", async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    let claimResult: unknown = true;
    mock.module("@/lib/mode", () => ({ isDemoMode: () => false }));
    mock.module("@/lib/supabase", () => ({
      createSupabaseAdminClient: () => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          calls.push({ fn, args });
          return { data: fn === "claim_credential_reissue" ? claimResult : true, error: null };
        },
      }),
    }));
    const mod = await import(`@/lib/data/credential-reissue-claims?prod=${Date.now()}`);
    const at = "2026-10-12T00:00:00.000Z";
    expect(await mod.claimCredentialReissueTicket({ approvalId: "a1", orgId: "o1", token: "tok_p_0123456789abcdef", memberId: "m1", at })).toBe(true);
    claimResult = false;
    expect(await mod.claimCredentialReissueTicket({ approvalId: "a1", orgId: "o1", token: "tok_q_0123456789abcdef", memberId: "m2", at })).toBe(false);
    expect(await mod.releaseCredentialReissueTicket({ approvalId: "a1", orgId: "o1", token: "tok_p_0123456789abcdef" })).toBe(true);
    expect(calls[0]).toEqual({ fn: "claim_credential_reissue", args: { p_id: "a1", p_org: "o1", p_token: "tok_p_0123456789abcdef", p_member: "m1", p_at: at } });
    expect(calls[2]).toEqual({ fn: "release_credential_reissue", args: { p_id: "a1", p_org: "o1", p_token: "tok_p_0123456789abcdef" } });
    expect(calls.some((c) => c.fn === "merge_approval_metadata")).toBe(false);
  });
});
