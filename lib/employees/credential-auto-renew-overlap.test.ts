/**
 * Fail-first: 社員証 auto-renew R3 (重ね置き + 初回成功で旧失効 + 24h cron).
 * CREDENTIAL_AUTO_RENEW_ENABLED + org allowlist, default OFF.
 * gen1 HTTP (R8) is a separate flag + route. No boot script (R5).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { fingerprintSecret, getBinding, rotateCredential as demoRotate } from "@/lib/bindings";
import { resolveApproval, rotateCredential } from "@/lib/data";
import {
  demoGetOverlapCredential,
  demoListCredentialRenewals,
  demoPatchCredentialRenewal,
  demoResetCredentialRenewals,
  demoSetOverlapAttachFail,
  demoSetOverlapCleanupFail,
  demoSetOverlapFingerprintMoveFail,
  demoSetOverlapRevokeFail,
} from "@/lib/data/credential-renewals";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { EMPLOYEE_CREDENTIAL_TTL_DAYS } from "@/lib/employees/credential-ttl";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { STAFFPASS_MCP_TOOLS } from "@/lib/mcp/tools";
import { demoSetEmployeeHold, demoSetOrgHold } from "@/lib/safety/hold";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { Employee } from "@/lib/types";
import {
  CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS,
  expireStaleCredentialRenewals,
} from "./credential-auto-renew";
import {
  expireOverlappedOldCredentials,
  issueCredentialOverlap,
} from "./credential-auto-renew-overlap";

const FLAG = "CREDENTIAL_AUTO_RENEW_ENABLED";
const ALLOWLIST = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST";
const REQUIRED = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ADMIN_GROK = "grok_admin_autorenew_r3";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_autorenew_r3" };
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
    id: `emp_r3_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_r3_${seq}`,
    credentialExpiresAt:
      extra.credentialExpiresAt === undefined ? "2026-12-01T00:00:00.000Z" : extra.credentialExpiresAt,
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function oldSecret(n = seq): string {
  return `gb_emp_r3old${String(n).padStart(2, "0")}_${"ab".repeat(16)}`;
}

function bindOld(employee: Employee, secret: string) {
  demoRotate(employee.id, employee.orgId, fingerprintSecret(secret));
}

const data = (r: { structuredContent?: unknown }) => r.structuredContent as Record<string, unknown>;

async function openClaimable(employee: Employee) {
  const queued = data(
    await callAdminMcpTool("employees.credential.auto_renew", { employeeId: employee.id, reason: "now" }, cred())
  );
  const approval = await resolveApproval(String(queued.approvalId), "approved", HUMAN.email, ORG_A, {
    actorId: HUMAN.memberId,
  });
  expect(approval).not.toBeNull();
  const fulfilled = await fulfillApprovedAdmin(approval!);
  expect(fulfilled?.ok).toBe(true);
  return { approvalId: String(queued.approvalId) };
}

function req(secret: string) {
  return new Request("https://staffpass.test/api/mcp", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, ALLOWLIST, REQUIRED] as const) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = "1";
  process.env[ALLOWLIST] = ORG_A;
  demoResetCredentialRenewals();
  demoSetEmployeeHold("", null);
});
afterEach(() => {
  for (const k of [FLAG, ALLOWLIST, REQUIRED] as const) {
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

describe("issueCredentialOverlap (R3)", () => {
  test("flag OFF → feature_disabled, no mint, fingerprint unchanged", async () => {
    delete process.env[FLAG];
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fp = getBinding(emp.id)?.credentialFingerprint;
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "feature_disabled" });
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fp);
    expect(demoListCredentialRenewals()).toHaveLength(0);
  });

  test("other org / allowlist miss → feature_disabled", async () => {
    const emp = newEmployee(ORG_B);
    bindOld(emp, oldSecret());
    const issued = await issueCredentialOverlap({
      orgId: ORG_B,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "feature_disabled" });
  });

  test("hold / not active / expired old badge are all out of scope", async () => {
    const held = newEmployee(ORG_A);
    bindOld(held, oldSecret());
    await openClaimable(held);
    demoSetEmployeeHold(held.id, { kind: "stopped", holdId: "hold_r3" });
    expect(
      await issueCredentialOverlap({ orgId: ORG_A, employeeId: held.id, oldCredentialId: held.credentialId! })
    ).toMatchObject({ ok: false, code: "held" });
    demoSetEmployeeHold(held.id, null);

    const retired = newEmployee(ORG_A, { status: "suspended" });
    bindOld(retired, oldSecret());
    expect(
      await issueCredentialOverlap({
        orgId: ORG_A,
        employeeId: retired.id,
        oldCredentialId: retired.credentialId!,
      })
    ).toMatchObject({ ok: false, code: "employee_terminated" });

    const expired = newEmployee(ORG_A, { credentialExpiresAt: "2020-01-01T00:00:00.000Z" });
    bindOld(expired, oldSecret());
    expect(
      await issueCredentialOverlap({
        orgId: ORG_A,
        employeeId: expired.id,
        oldCredentialId: expired.credentialId!,
      })
    ).toMatchObject({ ok: false, code: "expired" });
  });

  test("claimable window: mint overlap, generation+1, fingerprint stays on old, 90-day new row", async () => {
    const emp = newEmployee(ORG_A, { credentialExpiresAt: null });
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    const genBefore = getBinding(emp.id)?.credentialGeneration ?? 0;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected issue");
    expect(issued.secret.raw.startsWith("gb_emp_")).toBe(true);
    expect(issued.generation).toBe(genBefore + 1);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(getBinding(emp.id)?.credentialGeneration).toBe(genBefore + 1);
    const expires = Date.parse(issued.expiresAt);
    const expectMs = EMPLOYEE_CREDENTIAL_TTL_DAYS * 86_400_000;
    expect(expires - Date.now()).toBeGreaterThan(expectMs - 10_000);
    expect(expires - Date.now()).toBeLessThan(expectMs + 10_000);
    const overlap = Date.parse(issued.overlapUntil);
    expect(overlap - Date.now()).toBeGreaterThan(CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS - 5_000);
    expect(overlap - Date.now()).toBeLessThan(CREDENTIAL_AUTO_RENEW_OVERLAP_WINDOW_MS + 5_000);
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    expect(row).toMatchObject({
      state: "claimed",
      oldCredentialId: emp.credentialId,
      newCredentialId: issued.newCredentialId,
    });
    expect(row?.newCredentialId).not.toBe(emp.credentialId);
    const claimed = getRuntimeAudit().find(
      (e) => e.action === "credential.renew_claimed" && e.employeeId === emp.id
    );
    expect(claimed).toBeDefined();
    expect(JSON.stringify(claimed)).not.toMatch(SECRETISH);
    expect(JSON.stringify(claimed)).not.toContain(issued.secret.raw);
    expect(JSON.stringify(issued).match(/claim_token/)).toBeNull();
  });

  test("second claim loses CAS: already_claimed, no second mint", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const first = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(first.ok).toBe(true);
    const second = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(second).toMatchObject({ ok: false, code: "already_claimed" });
    expect(demoListCredentialRenewals().filter((r) => r.employeeId === emp.id && r.state === "claimed")).toHaveLength(1);
  });

  test("M2: mint attach fail + cleanup fail is recorded, not swallowed", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    demoSetOverlapAttachFail(true);
    demoSetOverlapCleanupFail(true);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(issued.code).toBe("cleanup_failed");
    const denied = getRuntimeAudit().find(
      (e) => e.action === "credential.renew_claim_denied" && e.employeeId === emp.id && e.metadata?.code === "cleanup_failed"
    );
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied)).not.toMatch(SECRETISH);
    demoSetOverlapAttachFail(false);
    demoSetOverlapCleanupFail(false);
  });

  test("M2: release after claim (no new id) while held → held_blocked, not claimable", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    const { claimCredentialRenewal, releaseCredentialRenewal } = await import("@/lib/data/credential-renewals");
    const token = "tok_release_held_01234567";
    expect(
      await claimCredentialRenewal({
        id: row.id,
        orgId: ORG_A,
        employeeId: emp.id,
        token,
        at: new Date().toISOString(),
      })
    ).toBe(true);
    demoSetEmployeeHold(emp.id, { kind: "stopped", holdId: "hold_m2_release" });
    expect(await releaseCredentialRenewal({ id: row.id, orgId: ORG_A, token })).toBe(true);
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("held_blocked");
    demoSetEmployeeHold(emp.id, null);
    const again = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(again.ok).toBe(false);
    demoSetEmployeeHold(emp.id, null);
  });

  test("L4: withoutSecrets drops claim_token even when injected", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, { claim_token: "tok_leak_l4_01234567" } as never);
    const listed = demoListCredentialRenewals().find((r) => r.id === row.id);
    expect(JSON.stringify(listed)).not.toContain("tok_leak_l4_01234567");
    expect(JSON.stringify(listed)).not.toMatch(/claim_token/);
  });

  test("unapproved window → not_claimable", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued).toMatchObject({ ok: false, code: "not_claimable" });
  });
});

describe("auth overlap + first_auth switchover", () => {
  test("during overlap, old and new both authenticate; last_used_at touches the presented id", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected issue");
    const oldAuth = await resolveEmployeeCredential(req(secret));
    expect(oldAuth.ok).toBe(true);
    if (oldAuth.ok) expect(oldAuth.credential.employeeId).toBe(emp.id);
    const newAuth = await resolveEmployeeCredential(req(issued.secret.raw));
    expect(newAuth.ok).toBe(true);
    if (newAuth.ok) {
      expect(newAuth.credential.employeeId).toBe(emp.id);
      expect(newAuth.credential.credentialId).toBe(issued.newCredentialId);
    }
  });

  test("new key first success revokes old (reason=first_auth); old then 401", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const first = await resolveEmployeeCredential(req(issued.secret.raw));
    expect(first.ok).toBe(true);
    const revoked = getRuntimeAudit().find(
      (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id
    );
    expect(revoked?.metadata).toMatchObject({
      reason: "first_auth",
      oldCredentialId: emp.credentialId,
      newCredentialId: issued.newCredentialId,
    });
    expect(JSON.stringify(revoked)).not.toMatch(SECRETISH);
    expect(getBinding(emp.id)?.credentialFingerprint).not.toBe(fpBefore);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(issued.secret.fingerprint);
    const oldAgain = await resolveEmployeeCredential(req(secret));
    expect(oldAgain.ok).toBe(false);
    if (!oldAgain.ok) expect(oldAgain.code === "invalid_credential" || oldAgain.code === "revoked").toBe(true);
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    expect(row?.state).toBe("old_revoked");
  });

  test("old key success during overlap does not revoke old", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimed");
    expect(getRuntimeAudit().some((e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id)).toBe(
      false
    );
    expect((await resolveEmployeeCredential(req(issued.secret.raw))).ok).toBe(true);
  });

  test("revoke false: do not trust old as dead — fingerprint stays, old still works", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoSetOverlapRevokeFail(true);
    const first = await resolveEmployeeCredential(req(issued.secret.raw));
    expect(first.ok).toBe(true);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("claimed");
    demoSetOverlapRevokeFail(false);
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
    expect(
      getRuntimeAudit().some(
        (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id && e.metadata?.reason === "first_auth"
      )
    ).toBe(false);
  });

  test("M1: fingerprint move fail after revoke is not complete — old stays live, no revoked audit", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    demoSetOverlapFingerprintMoveFail(true);
    const first = await resolveEmployeeCredential(req(issued.secret.raw));
    expect(first.ok).toBe(true);
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimed");
    expect(demoGetOverlapCredential(emp.credentialId!)?.revokedAt ?? null).toBeNull();
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
    expect(
      getRuntimeAudit().some(
        (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id && e.metadata?.reason === "first_auth"
      )
    ).toBe(false);
    demoSetOverlapFingerprintMoveFail(false);
  });

  test("L1: after overlap_until, new badge is not accepted; old still works until switchover", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await resolveEmployeeCredential(req(issued.secret.raw))).ok).toBe(false);
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
  });
});

describe("24h overlap cron", () => {
  test("flag OFF: cron does not touch claimed rows", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    delete process.env[FLAG];
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const ran = await expireOverlappedOldCredentials();
    expect(ran).toMatchObject({ revoked: 0 });
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("claimed");
  });

  test("H1: unused new after overlap → revoke new, keep old, expire, binding stays", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const fpBefore = getBinding(emp.id)?.credentialFingerprint;
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const ran = await expireOverlappedOldCredentials();
    expect(ran.revoked).toBe(0);
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("expired");
    expect(demoGetOverlapCredential(issued.newCredentialId)?.revokedAt).toBeTruthy();
    expect(demoGetOverlapCredential(emp.credentialId!)?.revokedAt ?? null).toBeNull();
    expect(getBinding(emp.id)?.credentialFingerprint).toBe(fpBefore);
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
    expect((await resolveEmployeeCredential(req(issued.secret.raw))).ok).toBe(false);
    const audit = getRuntimeAudit().find(
      (e) =>
        e.employeeId === emp.id &&
        (e.action === "credential.renew_new_revoked" || e.metadata?.reason === "unused_after_overlap")
    );
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toMatch(SECRETISH);
    expect(
      getRuntimeAudit().some(
        (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id && e.metadata?.reason === "overlap_timeout"
      )
    ).toBe(false);
  });

  test("H1: used new after overlap → switchover revokes old, new stays", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const neu = demoGetOverlapCredential(issued.newCredentialId);
    expect(neu).toBeTruthy();
    if (neu) {
      const { demoPutOverlapCredential } = await import("@/lib/data/credential-renewals");
      demoPutOverlapCredential({ ...neu, lastUsedAt: new Date().toISOString() });
    }
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    const ran = await expireOverlappedOldCredentials();
    expect(ran.revoked).toBeGreaterThanOrEqual(1);
    const audit = getRuntimeAudit().find(
      (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id
    );
    expect(audit?.metadata).toMatchObject({ reason: "overlap_timeout" });
    expect(JSON.stringify(audit)).not.toMatch(SECRETISH);
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(false);
    expect((await resolveEmployeeCredential(req(issued.secret.raw))).ok).toBe(true);
  });

  test("L2: if the new badge is already revoked, cron expires the renewal and leaves the old badge live", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id)!;
    const neu = demoGetOverlapCredential(issued.newCredentialId);
    expect(neu).toBeTruthy();
    demoPatchCredentialRenewal(row.id, {
      overlapUntil: new Date(Date.now() - 1000).toISOString(),
    });
    if (neu) {
      const { demoPutOverlapCredential } = await import("@/lib/data/credential-renewals");
      demoPutOverlapCredential({ ...neu, revokedAt: new Date().toISOString() });
    }
    const ran = await expireOverlappedOldCredentials();
    expect(ran.revoked).toBe(0);
    expect(demoListCredentialRenewals().find((r) => r.id === row.id)?.state).toBe("expired");
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(true);
    expect(
      getRuntimeAudit().some(
        (e) => e.action === "credential.renew_old_revoked" && e.employeeId === emp.id && e.metadata?.reason === "overlap_timeout"
      )
    ).toBe(false);
  });
});

describe("rotate stays immediate; R8/R5 stay out", () => {
  test("dashboard rotate still revokes the previous fingerprint immediately", async () => {
    const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    if (!issued.ok) throw new Error("expected issue");
    const rotatedSecret = `gb_emp_r3rot${String(seq).padStart(2, "0")}_${"cd".repeat(16)}`;
    await rotateCredential(emp.id, ORG_A, fingerprintSecret(rotatedSecret));
    expect((await resolveEmployeeCredential(req(secret))).ok).toBe(false);
    expect((await resolveEmployeeCredential(req(issued.secret.raw))).ok).toBe(false);
    expect((await resolveEmployeeCredential(req(rotatedSecret))).ok).toBe(true);
  });

  test("L3: overlap DB fixture aborts outside the disposable test cluster", () => {
    const sql = readFileSync(resolve("tests/security/db-credential-auto-renew-overlap.sql"), "utf8");
    expect(sql).toMatch(/to_regnamespace\('security_test'\)/);
    expect(sql).toMatch(/current_user\s+is distinct from\s+'test_admin'|current_user\s*<>\s*'test_admin'/);
    expect(sql).toMatch(/refuse outside disposable test cluster/i);
    // One-transaction cleanup via GUC. DISABLE+write+ENABLE in one txn is
    // refused by PostgreSQL (pending trigger events).
    expect(sql).toMatch(/set_config\('staffpass\.hold_write',\s*'on',\s*true\)/);
    expect(sql).not.toMatch(/disable trigger employee_holds_guard/);
  });

  test("R8 HTTP claim route is flag-off by default; R5 boot script stays out", () => {
    expect(existsSync(resolve("app/api/mcp/employee/credential/claim/route.ts"))).toBe(true);
    expect(existsSync(resolve("scripts/staffpass-mcp-boot.sh"))).toBe(false);
    expect(STAFFPASS_MCP_TOOLS.some((t) => t.name.startsWith("staffpass_credential_renew"))).toBe(false);
    const flags = readFileSync(resolve(".env.example"), "utf8");
    expect(flags).toContain("CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED");
    expect(flags).not.toMatch(/^CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED=(true|1|on)/m);
  });

  test("production sources do not hardcode tenant ids or 社員証 secrets", () => {
    const text = readFileSync(resolve("lib/employees/credential-auto-renew-overlap.ts"), "utf8");
    expect(text).not.toContain("6d134a38-a0ab-4a8e-aba7-3202650ff523");
    expect(text.toLowerCase()).not.toContain("9a795dfd");
    expect(text).not.toMatch(/gb_emp_[0-9a-f]{8}_[0-9a-f]+/i);
  });
});

describe("stale expire still does not close a minted overlap", () => {
  test("expireStale leaves claimed+new_id rows alone", async () => {
    const emp = newEmployee(ORG_A);
    bindOld(emp, oldSecret());
    await openClaimable(emp);
    const issued = await issueCredentialOverlap({
      orgId: ORG_A,
      employeeId: emp.id,
      oldCredentialId: emp.credentialId!,
    });
    expect(issued.ok).toBe(true);
    await expireStaleCredentialRenewals({ orgId: ORG_A, now: new Date(Date.now() + 48 * 3600 * 1000) });
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimed");
  });
});
