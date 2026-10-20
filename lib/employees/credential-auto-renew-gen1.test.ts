/**
 * Fail-first: 社員証 auto-renew R8 (gen1 HTTP one-time pickup).
 * CREDENTIAL_AUTO_RENEW_ENABLED + org allowlist + GEN1 HTTP flag, default OFF.
 * No boot script (R5). Never logs secret / claim_token.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { fingerprintSecret, getBinding, rotateCredential as demoRotate } from "@/lib/bindings";
import { resolveApproval, updateApprovalMetadata } from "@/lib/data";
import {
  demoGetOverlapCredential,
  demoListCredentialRenewals,
  demoPatchCredentialRenewal,
  demoResetCredentialRenewals,
} from "@/lib/data/credential-renewals";
import { expireOverlappedOldCredentials } from "./credential-auto-renew-overlap";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { demoSetEmployeeHold, demoSetOrgHold } from "@/lib/safety/hold";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { Employee } from "@/lib/types";

const FLAG = "CREDENTIAL_AUTO_RENEW_ENABLED";
const GEN1 = "CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED";
const ALLOWLIST = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST";
const REQUIRED = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ADMIN_GROK = "grok_admin_autorenew_r8";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_autorenew_r8" };
const SECRETISH = /gb_emp_[A-Za-z0-9]{6,}|oneTimeSecret|secret_hash|secretHash\b|claim_token/;
let seq = 0;

function cred(orgId = ORG_A): ResolvedAdminCredential {
  const agent = resetDemoAdminAgent({ grokBotAgentId: ADMIN_GROK, status: "linked" });
  return {
    orgId,
    adminAgentId: agent.id,
    grokBotAgentId: agent.grokBotAgentId,
    actorId: agent.id,
    generation: agent.credentialGeneration,
    via: "bearer",
    agent,
  };
}

function newEmployee(orgId: string, extra: Partial<Employee> = {}): Employee {
  seq += 1;
  const base = getRuntimeEmployees().find((item) => item.id === "emp_comm")!;
  const employee: Employee = {
    ...base,
    id: `emp_r8_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_r8_${seq}`,
    credentialExpiresAt:
      extra.credentialExpiresAt === undefined ? "2026-12-01T00:00:00.000Z" : extra.credentialExpiresAt,
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function oldSecret(n = seq): string {
  return `gb_emp_r8old${String(n).padStart(2, "0")}_${"ab".repeat(16)}`;
}

function bindOld(employee: Employee, secret: string) {
  demoRotate(employee.id, employee.orgId, fingerprintSecret(secret));
}

const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

async function openClaimable(employee: Employee, orgId = ORG_A) {
  const queued = data(
    await callAdminMcpTool("employees.credential.auto_renew", { employeeId: employee.id, reason: "now" }, cred(orgId))
  );
  const approval = await resolveApproval(String(queued.approvalId), "approved", HUMAN.email, orgId, {
    actorId: HUMAN.memberId,
  });
  expect(approval).not.toBeNull();
  const fulfilled = await fulfillApprovedAdmin(approval!);
  expect(fulfilled?.ok).toBe(true);
  return { approvalId: String(queued.approvalId) };
}

async function claimGen1(input: { orgId: string; employeeId: string; oldCredentialId: string }) {
  const { claimCredentialGen1Http } = await import("./credential-auto-renew-gen1");
  return claimCredentialGen1Http(input);
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, GEN1, ALLOWLIST, REQUIRED] as const) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = "1";
  process.env[GEN1] = "1";
  process.env[ALLOWLIST] = ORG_A;
  demoResetCredentialRenewals();
  demoSetEmployeeHold("", null);
});
afterEach(() => {
  for (const k of [FLAG, GEN1, ALLOWLIST, REQUIRED] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    demoSetEmployeeHold("cleanup", null);
    demoSetOrgHold(ORG_A, null);
  } catch {
    /* demo_only when not demo */
  }
});

describe("CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED (default OFF)", () => {
  test("unset / empty / garbage → OFF", async () => {
    const { isCredentialAutoRenewGen1HttpEnabled } = await import("@/lib/feature-flags");
    delete process.env[GEN1];
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(false);
    process.env[GEN1] = "";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(false);
    process.env[GEN1] = "false";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(false);
    process.env[GEN1] = "yes";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(false);
  });

  test("true / 1 / on / enabled → ON", async () => {
    const { isCredentialAutoRenewGen1HttpEnabled } = await import("@/lib/feature-flags");
    process.env[GEN1] = "true";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(true);
    process.env[GEN1] = "1";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(true);
    process.env[GEN1] = "ON";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(true);
    process.env[GEN1] = "enabled";
    expect(isCredentialAutoRenewGen1HttpEnabled()).toBe(true);
  });
});

