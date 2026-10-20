/**
 * WHOAMI_CREDENTIAL_INFO_ENABLED (default OFF): staffpass_whoami に
 * credential.expiresAt / org.name / 期限7日以内の案内を足す。
 * Fail-first: 実装前にこのファイルは flag ON の期待で落ちる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEMO_EMPLOYEES, DEMO_ORG, getRuntimeEmployees } from "@/lib/demo-data";
import type { ResolvedEmployeeCredential } from "@/lib/auth/employee-credential";
import { CREDENTIAL_EXPIRING_SOON_DAYS } from "@/lib/employees/credential-expiry";
import { callStaffpassMcpTool } from "@/lib/mcp/tools";
import { buildStaffpassWhoamiPayload } from "@/lib/mcp/whoami";

const FLAG = "WHOAMI_CREDENTIAL_INFO_ENABLED";
const NOW = new Date("2026-10-16T00:00:00.000Z");
const DAY_MS = 86_400_000;
const EXACT_7D = new Date(NOW.getTime() + 7 * DAY_MS).toISOString(); // 2026-10-23T00:00:00.000Z
const OVER_7D = new Date(NOW.getTime() + 7 * DAY_MS + 1).toISOString();
const NEXT_STEP =
  "社員証の期限が近づいています（2026-10-23 まで）。管理者に再発行を依頼してください。";
const OTHER_ORG_NAME = "他テナント秘密の社名";
const OTHER_EMPLOYEE_ID = "emp_other_org_whoami";
const LEAK_NEEDLES = [
  "gb_emp_fixture",
  "fixture-hash",
  "cred_comm",
  "secret_hash",
  "secretPrefix",
  "fingerprint",
  OTHER_ORG_NAME,
  OTHER_EMPLOYEE_ID,
];

function demoCred(
  employeeId = "emp_comm",
  extra: Partial<ResolvedEmployeeCredential> & { authMethod?: "gb_emp" | "oauth" } = {}
): ResolvedEmployeeCredential & { authMethod?: "gb_emp" | "oauth" } {
  return {
    employeeId,
    orgId: DEMO_ORG.id,
    credentialId: `cred_${employeeId}`,
    generation: 1,
    fingerprint: "fixture-hash",
    secretPrefix: "gb_emp_fixture",
    binding: {
      status: "linked",
      employeeId,
      orgId: DEMO_ORG.id,
      credentialGeneration: 1,
      grokBotAgentId: "agent_test",
      grokBotWorkspaceId: null,
      credentialFingerprint: null,
      lastSuccessAt: null,
      lastError: null,
      wakeWebhookUrl: null,
      hasWakeWebhook: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    ...extra,
  };
}

function parseWhoami(result: { content: Array<{ text: string }>; structuredContent?: unknown }) {
  expect(result.content[0]?.text).toBe(JSON.stringify(result.structuredContent, null, 2));
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

const saved: Record<string, string | undefined> = {};
let expiryBackup: string | null | undefined;

beforeEach(() => {
  saved[FLAG] = process.env[FLAG];
  delete process.env[FLAG];
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  expiryBackup = emp?.credentialExpiresAt;
  if (emp) emp.credentialExpiresAt = null;
});
afterEach(() => {
  saved[FLAG] === undefined ? delete process.env[FLAG] : (process.env[FLAG] = saved[FLAG]);
  const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm");
  if (emp) emp.credentialExpiresAt = expiryBackup;
  const other = getRuntimeEmployees().findIndex((e) => e.id === OTHER_EMPLOYEE_ID);
  if (other >= 0) getRuntimeEmployees().splice(other, 1);
});

describe("flag OFF: byte-identical to today's whoami", () => {
  test("callStaffpassMcpTool whoami has no credential / org / expiringSoon / nextStepJa keys", async () => {
    const result = await callStaffpassMcpTool("staffpass_whoami", {}, demoCred());
    const text = result.content[0].text;
    const parsed = parseWhoami(result);
    expect(Object.prototype.hasOwnProperty.call(parsed, "credential")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "org")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "expiringSoon")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "nextStepJa")).toBe(false);
    expect(text).not.toContain('"expiresAt"');
    expect(text).not.toContain('"expiringSoon"');
    expect(CREDENTIAL_EXPIRING_SOON_DAYS).toBe(7);
  });

  test("flag unset vs explicit false/off: same bytes", async () => {
    const unset = (await callStaffpassMcpTool("staffpass_whoami", {}, demoCred())).content[0].text;
    process.env[FLAG] = "false";
    const off = (await callStaffpassMcpTool("staffpass_whoami", {}, demoCred())).content[0].text;
    process.env[FLAG] = "0";
    const zero = (await callStaffpassMcpTool("staffpass_whoami", {}, demoCred())).content[0].text;
    expect(off).toBe(unset);
    expect(zero).toBe(unset);
  });
});

describe("buildStaffpassWhoamiPayload credentialInfo", () => {
  const comm = DEMO_EMPLOYEES.find((item) => item.id === "emp_comm")!;
  const binding = {
    status: "linked" as const,
    credentialGeneration: 1,
    grokBotAgentId: "agent_demo",
  };

  test("omitted credentialInfo keeps today's keys (no credential block)", () => {
    const payload = buildStaffpassWhoamiPayload({ employee: comm, orgId: comm.orgId, binding });
    expect(payload.credential).toBeUndefined();
    expect(payload.org).toBeUndefined();
    expect(payload.expiringSoon).toBeUndefined();
    expect(payload.nextStepJa).toBeUndefined();
  });

  test("7-day exact boundary → expiringSoon + nextStepJa (YYYY-MM-DD)", () => {
    const payload = buildStaffpassWhoamiPayload({
      employee: comm,
      orgId: comm.orgId,
      binding,
      credentialInfo: {
        kind: "gb_emp",
        expiresAt: EXACT_7D,
        orgName: DEMO_ORG.name,
        now: NOW,
      },
    });
    expect(payload.credential).toEqual({ kind: "gb_emp", expiresAt: EXACT_7D });
    expect(payload.org).toEqual({ name: DEMO_ORG.name });
    expect(payload.expiringSoon).toBe(true);
    expect(payload.nextStepJa).toBe(NEXT_STEP);
  });

  test("7-day + 1ms is not expiringSoon", () => {
    const payload = buildStaffpassWhoamiPayload({
      employee: comm,
      orgId: comm.orgId,
      binding,
      credentialInfo: { kind: "gb_emp", expiresAt: OVER_7D, orgName: DEMO_ORG.name, now: NOW },
    });
    expect(payload.credential).toEqual({ kind: "gb_emp", expiresAt: OVER_7D });
    expect(payload.expiringSoon).toBeUndefined();
    expect(payload.nextStepJa).toBeUndefined();
  });

  test("null expiry → expiresAt null, never expiringSoon", () => {
    const payload = buildStaffpassWhoamiPayload({
      employee: comm,
      orgId: comm.orgId,
      binding,
      credentialInfo: { kind: "oauth", expiresAt: null, orgName: DEMO_ORG.name, now: NOW },
    });
    expect(payload.credential).toEqual({ kind: "oauth", expiresAt: null });
    expect(payload.org).toEqual({ name: DEMO_ORG.name });
    expect(payload.expiringSoon).toBeUndefined();
    expect(payload.nextStepJa).toBeUndefined();
  });

  test("payload never includes secret / prefix / hash / credential id / other org", () => {
    const dumped = JSON.stringify(
      buildStaffpassWhoamiPayload({
        employee: comm,
        orgId: comm.orgId,
        binding,
        credentialInfo: {
          kind: "gb_emp",
          expiresAt: EXACT_7D,
          orgName: DEMO_ORG.name,
          now: NOW,
        },
      })
    );
    for (const needle of LEAK_NEEDLES) expect(dumped).not.toContain(needle);
    expect(dumped).not.toContain("cred_");
    expect(dumped).not.toMatch(/gb_emp_[A-Za-z0-9]/);
  });
});

describe("flag ON: callStaffpassMcpTool staffpass_whoami", () => {
  test("gb_emp_: credential.kind gb_emp, org.name is the caller tenant only", async () => {
    process.env[FLAG] = "1";
    getRuntimeEmployees().push({
      ...getRuntimeEmployees().find((e) => e.id === "emp_comm")!,
      id: OTHER_EMPLOYEE_ID,
      orgId: "org_other_whoami",
      displayName: OTHER_ORG_NAME,
    });
    const parsed = parseWhoami(await callStaffpassMcpTool("staffpass_whoami", {}, demoCred()));
    expect(parsed.credential).toEqual({ kind: "gb_emp", expiresAt: null });
    expect(parsed.org).toEqual({ name: DEMO_ORG.name });
    const dumped = JSON.stringify(parsed);
    for (const needle of LEAK_NEEDLES) expect(dumped).not.toContain(needle);
    expect(dumped).not.toContain("org_other_whoami");
    expect(parsed.employeeId).toBe("emp_comm");
    expect(parsed.orgId).toBe(DEMO_ORG.id);
  });

  test("OAuth: expiresAt is the 社員証 expiry when present; kind oauth", async () => {
    process.env[FLAG] = "1";
    const emp = getRuntimeEmployees().find((e) => e.id === "emp_comm")!;
    const soon = new Date(Date.now() + 6 * DAY_MS).toISOString();
    emp.credentialExpiresAt = soon;
    const parsed = parseWhoami(
      await callStaffpassMcpTool("staffpass_whoami", {}, demoCred("emp_comm", { authMethod: "oauth" }))
    );
    expect(parsed.credential).toEqual({ kind: "oauth", expiresAt: soon });
    expect(parsed.org).toEqual({ name: DEMO_ORG.name });
    expect(parsed.expiringSoon).toBe(true);
    expect(String(parsed.nextStepJa)).toMatch(
      /^社員証の期限が近づいています（\d{4}-\d{2}-\d{2} まで）。管理者に再発行を依頼してください。$/
    );
  });

  test("OAuth with no 社員証 expiry → expiresAt null, kind oauth", async () => {
    process.env[FLAG] = "1";
    const parsed = parseWhoami(
      await callStaffpassMcpTool("staffpass_whoami", {}, demoCred("emp_comm", { authMethod: "oauth" }))
    );
    expect(parsed.credential).toEqual({ kind: "oauth", expiresAt: null });
    expect(parsed.expiringSoon).toBeUndefined();
  });

  test("mismatch employee.orgId vs cred.orgId is fail-closed (no other-tenant name)", async () => {
    process.env[FLAG] = "1";
    const parsed = parseWhoami(
      await callStaffpassMcpTool("staffpass_whoami", {}, demoCred("emp_comm", { orgId: "org_other_whoami" }))
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe("employee_not_found");
    const dumped = JSON.stringify(parsed);
    expect(dumped).not.toContain(DEMO_ORG.name);
    expect(dumped).not.toContain(OTHER_ORG_NAME);
    expect(dumped).not.toContain("expiresAt");
  });
});
