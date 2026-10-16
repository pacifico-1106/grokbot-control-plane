/**
 * Fail-first: EMPLOYEE_RETIRE_ENABLED (default OFF) + retireEmployee.
 * Dashboard humans execute; already-revoked 社員証 is idempotent; other org is a no-op.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-retire";

const { isEmployeeRetireEnabled } = await import("@/lib/feature-flags");
const { getBinding } = await import("@/lib/bindings");
const { DEMO_ORG, getRuntimeEmployees, getRuntimeAudit } = await import("@/lib/demo-data");
const { getEmployee, terminateEmployee } = await import("@/lib/data/employees");
const { retireEmployee, EMPLOYEE_RETIRE_TOOL } = await import("@/lib/employees/retire");
const { resetDemoCommAccounts, createCommAccount, disableCommAccount, listCommAccounts } = await import("@/lib/comm/accounts");
const mcpStore = await import("@/lib/mcp-events/store");

const FLAG = "EMPLOYEE_RETIRE_ENABLED";
const SALES = "emp_sales";
let originalStatus: string;
let originalBinding: { status: string; lastError: string | null; grokBotAgentId: string | null } | null = null;
let savedFlag: string | undefined;
let savedComm: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  savedComm = process.env.COMM_ACCOUNTS_ENABLED;
  delete process.env[FLAG];
  process.env.COMM_ACCOUNTS_ENABLED = "true";
  const emp = getRuntimeEmployees().find((item) => item.id === SALES);
  originalStatus = emp?.status ?? "active";
  if (emp) emp.status = "active";
  const binding = getBinding(SALES);
  originalBinding = binding
    ? { status: binding.status, lastError: binding.lastError, grokBotAgentId: binding.grokBotAgentId }
    : null;
  resetDemoCommAccounts();
  mcpStore.__resetMcpEventsStoreForTests();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  if (savedComm === undefined) delete process.env.COMM_ACCOUNTS_ENABLED;
  else process.env.COMM_ACCOUNTS_ENABLED = savedComm;
  const emp = getRuntimeEmployees().find((item) => item.id === SALES);
  if (emp) emp.status = originalStatus as typeof emp.status;
  const binding = getBinding(SALES);
  if (binding && originalBinding) {
    binding.status = originalBinding.status as typeof binding.status;
    binding.lastError = originalBinding.lastError;
    binding.grokBotAgentId = originalBinding.grokBotAgentId;
  }
  resetDemoCommAccounts();
  mcpStore.__resetMcpEventsStoreForTests();
});

describe("EMPLOYEE_RETIRE_ENABLED", () => {
  test("default OFF", () => {
    delete process.env[FLAG];
    expect(isEmployeeRetireEnabled()).toBe(false);
  });
  test("on when true / 1 / on", () => {
    for (const v of ["true", "1", "on", "enabled"]) {
      process.env[FLAG] = v;
      expect(isEmployeeRetireEnabled()).toBe(true);
    }
  });
});

describe("retireEmployee demo", () => {
  test("tool name is employees.retire", () => {
    expect(EMPLOYEE_RETIRE_TOOL).toBe("employees.retire");
  });

  test("other-org retire is null and does not mutate emp_sales", async () => {
    const before = await getEmployee(SALES, DEMO_ORG.id);
    expect(await retireEmployee({ orgId: "org_other", employeeId: SALES, actorEmail: "owner@example.com" })).toBeNull();
    const after = await getEmployee(SALES, DEMO_ORG.id);
    expect(after?.status).toBe(before?.status);
    expect(after?.id).toBe(before?.id);
  });

  test("retires: status suspended, binding revoked, wake listener stopped, idempotent", async () => {
    const now = new Date().toISOString();
    await mcpStore.upsertEventSubscription({
      id: "sub_retire_sales",
      orgId: DEMO_ORG.id,
      employeeId: SALES,
      credentialId: null,
      credentialGeneration: 1,
      credentialFingerprint: "fp",
      principal: "p",
      eventName: "approval.decided",
      arguments: {},
      deliveryUrl: "https://example.com/hook",
      deliveryHost: "example.com",
      secretCiphertext: "x",
      secretFingerprint: "y",
      previousSecretCiphertext: null,
      previousSecretValidUntil: null,
      status: "active",
      risk: "standard",
      riskReasons: [],
      grantedTtlMs: 3_600_000,
      refreshBefore: new Date(Date.now() + 86_400_000).toISOString(),
      verifiedAt: now,
      lastDeliveryAt: null,
      lastError: null,
      failedSince: null,
      revokedReason: null,
      createdAt: now,
      updatedAt: now,
    });

    const first = await retireEmployee({
      orgId: DEMO_ORG.id,
      employeeId: SALES,
      actorEmail: "owner@example.com",
      reason: "契約終了",
    });
    expect(first).not.toBeNull();
    expect(first?.employee.status).toBe("suspended");
    expect(first?.employee.id).toBe(SALES);
    expect(getBinding(SALES)?.status).toBe("revoked");
    expect((await mcpStore.getEventSubscription("sub_retire_sales"))?.status).toBe("revoked");

    const audits = getRuntimeAudit().filter((a) => a.employeeId === SALES && a.action === "employee.terminated");
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.at(-1)?.metadata).toMatchObject({ actor: "human" });

    const again = await retireEmployee({
      orgId: DEMO_ORG.id,
      employeeId: SALES,
      actorEmail: "owner@example.com",
    });
    expect(again?.employee.status).toBe("suspended");
    expect(getBinding(SALES)?.status).toBe("revoked");
    expect((await mcpStore.getEventSubscription("sub_retire_sales"))?.status).toBe("revoked");
  });

  test("already-revoked credential / already-suspended employee is still a success (idempotent)", async () => {
    await terminateEmployee({ orgId: DEMO_ORG.id, employeeId: SALES });
    expect((await getEmployee(SALES, DEMO_ORG.id))?.status).toBe("suspended");
    const again = await retireEmployee({
      orgId: DEMO_ORG.id,
      employeeId: SALES,
      actorEmail: "owner@example.com",
    });
    expect(again?.employee.status).toBe("suspended");
    expect(again?.alreadyRetired).toBe(true);
  });

  test("disables this employee's comm account only (same org)", async () => {
    const own = await createCommAccount({
      orgId: DEMO_ORG.id,
      employeeId: SALES,
      surface: "line",
      externalAccountId: "U" + "a".repeat(32),
      createdByMemberId: "mem_1",
    });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const otherEmp = getRuntimeEmployees().find((item) => item.id === "emp_ops")!;
    const other = await createCommAccount({
      orgId: DEMO_ORG.id,
      employeeId: otherEmp.id,
      surface: "line",
      externalAccountId: "U" + "b".repeat(32),
      createdByMemberId: "mem_1",
    });
    expect(other.ok).toBe(true);
    await retireEmployee({ orgId: DEMO_ORG.id, employeeId: SALES, actorEmail: "owner@example.com" });
    const rows = await listCommAccounts(DEMO_ORG.id);
    expect(rows.find((r) => r.employeeId === SALES)?.status).toBe("disabled");
    expect(rows.find((r) => r.employeeId === otherEmp.id)?.status).not.toBe("disabled");
    if (other.ok) await disableCommAccount(DEMO_ORG.id, other.account.id);
  });
});
