/**
 * Fail-first: POST /api/mcp/employee/credential/claim (R8 gen1 HTTP).
 * Flag OFF → 404. Failures share one body so existence cannot be inferred.
 * Response may contain a plaintext 社員証: never log it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fulfillApprovedAdmin } from "@/lib/admin-mcp/fulfill-admin";
import { fingerprintSecret, rotateCredential as demoRotate } from "@/lib/bindings";
import { resolveApproval, updateApprovalMetadata } from "@/lib/data";
import {
  demoGetOverlapCredential,
  demoListCredentialRenewals,
  demoPatchCredentialRenewal,
  demoResetCredentialRenewals,
} from "@/lib/data/credential-renewals";
import { resetDemoAdminAgent } from "@/lib/data/admin-agents";
import { getRuntimeAudit, getRuntimeEmployees } from "@/lib/demo-data";
import { callAdminMcpTool } from "@/lib/mcp/admin-tools";
import { startHold } from "@/lib/safety/hold-actions";
import { demoSetEmployeeHold, demoSetOrgHold } from "@/lib/safety/hold";
import { __resetDemoHoldsForTests } from "@/lib/safety/hold-store";
import { scopedModuleMocks } from "@/tests/helpers/scoped-module-mock";
import type { ResolvedAdminCredential } from "@/lib/auth/admin-credential";
import type { Employee } from "@/lib/types";

const touches: string[] = [];
let boomOnSuccessJson = false;
const mocks = scopedModuleMocks();
const realJsonUtf8 = (await import("@/lib/http/json-utf8")).jsonUtf8;
await mocks.mock("@/lib/data/credential-last-used", {
  touchCredentialLastUsed: async (id: string | null | undefined) => {
    if (id) touches.push(id);
  },
});
await mocks.mock("@/lib/http/json-utf8", {
  jsonUtf8: (body: unknown, init?: ResponseInit) => {
    if (boomOnSuccessJson && body && typeof body === "object" && (body as { ok?: boolean }).ok === true) {
      throw new Error("json_utf8_boom");
    }
    return realJsonUtf8(body, init);
  },
});

const FLAG = "CREDENTIAL_AUTO_RENEW_ENABLED";
const GEN1 = "CREDENTIAL_AUTO_RENEW_GEN1_HTTP_ENABLED";
const ALLOWLIST = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST";
const REQUIRED = "CREDENTIAL_AUTO_RENEW_ORG_ALLOWLIST_REQUIRED";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const ADMIN_GROK = "grok_admin_autorenew_r8_http";
const HUMAN = { email: "owner@example.com", memberId: "mem_human_autorenew_r8_http" };
const DENY = { ok: false, error: "not_found" };
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
    id: `emp_r8h_${Date.now().toString(36)}_${seq}`,
    orgId,
    status: "active",
    scopes: ["tools:read", "approvals:request", "audit:append"],
    credentialId: `cred_r8h_${seq}`,
    credentialExpiresAt:
      extra.credentialExpiresAt === undefined ? "2026-12-01T00:00:00.000Z" : extra.credentialExpiresAt,
    ...extra,
  };
  getRuntimeEmployees().push(employee);
  return employee;
}

function oldSecret(n = seq): string {
  return `gb_emp_r8http${String(n).padStart(2, "0")}_${"cd".repeat(16)}`;
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

function req(secret: string, extra: Record<string, string> = {}) {
  return new Request("https://staffpass.test/api/mcp/employee/credential/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, ...extra },
  });
}

async function post(secret: string, extra?: Record<string, string>) {
  const { POST } = await import("./route");
  return POST(req(secret, extra));
}

async function expectDeny(res: Response) {
  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("no-store, private, no-cache, must-revalidate");
  expect(res.headers.get("pragma")).toBe("no-cache");
  const body = await res.json();
  expect(body).toEqual(DENY);
  return body;
}

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of [FLAG, GEN1, ALLOWLIST, REQUIRED, "EMPLOYEE_HOLD_ENABLED"] as const) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env[FLAG] = "1";
  process.env[GEN1] = "1";
  process.env[ALLOWLIST] = ORG_A;
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  demoResetCredentialRenewals();
  demoSetEmployeeHold("", null);
  __resetDemoHoldsForTests();
  touches.length = 0;
  boomOnSuccessJson = false;
});
afterEach(() => {
  for (const k of [FLAG, GEN1, ALLOWLIST, REQUIRED, "EMPLOYEE_HOLD_ENABLED"] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try {
    demoSetEmployeeHold("cleanup", null);
    demoSetOrgHold(ORG_A, null);
    demoSetOrgHold(ORG_B, null);
    __resetDemoHoldsForTests();
  } catch {
    /* demo_only when not demo */
  }
  touches.length = 0;
  boomOnSuccessJson = false;
});

