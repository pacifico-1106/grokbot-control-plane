/**
 * S2 checkpoints (design ai-safety-5rules-design-20261012.md §2.3, 木村 10/12):
 * checkOperable (fail-stop, flag-independent), held tickets never execute,
 * G1 credential, G3 gateway entry, G4 post-approval execution (incl. W2 /
 * stuckWatch.retry), pre-send, MCP Events. Demo mode, no network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holds2";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const { rotateCredential, listAuditEvents } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { resolveEmployeeCredential } = await import("@/lib/auth/employee-credential");
const { assertExecutable } = await import("@/lib/data/bindings");
const { executeApproval } = await import("@/lib/approvals/execution");
const { assertApprovalExecutionAuthority } = await import("@/lib/approvals/execution-authority");
const { evaluateW2Eligibility } = await import("@/lib/stuck-watch/w2-unfulfilled");
const { postConversationMessage } = await import("@/lib/gateway/adapters/slack");
const { publishSnsPost } = await import("@/lib/gateway/adapters/sns");
const { checkSubscriptionPrincipal, __setPrincipalReaderForTests } = await import("@/lib/mcp-events/principal");
type ApprovalRequest = import("@/lib/types").ApprovalRequest;

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const HOLD_ID = "00000000-0000-4000-8000-0000000000h1".replace("h1", "a1");
const FLAG = "EMPLOYEE_HOLD_ENABLED";
let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env[FLAG];
  hold.__setHoldReaderForTests(null);
  hold.__resetHoldAuditThrottleForTests();
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = savedFlag;
  hold.__setHoldReaderForTests(null);
  hold.demoSetEmployeeHold(EMP, null);
  hold.demoSetOrgHold(ORG, null);
  __setPrincipalReaderForTests(null);
});

const throwingReader = { employee: async () => { throw new Error("db down"); }, org: async () => { throw new Error("db down"); } };
const stopEmp = () => hold.demoSetEmployeeHold(EMP, { kind: "stopped", holdId: HOLD_ID });

function approval(over: Partial<ApprovalRequest> = {}, metadata: Record<string, unknown> = {}): ApprovalRequest {
  return {
    id: `apr_hold_${Math.random().toString(36).slice(2)}`, orgId: ORG, employeeId: EMP, credentialId: "cred_sales",
    title: "t", purpose: "sales.outreach", summary: "s", risk: "low", status: "approved", tool: "slack.post",
    createdAt: new Date().toISOString(), resolvedAt: new Date(Date.now() - 3_600_000).toISOString(), resolvedBy: "mem_1",
    metadata, ...over,
  } as ApprovalRequest;
}

describe("checkOperable: fail-stop, both holds, no flag", () => {
  test("no hold → operable", async () => {
    expect(await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).toEqual({ ok: true });
  });
  test("employee hold → employee_on_hold (kind + holdId)", async () => {
    hold.demoSetEmployeeHold(EMP, { kind: "leave", holdId: HOLD_ID });
    expect(await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).toEqual({ ok: false, code: "employee_on_hold", holdId: HOLD_ID, kind: "leave" });
  });
  test("org hold → org_on_hold for an employee without its own hold, and for an org-only check", async () => {
    hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
    expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "wake" })).ok).toBe(false);
    const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "wake" });
    expect(r.ok === false && r.code).toBe("org_on_hold");
    const o = await hold.checkOperable({ orgId: ORG, phase: "approval_execution" });
    expect(o.ok === false && o.code).toBe("org_on_hold");
  });
  test("reader throws → hold_state_unavailable (stopped) and one audit row", async () => {
    hold.__setHoldReaderForTests(throwingReader);
    const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
    expect(r.ok === false && r.code).toBe("hold_state_unavailable");
    await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" });
    const rows = (await listAuditEvents(ORG)).filter((a) => a.action === "employee.hold.state_unavailable" && a.employeeId === EMP);
    expect(rows.length).toBe(1);
  });
  for (const [name, rd] of [
    ["read error", { employee: async () => ({ state: "error", detail: "x" }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
    ["employee row missing", { employee: async () => ({ state: "missing" }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
    ["org row missing", { employee: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }), org: async () => ({ state: "missing" }) }],
    ["unknown kind", { employee: async () => ({ state: "found", orgId: ORG, holdState: "paused", holdId: HOLD_ID }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
    ["state without id", { employee: async () => ({ state: "found", orgId: ORG, holdState: "stopped", holdId: null }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
    ["id without state", { employee: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: HOLD_ID }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
    ["org kind other than stopped", { employee: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }), org: async () => ({ state: "found", orgId: ORG, holdState: "leave", holdId: HOLD_ID }) }],
    ["employee of another org", { employee: async () => ({ state: "found", orgId: "org_other", holdState: null, holdId: null }), org: async () => ({ state: "found", orgId: ORG, holdState: null, holdId: null }) }],
  ] as const) {
    test(`${name} → hold_state_unavailable (stopped)`, async () => {
      hold.__setHoldReaderForTests(rd as unknown as import("@/lib/safety/hold").HoldReader);
      const r = await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" });
      expect(r.ok === false && r.code).toBe("hold_state_unavailable");
    });
  }
  test("no ids at all → stopped", async () => {
    const r = await hold.checkOperable({ phase: "gateway" });
    expect(r.ok).toBe(false);
  });
  for (const v of [undefined, "false", "0", "true"]) {
    test(`EMPLOYEE_HOLD_ENABLED=${v ?? "unset"}: the check still applies`, async () => {
      if (v === undefined) delete process.env[FLAG];
      else process.env[FLAG] = v;
      stopEmp();
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(false);
    });
  }
});

describe("must-have: a ticket a hold touched is never executed (木村 10/12)", () => {
  const marked: Array<[string, Record<string, unknown>]> = [
    ["heldByHoldId (during the hold)", { heldByHoldId: HOLD_ID }],
    ["closed_by_hold after release (no hold any more)", { heldByHoldId: HOLD_ID, holdOutcome: "closed_by_hold" }],
    ["holdOutcome only", { holdOutcome: "closed_by_hold" }],
    ["malformed heldByHoldId", { heldByHoldId: 42 }],
  ];
  for (const [name, md] of marked) {
    test(`executeApproval: ${name} → approval_held, nothing runs`, async () => {
      let ran = 0;
      await expect(executeApproval(approval({}, md), async () => { ran++; return { ok: true }; })).rejects.toThrow("approval_held");
      expect(ran).toBe(0);
    });
    test(`assertApprovalExecutionAuthority (G4, also W2 / stuckWatch.retry): ${name} → approval_held`, async () => {
      await expect(assertApprovalExecutionAuthority(approval({}, md))).rejects.toThrow("approval_held");
    });
    test(`W2 eligibility: ${name} → not eligible (approval_held), no retry spent`, () => {
      const r = evaluateW2Eligibility({ approval: approval({}, md), policy: { enabled: true, w2DelayMinutes: 0, w2MaxRetries: 3 } as never, now: new Date() });
      expect(r.eligible).toBe(false);
      expect(r.reason).toBe("approval_held");
    });
  }
  test("an unmarked ticket of a held employee is not executed either (G4)", async () => {
    stopEmp();
    let ran = 0;
    await expect(executeApproval(approval(), async () => { ran++; return { ok: true }; })).rejects.toThrow("employee_on_hold");
    expect(ran).toBe(0);
  });
  test("hold state unreadable at fulfil → not executed", async () => {
    hold.__setHoldReaderForTests(throwingReader);
    let ran = 0;
    await expect(executeApproval(approval(), async () => { ran++; return { ok: true }; })).rejects.toThrow("hold_state_unavailable");
    expect(ran).toBe(0);
  });
  test("org hold stops an admin-class ticket too (org-only check)", async () => {
    hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
    await expect(assertApprovalExecutionAuthority(approval({ tool: "policy.patch", employeeId: "adm_1" }, { adminTool: "policy.patch", auditClass: "admin" }))).rejects.toThrow("org_on_hold");
  });
  test("control: no hold, unmarked ticket → still runs", async () => {
    let ran = 0;
    const r = await executeApproval(approval(), async () => { ran++; return { ok: true }; });
    expect(r?.ok).toBe(true);
    expect(ran).toBe(1);
  });
});

describe("G1 credential, G3 gateway entry", () => {
  const SECRET = `gb_emp_holdtest_${"x".repeat(24)}`;
  const req = () => new Request("https://staffpass.test/api/mcp", { headers: { authorization: `Bearer ${SECRET}` } });
  beforeEach(async () => {
    await rotateCredential(EMP, ORG, fingerprintSecret(SECRET));
  });
  test("G1: valid badge → ok; held → employee_on_hold 403; org held → org_on_hold; unreadable → hold_state_unavailable", async () => {
    expect((await resolveEmployeeCredential(req())).ok).toBe(true);
    stopEmp();
    const r = await resolveEmployeeCredential(req());
    expect(r.ok === false && [r.code, r.httpStatus]).toEqual(["employee_on_hold", 403]);
    hold.demoSetEmployeeHold(EMP, null);
    hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
    const o = await resolveEmployeeCredential(req());
    expect(o.ok === false && o.code).toBe("org_on_hold");
    hold.demoSetOrgHold(ORG, null);
    hold.__setHoldReaderForTests(throwingReader);
    const u = await resolveEmployeeCredential(req());
    expect(u.ok === false && [u.code, u.httpStatus]).toEqual(["hold_state_unavailable", 503]);
  });
  test("G3: assertExecutable (the entry of every unauthenticated gateway call) refuses a held employee", async () => {
    expect((await assertExecutable(EMP)).ok).toBe(true);
    stopEmp();
    const r = await assertExecutable(EMP);
    expect(r.ok === false && r.code).toBe("employee_on_hold");
    hold.demoSetEmployeeHold(EMP, null);
    hold.__setHoldReaderForTests(throwingReader);
    const u = await assertExecutable(EMP);
    expect(u.ok === false && u.code).toBe("hold_state_unavailable");
  });
});

describe("right before an outbound send", () => {
  test("Slack post: held → not_sent employee_on_hold (nothing posted)", async () => {
    stopEmp();
    const r = await postConversationMessage({ orgId: ORG, employeeId: EMP, channel: "C123", text: "hi" });
    expect(r).toMatchObject({ ok: false, error: "employee_on_hold", sendState: "not_sent" });
  });
  test("Slack post: no hold → the demo stub still answers", async () => {
    const r = await postConversationMessage({ orgId: ORG, employeeId: EMP, channel: "C123", text: "hi" });
    expect(r.ok).toBe(true);
  });
  test("SNS publish: org held → not_sent", async () => {
    hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID });
    const r = await publishSnsPost({ orgId: ORG, employeeId: EMP, surface: "x", text: "hi" });
    expect(r.ok).toBe(false);
    expect((r as { sendState?: string }).sendState).toBe("not_sent");
  });
});

describe("MCP Events: delivery stops, the subscription is not revoked", () => {
  const sub = { orgId: ORG, employeeId: EMP, credentialGeneration: 1, credentialFingerprint: "fp", credentialId: null };
  const reader = {
    binding: async () => ({ state: "found" as const, value: { orgId: ORG, status: "linked", credentialGeneration: 1, credentialFingerprint: "fp" } }),
    employee: async () => ({ state: "found" as const, value: { orgId: ORG, status: "active" } }),
    credential: async () => ({ state: "missing" as const }),
  };
  test("held → kind held (not revoked); unreadable → unavailable (defer, nothing sent)", async () => {
    __setPrincipalReaderForTests(reader);
    expect(await checkSubscriptionPrincipal(sub, Date.now())).toEqual({ ok: true });
    stopEmp();
    const r = await checkSubscriptionPrincipal(sub, Date.now());
    expect(r.ok === false && r.kind).toBe("held");
    hold.demoSetEmployeeHold(EMP, null);
    hold.__setHoldReaderForTests(throwingReader);
    const u = await checkSubscriptionPrincipal(sub, Date.now());
    expect(u.ok === false && u.kind).toBe("unavailable");
  });
});

// Design §9: route × reason × state. Every cell is refused with the right code, nothing
// reaches an adapter, and the badge is still valid afterwards (release restores access).
describe("§9 matrix: route × kind × state", () => {
  const SECRET = `gb_emp_holdmatrix_${"y".repeat(24)}`;
  const req = () => new Request("https://staffpass.test/api/mcp", { headers: { authorization: `Bearer ${SECRET}` } });
  const sub = { orgId: ORG, employeeId: EMP, credentialGeneration: 1, credentialFingerprint: "fp", credentialId: null };
  beforeEach(async () => {
    await rotateCredential(EMP, ORG, fingerprintSecret(SECRET));
    __setPrincipalReaderForTests({
      binding: async () => ({ state: "found" as const, value: { orgId: ORG, status: "linked", credentialGeneration: 1, credentialFingerprint: "fp" } }),
      employee: async () => ({ state: "found" as const, value: { orgId: ORG, status: "active" } }),
      credential: async () => ({ state: "missing" as const }),
    } as never);
  });
  const routes: Array<[string, () => Promise<string | null>]> = [
    ["G1 社員証", async () => { const r = await resolveEmployeeCredential(req()); return r.ok ? null : r.code; }],
    ["G3 gateway", async () => { const r = await assertExecutable(EMP); return r.ok ? null : r.code; }],
    ["G4 fulfil", async () => { let ran = 0; try { await executeApproval(approval(), async () => { ran++; return { ok: true }; }); } catch (e) { expect(ran).toBe(0); return (e as Error).message; } return null; }],
    ["W2 retry", async () => { try { await assertApprovalExecutionAuthority(approval()); } catch (e) { return (e as Error).message; } return null; }],
    ["pre-send Slack", async () => { const r = await postConversationMessage({ orgId: ORG, employeeId: EMP, channel: "C1", text: "x" }); return r.ok ? null : String(r.error); }],
    ["MCP Events", async () => { const r = await checkSubscriptionPrincipal(sub, Date.now()); return r.ok ? null : r.kind === "held" ? r.reason : r.kind === "unavailable" ? "hold_state_unavailable" : r.kind; }],
  ];
  const states: Array<[string, (kind: "stopped" | "quarantined" | "leave") => void, string]> = [
    ["employee hold", (kind) => hold.demoSetEmployeeHold(EMP, { kind, holdId: HOLD_ID }), "employee_on_hold"],
    ["org hold", () => hold.demoSetOrgHold(ORG, { kind: "stopped", holdId: HOLD_ID }), "org_on_hold"],
    ["unreadable", () => hold.__setHoldReaderForTests(throwingReader), "hold_state_unavailable"],
  ];
  for (const [route, call] of routes) {
    for (const kind of ["stopped", "quarantined", "leave"] as const) {
      for (const [state, set, code] of states) {
        if (state !== "employee hold" && kind !== "stopped") continue; // org / unreadable have no kind
        test(`${route} × ${kind} × ${state} → ${code}`, async () => {
          set(kind);
          const got = await call();
          expect(got === code || (route.startsWith("G4") || route.startsWith("W2") ? got?.includes(code) : false)).toBe(true);
          // release → back to normal, nothing revoked meanwhile
          hold.demoSetEmployeeHold(EMP, null);
          hold.demoSetOrgHold(ORG, null);
          hold.__setHoldReaderForTests(null);
          expect((await resolveEmployeeCredential(req())).ok).toBe(true);
        });
      }
    }
  }
});
