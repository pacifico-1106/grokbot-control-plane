/**
 * The two §9 tests deferred from S2 (design §9):
 * (1) adapter-delay race — a stop that lands while the call is in flight (after G1/G3,
 *     before the adapter sends) is caught just before sending: nothing goes out;
 * (2) screen → stop → 403 → release request → approve (other person, fresh login) → 200,
 *     end to end through the real routes (web stop / release, /api/mcp with a 社員証).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

process.env.NOTIFICATION_CONFIG_ENCRYPTION_KEY = "test-notification-key-0123456789abcdef-holds3e";

const { DEMO_ORG } = await import("@/lib/demo-data");
const hold = await import("@/lib/safety/hold");
const store = await import("@/lib/safety/hold-store");
const notify = await import("@/lib/safety/hold-notify");
const { startHold } = await import("@/lib/safety/hold-actions");
const { rotateCredential } = await import("@/lib/data");
const { fingerprintSecret } = await import("@/lib/bindings");
const { postConversationMessage } = await import("@/lib/gateway/adapters/slack");
const { writeDesignatedAdminMemberIds } = await import("@/lib/approver-authority/designated-admins");
const { getRuntimeMemberById } = await import("@/lib/demo-data");

const ORG = DEMO_ORG.id;
const EMP = "emp_sales";
const SECRET = `gb_emp_holde2e_${"y".repeat(24)}`;
let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.EMPLOYEE_HOLD_ENABLED;
  process.env.EMPLOYEE_HOLD_ENABLED = "true";
  notify.__setHoldNotifierForTests({ tenant: async () => undefined, ops: async () => undefined });
  store.__resetDemoHoldsForTests();
  hold.__setHoldReaderForTests(null);
  await writeDesignatedAdminMemberIds(ORG, ["mem_2"]);
  await rotateCredential(EMP, ORG, fingerprintSecret(SECRET));
});
afterEach(async () => {
  if (saved === undefined) delete process.env.EMPLOYEE_HOLD_ENABLED; else process.env.EMPLOYEE_HOLD_ENABLED = saved;
  notify.__setHoldNotifierForTests(null);
  store.__resetDemoHoldsForTests();
  await writeDesignatedAdminMemberIds(ORG, []);
});

describe("§9 (1) adapter-delay race", () => {
  test("stop lands after G1 + G3 passed, while the adapter is about to send → not_sent, nothing posted", async () => {
    await hold.withHoldCallScope(async () => {
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "credential" })).ok).toBe(true);
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(true);
      // ── the request is now "in the adapter" (slow network); a human presses 緊急停止 ──
      const stop = await startHold({ orgId: ORG, employeeId: EMP, actor: { type: "member", member: getRuntimeMemberById("mem_1")!, surface: "slack" } });
      expect(stop.ok).toBe(true);
      const r = await postConversationMessage({ orgId: ORG, employeeId: EMP, channel: "C123", text: "hi" });
      expect(r).toMatchObject({ ok: false, error: "employee_on_hold", sendState: "not_sent" });
    });
  });
  test("control: with no stop in between, the same in-flight send goes out (demo stub)", async () => {
    await hold.withHoldCallScope(async () => {
      expect((await hold.checkOperable({ orgId: ORG, employeeId: EMP, phase: "gateway" })).ok).toBe(true);
      expect((await postConversationMessage({ orgId: ORG, employeeId: EMP, channel: "C123", text: "hi" })).ok).toBe(true);
    });
  });
});

describe("§9 (2) screen → stop → 403 → release → 200", () => {
  const mcp = async () => {
    const { POST } = await import("@/app/api/mcp/route");
    return POST(new Request("http://localhost/api/mcp", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
  };
  const web = async (path: string, member: string, body: Record<string, unknown>) => {
    const mod = await import(path);
    const res: Response = await mod.POST(new Request("http://localhost/x", {
      method: "POST", headers: { "content-type": "application/json", "x-member-id": member }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  test("end to end", async () => {
    expect((await mcp()).status).toBe(200);
    const stop = await web("@/app/api/holds/stop/route", "mem_1", { employeeId: EMP, reason: "様子がおかしい" });
    expect(stop.status).toBe(200);
    const held = await mcp();
    expect(held.status).toBe(403);
    expect(JSON.stringify(await held.json())).toContain("employee_on_hold");
    const holdId = String(stop.body.holdId);
    const reqd = await web("@/app/api/holds/release/request/route", "mem_2", { holdId, reason: "確認済み" });
    expect(reqd.status).toBe(200);
    // the requester cannot approve their own request
    expect((await web("@/app/api/holds/release/approve/route", "mem_2", { holdId })).status).toBe(403);
    expect((await mcp()).status).toBe(403);
    const ok = await web("@/app/api/holds/release/approve/route", "mem_1", { holdId });
    expect(ok.status).toBe(200);
    expect((await mcp()).status).toBe(200);
  });
});