describe("POST /api/mcp/employee/credential/claim", () => {
  test("flag OFF (default) → 404, no mint, same body as other denials", async () => {
    delete process.env[GEN1];
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimable");
  });

  test("auto-renew global OFF → 404 even if GEN1 is on", async () => {
    delete process.env[FLAG];
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await expectDeny(await post(secret));
  });

  test("happy path: one-time plaintext 社員証 + Cache-Control: no-store", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const res = await post(secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private, no-cache, must-revalidate");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const body = (await res.json()) as { ok: boolean; credential: string; generation: number };
    expect(body.ok).toBe(true);
    expect(body.credential.startsWith("gb_emp_")).toBe(true);
    expect(body.credential).not.toBe(secret);
    expect(body.generation).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/claim_token/);
  });

  test("double pickup: second is the same 404 as other failures", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const first = await post(secret);
    expect(first.status).toBe(200);
    const minted = (await first.json()) as { credential: string };
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().filter((r) => r.employeeId === emp.id && r.state === "claimed")).toHaveLength(1);
    expect(minted.credential.startsWith("gb_emp_")).toBe(true);
  });

  test("pickup after 24h → same 404, no mint", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const open = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    demoPatchCredentialRenewal(open!.id, {
      claimableUntil: new Date(Date.now() - 1000).toISOString(),
    });
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.newCredentialId).toBeFalsy();
  });

  test("pickup before approval → same 404", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const queued = data(
      await callAdminMcpTool("employees.credential.auto_renew", { employeeId: emp.id, reason: "now" }, cred())
    );
    expect(queued.approvalId).toBeTruthy();
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("pending_approval");
  });

  test("pickup while held → same 404, no mint", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    demoSetEmployeeHold(emp.id, { kind: "stopped", holdId: "hold_r8_http" });
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("claimable");
    demoSetEmployeeHold(emp.id, null);
  });

  test("other org badge cannot pick up this org's window (same 404)", async () => {
    process.env[ALLOWLIST] = `${ORG_A},${ORG_B}`;
    const empA = newEmployee(ORG_A);
    const secretA = oldSecret();
    bindOld(empA, secretA);
    await openClaimable(empA, ORG_A);
    const empB = newEmployee(ORG_B);
    const secretB = oldSecret();
    bindOld(empB, secretB);
    await expectDeny(await post(secretB));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === empA.id)?.state).toBe("claimable");
  });

  test("sp_at_ / missing / invalid are the same 404 (no existence oracle)", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const a = await expectDeny(await post("sp_at_not_a_badge_value_0001"));
    const b = await expectDeny(await post(""));
    const c = await expectDeny(await post("gb_emp_unknown_secret_value_0000"));
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    expect(a).toEqual(DENY);
  });

  test("L2: Cache-Control / Pragma / fetchCache force-no-store", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const res = await post(secret);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store, private, no-cache, must-revalidate");
    expect(res.headers.get("pragma")).toBe("no-cache");
    const src = readFileSync(resolve("app/api/mcp/employee/credential/claim/route.ts"), "utf8");
    expect(src).toMatch(/export const fetchCache = "force-no-store"/);
    await res.json();
  });

  test("L3: last_used_at touches only after a successful claim", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const open = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    demoPatchCredentialRenewal(open!.id, {
      claimableUntil: new Date(Date.now() - 1000).toISOString(),
    });
    await expectDeny(await post(secret));
    expect(touches).toEqual([]);
    demoPatchCredentialRenewal(open!.id, {
      claimableUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      state: "claimable",
    });
    const ok = await post(secret);
    expect(ok.status).toBe(200);
    await ok.json();
    expect(touches.length).toBeGreaterThan(0);
  });

  test("M1: startHold turns claimable into held_blocked; unhold does not reopen", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const stop = await startHold({
      orgId: ORG_A,
      employeeId: emp.id,
      actor: { type: "ops", opsId: "ops@staffpass.example", surface: "ops_console" },
    });
    expect(stop.ok).toBe(true);
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("held_blocked");
    demoSetEmployeeHold(emp.id, null);
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.state).toBe("held_blocked");
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.newCredentialId).toBeFalsy();
  });

  test("M1: held ticket marker is refused before claim", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    const opened = await openClaimable(emp);
    const { getApprovalById } = await import("@/lib/data");
    const approval = await getApprovalById(opened.approvalId, ORG_A);
    await updateApprovalMetadata(approval!, { heldByHoldId: "hold_r8_http_ticket" });
    await expectDeny(await post(secret));
    expect(demoListCredentialRenewals().find((r) => r.employeeId === emp.id)?.newCredentialId).toBeFalsy();
    const denied = getRuntimeAudit().find(
      (e) => e.action === "credential.renew_claim_denied" && e.employeeId === emp.id
    );
    expect(denied?.metadata?.code === "approval_held" || denied?.metadata?.code === "held").toBe(true);
    expect(JSON.stringify(denied)).not.toMatch(/gb_emp_/);
  });

  test("H1/M3: jsonUtf8 throw after mint revokes new, releases, 404 + reason code, no plaintext", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    boomOnSuccessJson = true;
    await expectDeny(await post(secret));
    boomOnSuccessJson = false;
    const row = demoListCredentialRenewals().find((r) => r.employeeId === emp.id);
    expect(row?.state === "claimable" || row?.state === "held_blocked").toBe(true);
    expect(row?.newCredentialId).toBeFalsy();
    const minted = getRuntimeAudit().find((e) => e.action === "credential.renew_claimed" && e.employeeId === emp.id);
    const newId = minted?.metadata?.newCredentialId ? String(minted.metadata.newCredentialId) : "";
    if (newId) {
      expect(demoGetOverlapCredential(newId)?.revokedAt).toBeTruthy();
    }
    const denied = getRuntimeAudit().find(
      (e) =>
        e.action === "credential.renew_claim_denied" &&
        e.employeeId === emp.id &&
        (e.metadata?.code === "mint_delivery_failed" || e.metadata?.code === "response_failed")
    );
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied)).not.toMatch(/gb_emp_/);
    expect(JSON.stringify(denied)).not.toMatch(/claim_token/);
  });

  test("console / audit never contain plaintext 社員証", async () => {
    const emp = newEmployee(ORG_A);
    const secret = oldSecret();
    bindOld(emp, secret);
    await openClaimable(emp);
    const lines: string[] = [];
    const orig = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    };
    const spy = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
    console.log = spy;
    console.error = spy;
    console.warn = spy;
    console.info = spy;
    console.debug = spy;
    let minted = "";
    try {
      const res = await post(secret);
      expect(res.status).toBe(200);
      minted = String(((await res.json()) as { credential: string }).credential);
    } finally {
      console.log = orig.log;
      console.error = orig.error;
      console.warn = orig.warn;
      console.info = orig.info;
      console.debug = orig.debug;
    }
    const dumped = lines.join("\n");
    expect(dumped).not.toContain(secret);
    expect(dumped).not.toContain(minted);
    expect(dumped).not.toMatch(/gb_emp_[A-Za-z0-9]{8,}/);
    const audit = JSON.stringify(getRuntimeAudit().filter((e) => e.employeeId === emp.id));
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain(minted);
    expect(audit).not.toMatch(/claim_token/);
  });
});
