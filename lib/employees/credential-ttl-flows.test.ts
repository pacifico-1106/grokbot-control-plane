/**
 * 八坂さん 2026-10-12: 90-day 社員証 in the demo flows (the same code paths
 * production uses for the decision; the DB insert is pinned in
 * lib/data/credential-ttl-rotate.test.ts).
 *  - admin MCP employees.issue fulfil: default now + 90 days
 *  - rotate (lib/data rotateCredential): the employee's current 社員証 expiry
 *    becomes now + 90 days — covers POST rotate and the reissue pickup
 *  - reissue pickup (redeemCredentialReissue): now + 90 days
 */
import { afterEach, describe, expect, test } from "bun:test";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { rotateCredential as demoRotate } from "@/lib/bindings";
import { createApproval, resolveApproval, rotateCredential } from "@/lib/data";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { redeemCredentialReissue } from "@/lib/employees/credential-reissue";
import type { Employee } from "@/lib/types";

const DAY = 86_400_000;
const ORG = DEMO_ORG.id;
const HUMAN = { email: "owner@example.com", memberId: "mem_ttl" };
let seq = 0;
const within = (iso: string | null | undefined, before: number, after: number, days: number) => {
  const at = Date.parse(String(iso));
  expect(at).toBeGreaterThanOrEqual(before + days * DAY);
  expect(at).toBeLessThanOrEqual(after + days * DAY);
};
function newEmployee(credentialExpiresAt: string | null): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
  const e: Employee = { ...base, id: `emp_ttl_${Date.now().toString(36)}_${seq}`, orgId: ORG, status: "active", scopes: ["tools:read"], credentialId: `cred_ttl_${seq}`, credentialExpiresAt };
  getRuntimeEmployees().push(e);
  demoRotate(e.id, ORG, `fp_ttl_${seq}`);
  return e;
}
afterEach(() => {
  delete process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED;
});

describe("90-day 社員証", () => {
  test("admin MCP employees.issue fulfil: no expiresInDays → now + 90 days", async () => {
    const before = Date.now();
    const created = await createApproval({
      orgId: ORG, employeeId: "", credentialId: "", title: "hire", purpose: "admin.hire", summary: "hire", risk: "high", tool: "employees.issue",
      jobId: `job_ttl_${Date.now()}`,
      metadata: { auditClass: "admin", approvalClass: "admin", always_human: true, adminTool: "employees.issue", adminMutation: { displayName: `TTL${Date.now()}`, roleLabel: "営業", scopes: ["tools:read"], approvalPolicy: "always_human" } },
    });
    const approved = await resolveApproval(created.approval.id, "approved", HUMAN.email, ORG, { actorId: HUMAN.memberId });
    const f = await fulfillApprovedAdmin(approved!);
    expect(f?.ok).toBe(true);
    const emp = getRuntimeEmployees().find((e) => e.id === f?.employeeId)!;
    within(emp.credentialExpiresAt, before, Date.now(), 90);
  });
  test("rotate: expired and no-expiry badges both get now + 90 days", async () => {
    for (const start of ["2026-09-23T00:00:00.000Z", null]) {
      const emp = newEmployee(start);
      const before = Date.now();
      await rotateCredential(emp.id, ORG, `fp_rot_${seq}`);
      within(getRuntimeEmployees().find((e) => e.id === emp.id)!.credentialExpiresAt, before, Date.now(), 90);
    }
  });
  test("reissue pickup: now + 90 days", async () => {
    process.env.ADMIN_MCP_CREDENTIAL_REISSUE_ENABLED = "1";
    const emp = newEmployee("2026-09-23T00:00:00.000Z");
    const agent = resetDemoAdminAgent({ grokBotAgentId: "grok_admin_ttl", status: "linked" });
    const c = { orgId: ORG, adminAgentId: agent.id, grokBotAgentId: agent.grokBotAgentId, actorId: agent.id, generation: agent.credentialGeneration, via: "bearer" as const, agent };
    const q = (await callAdminMcpTool("employees.credential.reissue", { employeeId: emp.id, reason: "expired" }, c)).structuredContent as Record<string, unknown>;
    const approved = await resolveApproval(String(q.approvalId), "approved", HUMAN.email, ORG, { actorId: HUMAN.memberId });
    expect((await fulfillApprovedAdmin(approved!))?.ok).toBe(true);
    const before = Date.now();
    const r = await redeemCredentialReissue({ orgId: ORG, employeeId: emp.id, approvalId: String(q.approvalId), actor: HUMAN });
    expect(r.ok).toBe(true);
    within(getRuntimeEmployees().find((e) => e.id === emp.id)!.credentialExpiresAt, before, Date.now(), 90);
  });
  test("an employee who is NOT rotated keeps its null expiry (no backfill)", async () => {
    const untouched = newEmployee(null);
    const other = newEmployee(null);
    await rotateCredential(other.id, ORG, `fp_other_${seq}`);
    expect(getRuntimeEmployees().find((e) => e.id === untouched.id)!.credentialExpiresAt).toBeNull();
  });
});