describe("claimCredentialGen1Http", () => {
  test("GEN1 flag OFF → feature_disabled, no mint", async () => {
    delete process.env[GEN1];
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const fp = getBinding(emp.id)?.credentialFingerprint;
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "feature_disabled" });
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fp);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimable");
  });

  test("double pickup: second loses CAS, no second mint", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const first = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected first claim");
    const second = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(second).toMatchObject({ ok: false, code: "already_claimed" });
    expect(demoListCredentialRenewals().filter((r) => r.employeeId === emp.id && r.state === "claimed")).toHaveLength(1);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.mode).toBe("gen1_http");
  });

  test("pickup after 24h window → window_expired / not_claimable, no mint", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const open = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    expect(open?.state).toBe("claimable");
    demoPatchCredentialRenewal(open!.id, {
      claimableUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(["window_expired", "not_claimable"]).toContain(issued.code);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.newCredentialId).toBeFalsy();
  });

  test("pickup before approval → not_claimable", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    const queued = data(
      await callAdminMcpTool("employees.credential.auto_renew", { employeeId: emp.id, reason: "now" }, cred())
    );
    expect(queued.approvalId).toBeTruthy();
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "not_claimable" });
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("pending_approval");
  });

  test("H1: unused gen1 mint after overlap → revoke new, keep old", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected claim");
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const ran = await expireOverlappedOldCredentials();
    expect(ran.revoked).toBe(0);
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("expired");
    expect(demoGetOverlapCredential(issued.newCredentialId)?.revokedAt).toBeTruthy();
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
  });

  test("M1: heldByHoldId on the approval blocks claim (assertTicketNotHeld)", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    const opened = await openClaimable(emp);
    const { getApprovalById } = await import("@/lib/data");
    const approval = await getApprovalById(opened.approvalId, ORG_A);
    expect(approval).not.toBeNull();
    await updateApprovalMetadata(approval!, { heldByHoldId: "hold_r8_ticket" });
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(["held", "approval_held", "not_claimable"]).toContain(issued.code);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.newCredentialId).toBeFalsy();
  });

  test("pickup while held → held, no mint", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    demoSetEmployeeHold(emp.id, { kind: "stopped", holdId: "hold_r8" });
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "held" });
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimable");
    demoSetEmployeeHold(emp.id, null);
  });

  test("other org cannot pick up this org's window", async () => {
    const empA = newEmployee(ORG_A);
    bindOld(empA, oldSecret());
    await openClaimable(empA);
    const empB = newEmployee(ORG_B);
    bindOld(empB, oldSecret());
    const stolen = await claimGen1({
      orgId: ORG_B,
      employeeId: empA.id,
      oldCredentialId: empA.credentialId!,
    });
    expect(stolen.ok).toBe(false);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === empA.id)?.state).toBe("claimable");
  });

  test("success + audit / errors never contain plaintext 社員証", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await claimGen1({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected claim");
    const audit = getRuntimeAudit().filter((e) => e.employeeId === emp.id);
    const dumped = JSON.stringify(audit);
    expect(dumped).not.toContain(issued.secret.raw);
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toMatch(SECRETISH);
    expect(JSON.stringify(issued).match(/claim_token/)).toBeNull();
  });
});

describe("R8 surface: HTTP only, flag default OFF, no hold release", () => {
  test("route exists; not an MCP tool; .env.example stays commented OFF", () => {
    expect(existsSync(resolve("app/api/mcp/employee/credential/claim/route.ts"))).toBe(true);
    expect(existsSync(resolve("scripts/staffpass-mcp-boot.sh"))).toBe(false);
    expect(STAFFPASS_MCP_TOOLS.some((t) => t.name.startsWith("staffpass_credential_renew"))).toBe(false);
    const flags = readFileSync(resolve(".env.example"), "utf8");
    expect(flags).toContain("CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED");
    expect(flags).not.toMatch(/^CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED=(true|1|on)/m);
  });

  test("production sources do not hardcode tenant ids, secrets, or hold release", () => {
    const files = [
      "lib/employees/credential-auto-renew-gen1.ts",
      "app/api/mcp/employee/credential/claim/route.ts",
      "supabase/migrations/20261020200000_credential_auto_renew_gen1_http.sql",
      "supabase/migrations/20261020300000_credential_auto_renew_review_followup.sql",
    ];
    for (const f of files) {
      const text = readFileSync(resolve(f), "utf8");
      expect(text).not.toContain("6d134a38-a0ab-4a8e-aba7-3202650ff523");
      expect(text.toLowerCase()).not.toContain("9a795dfd");
      expect(text).not.toMatch(/gb_emp_[0-9a-f]{8}_[0-9a-f]+/i);
      expect(text).not.toMatch(/releaseEmployeeHold|release_employee_hold|demoSetEmployeeHold\([^,]+,\s*null/);
    }
  });
});
